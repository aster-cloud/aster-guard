// aster-guard-mcp 的 MCP 服务器（ADR 0040 §6、ADR 0054 §2.2）。
// 有上游：每一次 tools/call 经 GuardClient.run 按固定顺序「哈希 → 决策 → 验签 → consume → 转发 → 回写」执行，
// 任一步失败不转发；DENY / PENDING / 阻断返回结构化载荷（guard-result.ts）。
// 无上游：只提供五个治理工具（standalone-tools.ts）。两种模式共用同一个低层 Server，上游工具 schema 原样透传。
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Progress,
  type ProgressToken,
  type ServerNotification,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { GuardClient } from '../client.js';
import { JcsError, jcsSha256 } from '../hash/jcs.js';
import { VERSION } from '../index.js';
import { BEFORE_CONSUME } from '../internal/hooks.js';
import type { GuardGrant, GuardPrincipal, GuardRunOptions } from '../types.js';
import { CONSUME_TICKET_META_KEY } from '../tool/consume-ticket.js';
import { buildToolAction, canonicalArgs, envelopeOf, type ActionMapping } from './action-mapping.js';
import { blockedResult, pendingResult, refusedResult, unavailableResult, withGuardMeta } from './guard-result.js';
import { callGovernanceTool, GOVERNANCE_TOOLS } from './standalone-tools.js';

/** 缺省的人工审批等待时长（§6：`--approval-timeout` 缺省 300 秒）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/**
 * 缺省的上游请求超时（`--upstream-timeout` 缺省 600 秒）。不设的话 SDK 用 60 秒：耗时长的上游工具在 guard
 * 已放行后被代理掐断，上游却仍在执行，宿主重试就会在新的决策下重复副作用。
 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;

/** setTimeout 能表示的最大毫秒数；超过时 Node 会把计时器改成 1 ms，每次上游调用都会立刻超时。 */
const MAX_TIMER_MS = 2_147_483_647;

/** 刷新上游工具名时最多翻的页数：防止上游游标永不结束时无限翻页。 */
const MAX_TOOL_LIST_PAGES = 100;

/** 代理用到的 GuardClient 方法（便于注入 mock）。 */
export type GuardClientLike = Pick<
  GuardClient,
  'check' | 'get' | 'waitFor' | 'listApprovals' | 'approve' | 'reject' | 'run' | 'consume' | 'reportResult' | 'verifyReceipt' | 'keys'
>;

/**
 * 代理用到的上游 Client 方法；代理接管其生命周期，close() 时一并关闭。
 * `ready` 可选：给出且为 false 时 tools/call 在裁决之前即以 `upstream_unavailable` 拒绝（监听模式的重连监督，
 * upstream-supervisor.ts）；缺省视为总是就绪（直接传入的 Client）。
 */
export type UpstreamClient = Pick<Client, 'listTools' | 'callTool' | 'close'> & { ready?(): boolean };

/** 原始工具端点的隔离方式（ADR 0054 §3.1–§3.3、§12 D1）。 */
export type Isolation = 'network' | 'auth';

export interface GuardProxyOptions {
  client: GuardClientLike;
  /** 被包裹的上游 MCP 服务器（已连接）；缺省为治理工具模式。 */
  upstream?: UpstreamClient;
  /** 发起主体，来自配置；工具参数不能改写。 */
  principal: GuardPrincipal;
  /** PENDING 时等待人工审批的最长毫秒数，缺省 300000；须 ≥ 0。 */
  approvalTimeoutMs?: number;
  /**
   * 对上游 tools/call 与 tools/list 的请求超时毫秒数，缺省 600000；须为 1–2147483647 的数。
   * 上游每报告一次 progress 计时重新开始。
   */
  upstreamTimeoutMs?: number;
  /** 取该工具参数的值作为 `resource: { type: 'arg', id }`。 */
  resourceFromArg?: string;
  /** 写入 `action.agent.model`。 */
  agentModel?: string;
  /** 对账用执行方标识；缺省由 GuardClient.run 取 `aster-guard-sdk@<hostname>`，CLI 传 `aster-guard-mcp@<hostname>`。 */
  executorId?: string;
  /** 隔离方式（单值或列表）；含 `auth` 时转发请求附 consume 票据。 */
  isolation?: Isolation | readonly Isolation[];
  /** 工具白名单；缺省全部上游工具。 */
  tools?: string[];
  /** 按工具的 action 映射。 */
  actions?: Record<string, ActionMapping>;
  /**
   * 上游工具名缓存；缺省每个代理实例自建。监听模式每个请求新建一个代理实例，共享同一缓存，
   * 避免每次 tools/call 都向上游刷新 tools/list。
   */
  toolNames?: ToolNameCache;
  /** 仅测试：consume 之前调用，入参为将被转发的参数对象（绕过套件 #3）。CLI 不暴露。 */
  __beforeConsume?: (args: Record<string, unknown>) => void;
}

/** 缺省值已落定的选项。 */
type ResolvedOptions = GuardProxyOptions & { approvalTimeoutMs: number; upstreamTimeoutMs: number };

export interface GuardProxy {
  server: Server;
  /** 关闭对下游的服务器连接与上游连接。 */
  close(): Promise<void>;
}

export function createGuardProxyServer(options: GuardProxyOptions): GuardProxy {
  const {
    upstream,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  } = options;
  // !(x >= 0) 同时拦下 NaN 与负数；与 GuardClient.waitFor 的约束一致，在构造时而不是首次 PENDING 时暴露。
  if (typeof approvalTimeoutMs !== 'number' || !(approvalTimeoutMs >= 0)) {
    throw new TypeError('createGuardProxyServer: approvalTimeoutMs 须为 ≥ 0 的数');
  }
  if (typeof upstreamTimeoutMs !== 'number' || !(upstreamTimeoutMs >= 1 && upstreamTimeoutMs <= MAX_TIMER_MS)) {
    throw new TypeError(`createGuardProxyServer: upstreamTimeoutMs 须为 1–${MAX_TIMER_MS} 的数`);
  }
  const server = new Server({ name: 'aster-guard-mcp', version: VERSION }, { capabilities: { tools: {} } });
  if (upstream) {
    installGuardedUpstream(server, upstream, { ...options, approvalTimeoutMs, upstreamTimeoutMs });
  } else {
    installGovernanceTools(server, options);
  }
  return {
    server,
    async close() {
      try {
        await server.close();
      } finally {
        await upstream?.close();
      }
    },
  };
}

function installGovernanceTools(server: Server, options: GuardProxyOptions): void {
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: GOVERNANCE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callGovernanceTool(request.params.name, request.params.arguments, options),
  );
}

function installGuardedUpstream(server: Server, upstream: UpstreamClient, options: ResolvedOptions): void {
  const timeout = options.upstreamTimeoutMs;
  const allow = options.tools === undefined ? undefined : new Set(options.tools);
  const knownTools = options.toolNames ?? createToolNameCache(upstream, timeout);
  const exposed = (tool: Tool) => allow === undefined || allow.has(tool.name);

  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await upstream.listTools(request.params, { signal: extra.signal, timeout });
    knownTools.remember(result.tools);
    return { ...result, tools: result.tools.filter(exposed) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const allowed = allow === undefined || allow.has(name);
    // 上游未就绪：不裁决、不转发。工具定义未知时不放 structuredContent（无从得知它是否声明了 outputSchema）。
    if (allowed && upstream.ready?.() === false) {
      const cached = knownTools.peek?.(name);
      return unavailableResult(cached === undefined || cached.outputSchema !== undefined);
    }
    const tool = allowed ? await knownTools.get(name) : undefined;
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const hasOutputSchema = tool.outputSchema !== undefined;
    let args: Record<string, unknown>;
    try {
      args = canonicalArgs(request.params.arguments);
    } catch (e) {
      if (!(e instanceof JcsError)) throw e;
      return blockedResult(clientBlocked(`参数无法按 jcs-sha256/v1 规范化（${e.code}）：${e.message}`), hasOutputSchema);
    }
    const mapping = options.actions?.[name];
    const action = buildToolAction({
      toolName: name,
      args,
      mapping,
      defaultResourceFrom: options.resourceFromArg,
      principal: options.principal,
      agentModel: options.agentModel,
    });
    const forward = (grant: GuardGrant) =>
      upstream.callTool(
        {
          name,
          arguments: args,
          ...(isolations(options).includes('auth')
            ? { _meta: { [CONSUME_TICKET_META_KEY]: { decisionId: grant.decisionId, attemptId: grant.attemptId, envelope: envelopeOf(action) } } }
            : {}),
        },
        undefined,
        {
          signal: extra.signal,
          timeout,
          resetTimeoutOnProgress: true,
          onprogress: relayProgress(server, request.params._meta?.progressToken, extra.sendNotification),
        },
      ) as Promise<CallToolResult>;
    const runOptions: GuardRunOptions<CallToolResult> & { [BEFORE_CONSUME]?: () => void } = {
      approvalTimeoutMs: options.approvalTimeoutMs,
      signal: extra.signal,
      classify: classifyUpstream,
      ...(options.executorId === undefined ? {} : { executorId: options.executorId }),
      ...(options.__beforeConsume ? { [BEFORE_CONSUME]: () => options.__beforeConsume?.(args) } : {}),
    };
    let grant: GuardGrant | undefined;
    const outcome = await options.client.run(
      action,
      (g) => {
        grant = g;
        return forward(g);
      },
      runOptions,
    );
    switch (outcome.kind) {
      case 'executed':
        return withGuardMeta(outcome.result, grant ?? outcome);
      case 'pending':
        return pendingResult(outcome.decision, hasOutputSchema);
      case 'blocked':
        return refusedResult(outcome.decision, hasOutputSchema);
      case 'failed':
        // 上游协议错误 / 超时：已回写 failed，原样抛给下游（协议错误而不是成功结果）。
        throw outcome.error;
    }
  });
}

/** 把单值或列表形式的 isolation 统一为列表。 */
function isolations(options: GuardProxyOptions): readonly Isolation[] {
  const { isolation } = options;
  if (isolation === undefined) return [];
  return typeof isolation === 'string' ? [isolation] : isolation;
}

/** 上游结果归类：isError → failed；resultHash 为 content 的 jcs-sha256/v1（无法规范化时省略）。 */
function classifyUpstream(result: CallToolResult): { status: 'executed' | 'failed'; errorCode?: string; resultHash?: string } {
  let resultHash: string | undefined;
  try {
    resultHash = jcsSha256(result.content);
  } catch {
    resultHash = undefined;
  }
  return result.isError ? { status: 'failed', errorCode: 'tool_error', resultHash } : { status: 'executed', resultHash };
}

function clientBlocked(reason: string) {
  return { decisionId: '', outcome: 'DENY' as const, effectiveOutcome: 'DENY' as const, reasonCode: 'client_error', reason };
}

/**
 * 上游 progress 的处理函数。总是登记：SDK 只有登记了 onprogress 才会向上游申请 progress，
 * resetTimeoutOnProgress 也才生效。下游请求带了 progressToken 时，以该 token 原样转发给下游，否则丢弃。
 * 经 extra.sendNotification 发送（即带上 relatedRequestId 的 server.notification），下游请求已取消时 SDK 自动不发。
 */
function relayProgress(
  server: Server,
  progressToken: ProgressToken | undefined,
  send: (notification: ServerNotification) => Promise<void>,
): (progress: Progress) => void {
  return ({ progress, total, message }) => {
    if (progressToken === undefined) return;
    // progress 只是提示：发送失败（如下游已断开）不影响这次调用，交给 onerror 记录即可。
    send({ method: 'notifications/progress', params: { progressToken, progress, total, message } }).catch((e: unknown) =>
      server.onerror?.(e instanceof Error ? e : new Error(String(e))),
    );
  };
}

/** 上游工具名缓存：记下 tools/list 的结果，按名取工具定义（未知为 undefined）。 */
export interface ToolNameCache {
  remember(tools: Tool[]): void;
  get(name: string): Promise<Tool | undefined>;
  /** 只查缓存、不访问上游；未缓存为 undefined。 */
  peek?(name: string): Tool | undefined;
}

/** 新建上游工具名缓存；timeoutMs 为刷新 tools/list 的请求超时。 */
export function createToolNameCache(upstream: Pick<UpstreamClient, 'listTools'>, timeoutMs: number): ToolNameCache {
  return new UpstreamToolNames(upstream, timeoutMs);
}

/**
 * 上游工具名缓存，用于拒绝未知工具。tools/list 转发时与完整刷新时都会记下工具名；命中缓存不访问上游。
 * 未命中时（客户端可能不先 tools/list 就调用，上游工具集也可能已变化）每次调用至多做一次完整刷新，
 * 并发的未命中共享同一次刷新。
 */
class UpstreamToolNames implements ToolNameCache {
  private readonly names = new Map<string, Tool>();
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly upstream: Pick<UpstreamClient, 'listTools'>,
    private readonly timeout: number,
  ) {}

  remember(tools: Tool[]): void {
    for (const tool of tools) this.names.set(tool.name, tool);
  }

  peek(name: string): Tool | undefined {
    return this.names.get(name);
  }

  /** 取工具定义（含 outputSchema）；未知工具为 undefined。 */
  async get(name: string): Promise<Tool | undefined> {
    const cached = this.names.get(name);
    if (cached) return cached;
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
    await this.refreshing;
    return this.names.get(name);
  }

  /** 翻完上游全部分页；游标重复或超过 MAX_TOOL_LIST_PAGES 页即停止，已收集的工具名照常生效。 */
  private async refresh(): Promise<void> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const result = await this.upstream.listTools(cursor === undefined ? undefined : { cursor }, { timeout: this.timeout });
      this.remember(result.tools);
      cursor = result.nextCursor;
      if (cursor === undefined || seen.has(cursor)) return;
      seen.add(cursor);
    }
  }
}
