// 演示 HTTP MCP 工具（aster-api ADR 0054 §12 D6）：两个工具 demo_echo / demo_delete，每次执行写一条副作用记录。
// TICKET_CHECK=on（缺省）时，每个 tools/call 在交给 MCP 之前用工具**自己的** Guard key 核对 consume 票据
// （@aster-cloud/aster-guard/tool 的 verifyConsumeTicket），核对与执行使用同一个已解析的请求体对象。
// TICKET_CHECK=off 只用于红队副本（redteam-window.sh），生产清单不得出现。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { GuardClient } from '@aster-cloud/aster-guard';
import { MemoryAttemptLedger, verifyConsumeTicket } from '@aster-cloud/aster-guard/tool';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EffectLog } from './effects.js';

/** 请求体上限。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** TICKET_CHECK=off 时重复告警的间隔。 */
const INSECURE_WARN_INTERVAL_MS = 60_000;

const TOOLS = [
  {
    name: 'demo_echo',
    description: '回显 message（演示用的 ALLOW 工具）',
    inputSchema: { type: 'object' as const, properties: { message: { type: 'string' } }, required: ['message'] },
  },
  {
    name: 'demo_delete',
    description: '「删除」id（演示用的 DENY 工具；经代理时应被策略拒绝）',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

/** 启动配置错误（入口以 2 退出）。 */
export class DemoToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoToolConfigError';
  }
}

export interface DemoToolDeps {
  /** 注入给工具的 GuardClient（测试用假 aster-api）。 */
  fetch?: typeof fetch;
  /** 日志输出，缺省写 stderr。 */
  log?: (message: string) => void;
}

export interface DemoTool {
  url: URL;
  close(): Promise<void>;
}

/** 核对通过的票据；TICKET_CHECK=off 时为 null。 */
type Ticket = { decisionId: string; attemptId: string } | null;

type Check = (params: Record<string, unknown>) => Promise<{ ok: true; ticket: Ticket } | { ok: false; reason: string }>;

/** 由环境变量构造票据核对；TICKET_CHECK=on 时三个 Guard 变量与策略缺一即 DemoToolConfigError。 */
function ticketCheck(env: NodeJS.ProcessEnv, deps: DemoToolDeps): { mode: 'on' | 'off'; check: Check } {
  const mode = env.TICKET_CHECK ?? 'on';
  if (mode === 'off') return { mode, check: async () => ({ ok: true, ticket: null }) };
  if (mode !== 'on') throw new DemoToolConfigError(`TICKET_CHECK 须为 on 或 off：${mode}`);
  const missing = ['ASTER_API_BASE_URL', 'ASTER_GUARD_TOOL_API_KEY', 'ASTER_GUARD_TENANT_ID', 'ASTER_GUARD_POLICY'].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) throw new DemoToolConfigError(`TICKET_CHECK=on 缺少环境变量：${missing.join(', ')}`);
  const policy = /^([^/\s]+)\/([^/\s]+)$/.exec(env.ASTER_GUARD_POLICY!.trim());
  if (!policy) throw new DemoToolConfigError('ASTER_GUARD_POLICY 须为 <module>/<function>');
  const client = new GuardClient({
    baseUrl: env.ASTER_API_BASE_URL!.trim(),
    apiKey: env.ASTER_GUARD_TOOL_API_KEY!.trim(),
    tenantId: env.ASTER_GUARD_TENANT_ID!.trim(),
    policyModule: policy[1],
    policyFunction: policy[2],
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  // 单副本 + Recreate：进程内账本即可（ADR 0054 §11 D11；重启后 ttl 内同一票据至多再放行一次，见 README）。
  const ledger = new MemoryAttemptLedger();
  return {
    mode,
    check: async (params) => {
      const args = params.arguments;
      const verdict = await verifyConsumeTicket({
        meta: params._meta,
        args: isRecord(args) ? args : undefined,
        toolName: typeof params.name === 'string' ? params.name : '',
        policy: { module: policy[1], function: policy[2] },
        client,
        ledger,
      });
      return verdict.ok ? { ok: true, ticket: { decisionId: verdict.decisionId, attemptId: verdict.attemptId } } : verdict;
    },
  };
}

/**
 * 为一个已核对的请求构造 MCP 服务器：工具处理函数只在 tools/call 上运行，ticket 是这一请求核对通过的结果。
 * 每个请求只含一条消息（批量已拒绝），所以闭包里的 ticket 就是这一次调用的核对结论。
 */
function toolServer(effects: EffectLog, ticket: Ticket | undefined): Server {
  const server = new Server({ name: 'aster-guard-demo-tool', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    // 防御：tools/call 必经核对；走到这里却没有核对结论说明分派出了错，拒绝执行。
    if (ticket === undefined) throw new McpError(ErrorCode.InternalError, 'tools/call 未经票据核对');
    const { name, arguments: args = {} } = request.params;
    const ids = { decisionId: ticket?.decisionId ?? null, attemptId: ticket?.attemptId ?? null };
    if (name === 'demo_echo' && typeof args.message === 'string') {
      effects.record(name, args.message, ticket);
      return result({ echoed: args.message, ...ids });
    }
    if (name === 'demo_delete' && typeof args.id === 'string') {
      effects.record(name, args.id, ticket);
      return result({ deleted: args.id, ...ids });
    }
    throw new McpError(ErrorCode.InvalidParams, `未知工具或参数不符：${name}`);
  });
  return server;
}

function result(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

export async function startDemoTool(env: NodeJS.ProcessEnv, deps: DemoToolDeps = {}): Promise<DemoTool> {
  const log = deps.log ?? ((message: string) => process.stderr.write(`aster-guard-demo-tool: ${message}\n`));
  const { mode, check } = ticketCheck(env, deps);
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DemoToolConfigError(`PORT 非法：${env.PORT}`);
  const effects = new EffectLog();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok', ticketCheck: mode });
    if (req.method === 'GET' && url.pathname === '/effects') {
      return send(res, 200, effects.snapshot(url.searchParams.get('marker') ?? undefined));
    }
    if (url.pathname !== '/mcp') return drop(req, res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return drop(req, res, 405, { error: 'method_not_allowed' });
    const text = await readBody(req);
    if (text === undefined) {
      res.setHeader('Connection', 'close');
      return drop(req, res, 413, { error: 'payload_too_large' });
    }
    // 只解析一次：核对与执行都用这个对象，重复键等「二次解析得到不同对象」的情形不存在。
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    if (Array.isArray(body)) return send(res, 400, { error: 'batch_not_supported' });
    let ticket: Ticket | undefined;
    if (isRecord(body) && body.method === 'tools/call') {
      const verdict = await check(isRecord(body.params) ? body.params : {});
      if (!verdict.ok) return send(res, 401, { error: 'ticket_rejected', reason: verdict.reason });
      ticket = verdict.ticket;
    }
    const server = toolServer(effects, ticket);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`请求处理失败：${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, env.HOST ?? '0.0.0.0', () => resolve());
  });
  let warning: NodeJS.Timeout | undefined;
  if (mode === 'off') {
    const warn = () => log('INSECURE: 票据核对已关闭（TICKET_CHECK=off），只允许用于红队副本');
    warn();
    warning = setInterval(warn, INSECURE_WARN_INTERVAL_MS);
    warning.unref();
  }
  const { address, port: bound } = http.address() as AddressInfo;
  log(`监听 ${address}:${bound}，票据核对 ${mode}`);
  return {
    url: new URL(`http://${address.includes(':') ? `[${address}]` : address}:${bound}/`),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(warning);
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

/** 读完请求体；超过上限返回 undefined。 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 不读（或不再读）请求体就回应：丢弃剩余请求体，客户端才能读到状态码。 */
function drop(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  req.resume();
  send(res, status, body);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 容器入口：配置错误以 2 退出；SIGTERM / SIGINT 关闭后以 0 退出。 */
async function main(): Promise<void> {
  let tool: DemoTool;
  try {
    tool = await startDemoTool(process.env);
  } catch (e) {
    process.stderr.write(`aster-guard-demo-tool: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof DemoToolConfigError ? 2 : 1;
    return;
  }
  const stop = () => void tool.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
