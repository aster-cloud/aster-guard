// 绕过夹具套件的公共夹具（ADR 0054 §7 夹具层）：内存上游（记录 sideEffects）+ 代理 + 指向本地 aster-api 的 GuardClient。
// 只证明代理逻辑；部署里原始工具端点对模型不可达由 #466 部署层证明。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { GuardClient } from '../../src/client.js';
import { createGuardProxyServer, type GuardProxyOptions } from '../../src/mcp/index.js';

/** 夹具层是否启用；未启用时各 describe 以 skip 登记并打印原因（#466「先以 skip + 原因登记」）。 */
export const E2E = process.env.ASTER_GUARD_E2E === '1';
export const SKIP_REASON =
  'ASTER_GUARD_E2E 未设为 1：绕过夹具套件需要本地 aster-api（部署了 ASTER_GUARD_POLICY：refund_payment DENY、其余 ALLOW），见 README「绕过套件」';

export const env = {
  baseUrl: process.env.ASTER_GUARD_BASE_URL ?? 'http://localhost:8080',
  apiKey: process.env.ASTER_GUARD_API_KEY ?? 'ak_local',
  tenantId: process.env.ASTER_GUARD_TENANT_ID ?? '',
  policy: process.env.ASTER_GUARD_POLICY ?? 'guard.bypass/decide',
  /** 另一个已部署的、对一切 ALLOW 的策略（#517 换模块用例）；缺省时该子用例 skip。 */
  lenientPolicy: process.env.ASTER_GUARD_LENIENT_POLICY,
  /** 额外请求头 JSON（本地 apikey 关闭的栈用 {"X-Tenant-Id": …} 代替 API key 身份）。 */
  extraHeaders: JSON.parse(process.env.ASTER_GUARD_EXTRA_HEADERS ?? '{}') as Record<string, string>,
};

export const TOOLS: Tool[] = [
  { name: 'refund_payment', inputSchema: { type: 'object', properties: { paymentId: { type: 'string' }, amount: { type: 'number' } } } },
  { name: 'lookup_payment', inputSchema: { type: 'object', properties: { paymentId: { type: 'string' } } } },
  { name: 'send_email', inputSchema: { type: 'object', properties: { to: { type: 'string' }, cc: {}, body: {} } } },
];

export interface SideEffect {
  tool: string;
  args: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** 注入额外请求头的 fetch（本地 apikey 关闭时以 X-Tenant-Id 表明租户）。 */
function fetchWith(headers: Record<string, string>): typeof fetch {
  return (input, init) => globalThis.fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } });
}

export function guardClient(opts: { policy?: string; headers?: Record<string, string>; baseUrl?: string; apiKey?: string } = {}) {
  const [policyModule, policyFunction] = (opts.policy ?? env.policy).split('/');
  return new GuardClient({
    baseUrl: opts.baseUrl ?? env.baseUrl,
    apiKey: opts.apiKey ?? env.apiKey,
    policyModule,
    policyFunction,
    principal: { id: 'bypass-agent', type: 'agent' },
    tenantId: env.tenantId,
    fetch: fetchWith({ ...env.extraHeaders, ...(opts.headers ?? {}) }),
    timeoutMs: 5_000,
  });
}

/**
 * 搭起「agent ⇄ 代理 ⇄ 内存上游」。上游每次被调用把副作用写进 sideEffects；`onCall` 可替换上游行为
 * （#1b 的工具侧票据核对在这里做，拒绝时不写副作用）。
 */
export async function proxyRig(
  options: Partial<Omit<GuardProxyOptions, 'client' | 'upstream' | 'principal'>> = {},
  onCall?: (tool: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) => Promise<CallToolResult | undefined>,
) {
  const sideEffects: SideEffect[] = [];
  const upstreamServer = new Server({ name: 'bypass-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
  upstreamServer.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  upstreamServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const meta = request.params._meta as Record<string, unknown> | undefined;
    const override = onCall ? await onCall(request.params.name, args, meta) : undefined;
    if (override) return override;
    sideEffects.push({ tool: request.params.name, args, meta });
    return { content: [{ type: 'text', text: `${request.params.name} done` }] };
  });
  const [upClient, upServer] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(upServer);
  const upstream = new Client({ name: 'bypass-proxy-upstream', version: '0' });
  await upstream.connect(upClient);
  const client = guardClient();
  const proxy = createGuardProxyServer({
    client,
    upstream,
    principal: { id: 'bypass-agent', type: 'agent' },
    executorId: 'aster-guard-mcp@bypass-suite',
    isolation: 'network',
    tools: TOOLS.map((t) => t.name),
    approvalTimeoutMs: 0,
    ...options,
  });
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(proxySide);
  const agent = new Client({ name: 'bypass-agent', version: '0' });
  await agent.connect(agentSide);
  return {
    agent,
    client,
    upstream,
    sideEffects,
    async close() {
      await agent.close();
      await proxy.close();
      await upstreamServer.close();
    },
  };
}

export function guardMeta(result: unknown): Record<string, unknown> {
  return ((result as { _meta?: Record<string, unknown> })._meta?.asterGuard ?? {}) as Record<string, unknown>;
}

/**
 * `GET /api/v1/audit/receipts?decisionIds=` 中该决策的**权威** consume / result 事件数（ADR 0041 §12 D1：只认权威尝试，
 * 被拒的重放尝试也会入链但不是权威）。端点不可用时为 undefined，用例改以决策回读为准。
 */
export async function receiptsOf(decisionId: string): Promise<{ consumes: number; results: number } | undefined> {
  const res = await fetchWith(env.extraHeaders)(`${env.baseUrl}/api/v1/audit/receipts?decisionIds=${decisionId}`, {
    headers: { Authorization: `Bearer ${env.apiKey}` },
  });
  if (res.status !== 200) return undefined;
  type Row = { decisionId?: string; authoritative?: boolean };
  const body = (await res.json()) as { consumes?: Row[]; results?: Row[] };
  const count = (rows: Row[] | undefined) => (rows ?? []).filter((r) => r.decisionId === decisionId && r.authoritative).length;
  return { consumes: count(body.consumes), results: count(body.results) };
}
