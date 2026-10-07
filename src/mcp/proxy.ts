// aster-guard-mcp 的 MCP 服务器（ADR 0040 §6）。
// 有上游：原样转发 tools/list，拦截每一次 tools/call 先过 guard，只有服务端确认的 ALLOW 才转发；
// 无上游：只提供五个治理工具（standalone-tools.ts）。两种模式共用同一个低层 Server，上游工具 schema 原样透传。
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { GuardClient } from '../client.js';
import { VERSION } from '../index.js';
import type { GuardAction, GuardDecision, GuardPrincipal } from '../types.js';
import { callGovernanceTool, GOVERNANCE_TOOLS } from './standalone-tools.js';

/** 缺省的人工审批等待时长（§6：`--approval-timeout` 缺省 300 秒）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/** 代理用到的 GuardClient 方法（便于注入 mock）。 */
export type GuardClientLike = Pick<GuardClient, 'check' | 'get' | 'waitFor' | 'listApprovals' | 'approve' | 'reject'>;

/** 代理用到的上游 Client 方法；代理接管其生命周期，close() 时一并关闭。 */
export type UpstreamClient = Pick<Client, 'listTools' | 'callTool' | 'close'>;

export interface GuardProxyOptions {
  client: GuardClientLike;
  /** 被包裹的上游 MCP 服务器（已连接）；缺省为治理工具模式。 */
  upstream?: UpstreamClient;
  /** 发起主体，来自配置；工具参数不能改写。 */
  principal: GuardPrincipal;
  /** PENDING 时等待人工审批的最长毫秒数，缺省 300000；须 ≥ 0。 */
  approvalTimeoutMs?: number;
  /** 取该工具参数的值作为 `resource: { type: 'arg', id }`。 */
  resourceFromArg?: string;
  /** 写入 `action.agent.model`。 */
  agentModel?: string;
}

/** 缺省值已落定的选项。 */
type ResolvedOptions = GuardProxyOptions & { approvalTimeoutMs: number };

export interface GuardProxy {
  server: Server;
  /** 关闭对下游的服务器连接与上游连接。 */
  close(): Promise<void>;
}

export function createGuardProxyServer(options: GuardProxyOptions): GuardProxy {
  const { upstream, approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS } = options;
  // !(x >= 0) 同时拦下 NaN 与负数；与 GuardClient.waitFor 的约束一致，在构造时而不是首次 PENDING 时暴露。
  if (typeof approvalTimeoutMs !== 'number' || !(approvalTimeoutMs >= 0)) {
    throw new TypeError('createGuardProxyServer: approvalTimeoutMs 须为 ≥ 0 的数');
  }
  const server = new Server({ name: 'aster-guard-mcp', version: VERSION }, { capabilities: { tools: {} } });
  if (upstream) {
    installGuardedUpstream(server, upstream, { ...options, approvalTimeoutMs });
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
  const knownTools = new UpstreamToolNames(upstream);

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await upstream.listTools(request.params);
    knownTools.remember(result.tools);
    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    if (!(await knownTools.has(name))) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const decision = await decide(options, toAction(options, name, args));
    // 下游已取消（例如客户端等审批等到超时）时，结论来得再晚也不执行副作用——调用方已放弃，
    // 执行了它也不知道，重试就会重复执行；SDK 也不会再发送这次响应。
    if (!isConfirmedAllow(decision) || extra.signal.aborted) {
      return blocked(decision);
    }
    // 传入 signal：转发期间下游取消时，把取消传给上游。
    return upstream.callTool({ name, arguments: args }, undefined, { signal: extra.signal });
  });
}

/**
 * 上游工具名集合，用于拒绝未知工具。tools/list 转发时顺带记下；遇到没见过的名字时翻完上游全部分页再判定
 * （客户端可能不先 tools/list 就调用，上游工具集也可能已变化）。
 */
class UpstreamToolNames {
  private readonly names = new Set<string>();

  constructor(private readonly upstream: UpstreamClient) {}

  remember(tools: Tool[]): void {
    for (const tool of tools) this.names.add(tool.name);
  }

  async has(name: string): Promise<boolean> {
    if (this.names.has(name)) return true;
    let cursor: string | undefined;
    do {
      const page = await this.upstream.listTools(cursor === undefined ? undefined : { cursor });
      this.remember(page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return this.names.has(name);
  }
}

/** 由一次 tools/call 构造 Action：action.name 为工具名，context 为工具参数（§6）。 */
function toAction(options: GuardProxyOptions, name: string, args: Record<string, unknown> | undefined): GuardAction {
  const { principal, resourceFromArg, agentModel } = options;
  const resourceId = resourceFromArg === undefined ? undefined : args?.[resourceFromArg];
  return {
    principal,
    action: { name },
    resource: resourceId == null ? undefined : { type: 'arg', id: String(resourceId) },
    context: args ?? {},
    agent: agentModel ? { model: agentModel } : undefined,
  };
}

/**
 * 取得最终结论：check；PENDING 则 waitFor 到 approvalTimeoutMs。
 *
 * 每次 tools/call 用新的 UUID 作幂等键：键只代表这一次动作尝试，绝不从 JSON-RPC 请求 id 派生——
 * 后者在重连或换会话后会重复，让不同动作撞键（§6）。GuardClient 约定不抛异常；注入的实现若抛出，
 * 同样按 fail-closed 处理为 DENY。
 */
async function decide(options: ResolvedOptions, action: GuardAction): Promise<GuardDecision> {
  const { client, approvalTimeoutMs } = options;
  try {
    const decision = await client.check(action, { idempotencyKey: randomUUID() });
    if (decision.effectiveOutcome !== 'PENDING') return decision;
    return await client.waitFor(decision.decisionId, { timeoutMs: approvalTimeoutMs });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { decisionId: '', outcome: 'DENY', effectiveOutcome: 'DENY', reasonCode: 'client_error', reason };
  }
}

/**
 * 只有服务端确认的 ALLOW 才放行：客户端 fail-closed 产生的结论（guard 不可达、超时、非 2xx）
 * decisionId 为空串，即使 effectiveOutcome 被误标为 ALLOW 也不转发。
 */
function isConfirmedAllow(decision: GuardDecision): boolean {
  return decision.effectiveOutcome === 'ALLOW' && decision.decisionId !== '';
}

function blocked(decision: GuardDecision): CallToolResult {
  const why = decision.reason || decision.reasonCode || `effectiveOutcome ${decision.effectiveOutcome}`;
  return {
    isError: true,
    content: [{ type: 'text', text: `Blocked by Aster Guard: ${why} (decision ${decision.decisionId || 'n/a'})` }],
  };
}
