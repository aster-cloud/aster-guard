// aster-guard-mcp 的无状态 Streamable HTTP 服务端（ADR 0054 §3.1、§12 D4）。
// 每个 POST /mcp：先按 Bearer 找登记的 Agent（失败即 401，不建服务器、不访问 Guard），再为这一个请求新建
// 代理 MCP 服务器与无状态 transport，响应结束后关闭二者。上游连接与工具名缓存跨请求共享。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { GuardPrincipal } from '../types.js';
import { authenticate, type AgentEntry } from './agents.js';
import { createGuardProxyServer, createToolNameCache, type GuardProxyOptions, type UpstreamClient } from './proxy.js';

/** 请求体上限：超过即 413，不解析。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** /readyz：最近一次成功的上游 tools/list 在该时长内即就绪。 */
const READY_WINDOW_MS = 30_000;
/** /readyz：探测结论的缓存时长；并发请求共享同一次探测。 */
const READY_CACHE_MS = 10_000;
/** /readyz：单次上游探测的超时。 */
const READY_PROBE_TIMEOUT_MS = 3_000;
/** 共享工具名缓存刷新 tools/list 的超时。 */
const TOOL_LIST_TIMEOUT_MS = 30_000;

export interface HttpProxyOptions {
  listen: { host: string; port: number };
  agents: readonly AgentEntry[];
  /** 已连接的上游，或带 ready() 的重连监督器（CLI 对 HTTP 上游用后者）；由调用方在 close() 之后自行关闭。 */
  upstream: UpstreamClient;
  /** 每个 Agent 的代理选项，启动时每个 Agent 调用一次。返回值中的 principal 会被登记项覆盖。 */
  makeProxyOptions: (agent: AgentEntry) => Omit<GuardProxyOptions, 'upstream'>;
  /** 仅测试：/readyz 的时钟。 */
  now?: () => number;
}

export interface HttpProxy {
  url: URL;
  /** 停止接受新连接、关闭空闲连接，等在途请求结束（不关闭上游）。 */
  close(): Promise<void>;
}

/** Agent 的主体：principalId 缺省时取 id，类型固定 agent。 */
export function agentPrincipal(agent: AgentEntry): GuardPrincipal {
  return {
    id: agent.principalId ?? agent.id,
    type: 'agent',
    ...(agent.principalRoles?.length ? { roles: agent.principalRoles } : {}),
  };
}

export async function startHttpProxy(opts: HttpProxyOptions): Promise<HttpProxy> {
  const { upstream, now = Date.now } = opts;
  // 每个请求的代理实例 close() 时会关闭上游；共享的上游由调用方管理，这里给出不关闭的包装。
  const shared: UpstreamClient = {
    listTools: (...args) => upstream.listTools(...args),
    callTool: (...args) => upstream.callTool(...args),
    ready: () => upstream.ready?.() ?? true,
    close: async () => undefined,
  };
  const toolNames = createToolNameCache(upstream, TOOL_LIST_TIMEOUT_MS);
  const perAgent = new Map(
    opts.agents.map((agent) => [agent, { ...opts.makeProxyOptions(agent), principal: agentPrincipal(agent), upstream: shared, toolNames }]),
  );
  const ready = readiness(upstream, now);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 不读请求体就回应的分支：丢弃剩余请求体，避免客户端在发送途中被重置连接而读不到状态码。
    const drop = (status: number, body: unknown) => {
      req.resume();
      send(res, status, body);
    };
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz' && req.method === 'GET') return send(res, 200, 'ok', 'text/plain');
    if (path === '/readyz' && req.method === 'GET') {
      return (await ready()) ? send(res, 200, 'ready', 'text/plain') : send(res, 503, 'upstream unavailable', 'text/plain');
    }
    if (path !== '/mcp') return drop(404, { error: 'not_found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return drop(405, { error: 'method_not_allowed' });
    }
    const agent = authenticate(req.headers.authorization, opts.agents);
    if (!agent) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return drop(401, { error: 'unauthorized' });
    }
    const body = await readBody(req);
    if (body === 'too_large') {
      res.setHeader('Connection', 'close');
      return drop(413, { error: 'payload_too_large' });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
    const proxy = createGuardProxyServer(perAgent.get(agent)!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void proxy.close();
    });
    await proxy.server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.listen.port, opts.listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: new URL(`http://${host}:${address.port}/`),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}

/**
 * /readyz 判定：结论缓存 READY_CACHE_MS，过期后至多一次在途探测（并发共享）；
 * 最近一次成功的探测在 READY_WINDOW_MS 内即就绪——容忍上游短暂抖动，持续不可用则摘流。
 * 上游带 ready()（监听模式的重连监督）且为 false 时直接不就绪、不探测：此时 tools/call 一律被拒，
 * 不能因为窗口内的旧成功而继续接流。探测本身的连接级失败也会让监督器判定断开。
 */
function readiness(upstream: UpstreamClient, now: () => number): () => Promise<boolean> {
  let lastProbeAt = -Infinity;
  let lastSuccessAt = -Infinity;
  let probing: Promise<void> | undefined;
  const probe = async () => {
    try {
      await upstream.listTools(undefined, { timeout: READY_PROBE_TIMEOUT_MS });
      lastSuccessAt = now();
    } catch {
      // 失败只表现为 lastSuccessAt 不前进。
    } finally {
      lastProbeAt = now();
    }
  };
  return async () => {
    if (upstream.ready?.() === false) return false;
    if (now() - lastProbeAt >= READY_CACHE_MS) {
      probing ??= probe().finally(() => (probing = undefined));
      await probing;
    }
    return upstream.ready?.() !== false && now() - lastSuccessAt <= READY_WINDOW_MS;
  };
}

/** 读完请求体；超过 MAX_BODY_BYTES 立即停止读取并返回 'too_large'。 */
async function readBody(req: IncomingMessage): Promise<string | 'too_large'> {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BODY_BYTES) return 'too_large';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return 'too_large';
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
