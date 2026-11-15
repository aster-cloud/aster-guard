import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type JSONRPCMessage,
  type ListToolsResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { GuardClient } from '../src/client.js';
import { hashAction, jcsSha256 } from '../src/hash/jcs.js';
import { createGuardProxyServer, type GuardClientLike, type GuardProxyOptions } from '../src/mcp/index.js';
import type { GuardAction } from '../src/types.js';
import { fakeApi, type FakeApi } from './fixtures/fake-api.js';
import { mockGuard, textOf, UUID } from './helpers.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

// 代理集成测试：内存 MCP 上游（假服务器）+ 真实 GuardClient 对假 aster-api（真实签收据）+ SDK Client（ADR 0054 §2.2）。
// 链路：agent Client ⇄ InMemory ⇄ 代理 Server ⇄（upstream Client ⇄ InMemory ⇄ 假上游 Server）。

const PRINCIPAL = { id: 'agent-42', type: 'agent', roles: ['ops-bot'] };

const UPSTREAM_TOOLS: Tool[] = [
  {
    name: 'echo',
    description: '原样返回参数',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'delete_customer',
    description: '删除客户记录',
    inputSchema: { type: 'object', properties: { customerId: { type: 'string' } }, required: ['customerId'] },
    annotations: { destructiveHint: true },
  },
];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** 让已排队的微任务与 I/O 回调跑完；InMemoryTransport 同步投递，无需真实计时。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type UpstreamList = (cursor: string | undefined) => ListToolsResult | Promise<ListToolsResult>;
type UpstreamCall = (
  request: CallToolRequest,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => CallToolResult | Promise<CallToolResult>;

/** 假上游 tools/call 的缺省行为：把参数原样作为文本返回。 */
const echoCall: UpstreamCall = (request) => ({
  content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }],
});

/**
 * 搭起完整链路；返回 agent 侧 Client、假 aster-api、代理、假上游，「上游收到的 tools/list 游标 / tools/call」记录，
 * 以及代理发给 agent 的通知原文。fakes 可替换假上游的 tools/list（分页、挂起）与 tools/call（慢、progress）。
 */
async function setup(
  options: Partial<Omit<GuardProxyOptions, 'client' | 'upstream'>> = {},
  fakes: { list?: UpstreamList; call?: UpstreamCall } = {},
) {
  const { list = () => ({ tools: UPSTREAM_TOOLS }), call = echoCall } = fakes;
  const upstreamCalls = vi.fn<(params: CallToolRequest['params']) => void>();
  const upstreamListCalls = vi.fn(list);
  const fakeUpstream = new Server({ name: 'fake-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
  fakeUpstream.setRequestHandler(ListToolsRequestSchema, (request) => upstreamListCalls(request.params?.cursor));
  fakeUpstream.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    upstreamCalls(request.params);
    return call(request, extra);
  });
  const [upstreamClientSide, upstreamServerSide] = InMemoryTransport.createLinkedPair();
  await fakeUpstream.connect(upstreamServerSide);
  const upstream = new Client({ name: 'aster-guard-mcp-upstream', version: '0.0.0' });
  await upstream.connect(upstreamClientSide);

  const api = fakeApi();
  const proxy = createGuardProxyServer({
    client: new GuardClient(api.clientOptions()),
    upstream,
    principal: PRINCIPAL,
    ...options,
  });
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(proxySide);
  const agent = new Client({ name: 'agent', version: '0.0.0' });
  await agent.connect(agentSide);
  // 窃听代理发给 agent 的通知（如转发的 progress），断言线上原文而不只是 SDK 回调。
  const agentNotifications: JSONRPCMessage[] = [];
  const deliver = agentSide.onmessage;
  agentSide.onmessage = (message, extra) => {
    if (!('id' in message)) agentNotifications.push(message);
    deliver?.(message, extra);
  };

  cleanups.push(async () => {
    await agent.close();
    await proxy.close();
    await fakeUpstream.close();
  });
  return { agent, api, proxy, fakeUpstream, upstreamCalls, upstreamListCalls, agentNotifications };
}

/** 记下 promise 是否已落定，以便推进假时钟时断言「尚未返回」。 */
function settledState<T>(promise: Promise<T>) {
  const state = { settled: false, promise };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

/** 只假冒 setTimeout / clearTimeout：flush 依赖的 setImmediate 保持真实。 */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('aster-guard-mcp 代理：tools/list', () => {
  it('原样透传上游工具列表', async () => {
    const { agent, api } = await setup();
    const { tools } = await agent.listTools();
    expect(tools).toEqual(UPSTREAM_TOOLS);
    expect(api.requests).toHaveLength(0);
  });

  it('下游带 cursor：cursor 原样到达上游，上游的 nextCursor 原样返回', async () => {
    const pages: Record<string, ListToolsResult> = {
      first: { tools: [UPSTREAM_TOOLS[0]], nextCursor: 'opaque/p2' },
      'opaque/p2': { tools: [UPSTREAM_TOOLS[1]], nextCursor: 'opaque/p3' },
    };
    const { agent, upstreamListCalls } = await setup({}, { list: (cursor) => pages[cursor ?? 'first'] });

    const result = await agent.listTools({ cursor: 'opaque/p2' });

    expect(result.tools).toEqual([UPSTREAM_TOOLS[1]]);
    expect(result.nextCursor).toBe('opaque/p3');
    expect(upstreamListCalls.mock.calls.map(([cursor]) => cursor)).toEqual(['opaque/p2']);
  });
});

describe('aster-guard-mcp 代理：tools/call（ADR 0054 §2.2 固定顺序）', () => {
  it('allowForwardsCanonicalArgsAndReportsExecuted', async () => {
    const { agent, api, upstreamCalls } = await setup();
    const result = await agent.callTool({ name: 'echo', arguments: { text: 'hi', extra: null } });

    expect(result.isError).toBeFalsy();
    expect(upstreamCalls).toHaveBeenCalledTimes(1);
    const sent = (api.requests[0].body as { action: { context: unknown } }).action;
    expect(upstreamCalls.mock.calls[0][0].arguments).toEqual(sent.context);
    expect(JSON.stringify(upstreamCalls.mock.calls[0][0].arguments)).toBe('{"extra":null,"text":"hi"}');
    const meta = result._meta?.asterGuard as { decisionId: string; attemptId: string };
    expect(meta.decisionId).toMatch(UUID);
    expect(meta.attemptId).toMatch(UUID);
    const report = api.requests.find((r) => r.path.endsWith('/result'))?.body as Record<string, unknown>;
    expect(report).toMatchObject({ status: 'executed', attemptId: meta.attemptId, resultHash: jcsSha256(result.content) });
    expect(api.sequence()).toEqual([
      'POST /api/v1/guard/decisions',
      'GET /api/v1/guard/keys',
      'POST /api/v1/guard/receipts/{id}/consume',
      'POST /api/v1/guard/receipts/{id}/result',
    ]);
  });

  it('upstreamIsErrorReportsFailed', async () => {
    const { agent, api } = await setup({}, { call: () => ({ isError: true, content: [{ type: 'text', text: 'nope' }] }) });
    const result = await agent.callTool({ name: 'echo', arguments: {} });
    expect(result.isError).toBe(true);
    expect(api.requests.find((r) => r.path.endsWith('/result'))?.body).toMatchObject({ status: 'failed', errorCode: 'tool_error' });
  });

  it('upstreamThrowReportsFailedAndPropagatesProtocolError', async () => {
    const { agent, api } = await setup({}, { call: () => { throw new Error('boom'); } });
    await expect(agent.callTool({ name: 'echo', arguments: {} })).rejects.toThrow(/boom/);
    expect(api.requests.find((r) => r.path.endsWith('/result'))?.body).toMatchObject({ status: 'failed' });
  });

  it('denyReturnsStructuredDeniedAndUpstreamNotCalled', async () => {
    const { agent, api, upstreamCalls } = await setup();
    api.script('DENY');
    const result = await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-1' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Blocked by Aster Guard: 规则拒绝 \(decision [0-9a-f-]{36}\)$/);
    const payload = { status: 'denied', outcome: 'DENY', reason: '规则拒绝', ruleId: 'R-DENY', controls: ['C-1'] };
    expect(result._meta?.asterGuard).toMatchObject(payload);
    expect((result.structuredContent as { asterGuard: unknown }).asterGuard).toMatchObject(payload);
    expect(upstreamCalls).not.toHaveBeenCalled();
    expect(api.sequence()).toEqual(['POST /api/v1/guard/decisions']);
  });

  it('pendingReturnsStructuredPending', async () => {
    const { agent, api, upstreamCalls } = await setup({ approvalTimeoutMs: 0 });
    api.script('PENDING');
    const result = await agent.callTool({ name: 'echo', arguments: {} });
    expect(result.isError).toBe(true);
    const payload = result._meta?.asterGuard as Record<string, string>;
    expect(payload).toMatchObject({ status: 'pending', requiredRole: 'DPO', expiresAt: '2099-01-01T00:00:00Z' });
    expect(payload.poll).toBe(`GET /api/v1/guard/decisions/${payload.decisionId}`);
    expect(payload.approvalId).toMatch(UUID);
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('pendingThenRetryIsANewDecision：旧审批随后批准也不转发', async () => {
    const { agent, api, upstreamCalls } = await setup({ approvalTimeoutMs: 0 });
    api.script('PENDING', 'PENDING');
    const first = await agent.callTool({ name: 'echo', arguments: {} });
    const second = await agent.callTool({ name: 'echo', arguments: {} });
    const ids = [first, second].map((r) => (r._meta?.asterGuard as { decisionId: string }).decisionId);
    expect(ids[0]).not.toBe(ids[1]);
    const keys = api.requests.filter((r) => r.path === '/api/v1/guard/decisions').map((r) => r.headers['Idempotency-Key']);
    expect(keys[0]).not.toBe(keys[1]);
    api.approve(ids[0]);
    await flush();
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('PENDING → 审批通过 → 转发', async () => {
    const { agent, api, upstreamCalls } = await setup();
    api.script('PENDING');
    api.override((req) => {
      if (req.method === 'GET' && /\/decisions\/[0-9a-f-]{36}$/.test(req.path)) api.approve(req.path.split('/').pop()!);
      return undefined;
    });
    const result = await agent.callTool({ name: 'echo', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(upstreamCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['receipt_invalid', (api: FakeApi) => api.mutateReceipts((r) => ({ ...r, signature: r.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }))],
    ['receipt_consumed', (api: FakeApi) => api.override((r) => (r.path.endsWith('/consume') ? json(409, { error: 'receipt_consumed' }) : undefined))],
    ['action_mismatch', (api: FakeApi) => api.override((r) => (r.path.endsWith('/consume') ? json(409, { error: 'action_mismatch' }) : undefined))],
    ['client_error', (api: FakeApi) => api.override((r) => (r.path === '/api/v1/guard/decisions' ? json(503, {}) : undefined))],
  ])('blocked %s：结构化载荷，上游未调用', async (code, arrange) => {
    const { agent, api, upstreamCalls } = await setup();
    arrange(api);
    const result = await agent.callTool({ name: 'echo', arguments: {} });
    expect(result.isError).toBe(true);
    const payload = result._meta?.asterGuard as Record<string, string>;
    expect(payload.status).toBe('blocked');
    expect(payload.reasonCode).toBe(code === 'client_error' ? 'http_503' : code);
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('denyOnToolWithOutputSchemaUsesMetaOnly：下游 SDK callTool 不抛', async () => {
    const tools: Tool[] = [
      { name: 'typed', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } },
    ];
    const { agent, api, upstreamCalls } = await setup({}, { list: () => ({ tools }) });
    await agent.listTools();
    api.script('DENY');
    const result = await agent.callTool({ name: 'typed', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result._meta?.asterGuard as { status: string }).status).toBe('denied');
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('cancelAfterConsumeDoesNotForward', async () => {
    const { agent, api, upstreamCalls } = await setup();
    const controller = new AbortController();
    api.override(async (req) => {
      if (req.path.endsWith('/consume')) {
        controller.abort();
        await flush();
        await flush();
      }
      return undefined;
    });
    await expect(agent.callTool({ name: 'echo', arguments: {} }, undefined, { signal: controller.signal })).rejects.toThrow();
    await flush();
    expect(upstreamCalls).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(api.requests.find((r) => r.path.endsWith('/result'))?.body).toMatchObject({ status: 'aborted', errorCode: 'cancelled' }),
    );
  });

  it('nonJsonSafeArgsBlockedBeforeDecision', async () => {
    const { agent, api, upstreamCalls } = await setup();
    // JSON 线上无法传 NaN；用 2^53 这种 JSON 可表示而 jcs-sha256/v1 拒绝的值。
    const result = await agent.callTool({ name: 'echo', arguments: { n: 2 ** 53 } });
    expect((result._meta?.asterGuard as Record<string, string>)).toMatchObject({ status: 'blocked', reasonCode: 'client_error' });
    expect(api.requests).toHaveLength(0);
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('toolsListFilteredByAllowList 与 callOutsideAllowListIsUnknownTool', async () => {
    const { agent, api } = await setup({ tools: ['echo'] });
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    await expect(agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C' } })).rejects.toThrow(/Unknown tool/);
    expect(api.requests).toHaveLength(0);
  });

  it('auth 隔离：转发请求的 _meta 带 consume 票据（含 envelope）；network 不带', async () => {
    const auth = await setup({ isolation: 'auth' });
    await auth.agent.callTool({ name: 'echo', arguments: { text: 'x' } });
    const ticket = auth.upstreamCalls.mock.calls[0][0]._meta?.['io.aster/guard-consume'] as Record<string, unknown>;
    expect(ticket).toMatchObject({ decisionId: expect.stringMatching(UUID), attemptId: expect.stringMatching(UUID) });
    const sent = (auth.api.requests[0].body as { action: GuardAction }).action;
    expect(hashAction({ ...(ticket.envelope as object), context: sent.context } as GuardAction)).toBe(hashAction(sent));
    const network = await setup({ isolation: 'network' });
    await network.agent.callTool({ name: 'echo', arguments: { text: 'x' } });
    expect(network.upstreamCalls.mock.calls[0][0]._meta?.['io.aster/guard-consume']).toBeUndefined();
  });

  it('未知工具 → MCP 错误，不调用 guard 与上游', async () => {
    const { agent, api, upstreamCalls } = await setup();
    await expect(agent.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool: no_such_tool/);
    expect(api.requests).toHaveLength(0);
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('未先 tools/list 也能识别上游工具', async () => {
    const { agent } = await setup();
    const result = await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-9' } });
    expect(result.isError).toBeFalsy();
  });
});

describe('aster-guard-mcp 代理：上游工具名缓存与分页守卫', () => {
  it('完整列出一次后缓存工具名：已知工具不再向上游 tools/list', async () => {
    const { agent, upstreamListCalls } = await setup();

    await agent.callTool({ name: 'echo', arguments: {} });
    await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-1' } });
    await agent.callTool({ name: 'echo', arguments: {} });

    expect(upstreamListCalls).toHaveBeenCalledTimes(1);
  });

  it('跨页收集工具名', async () => {
    const pages: Record<string, ListToolsResult> = {
      first: { tools: [UPSTREAM_TOOLS[0]], nextCursor: 'p2' },
      p2: { tools: [UPSTREAM_TOOLS[1]] },
    };
    const { agent, upstreamListCalls } = await setup({}, { list: (cursor) => pages[cursor ?? 'first'] });

    const result = await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-1' } });

    expect(result.isError).toBeFalsy();
    expect(upstreamListCalls.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'p2']);
  });

  it('上游重复返回同一个 nextCursor：停止翻页，未知工具照常报错', async () => {
    const { agent, upstreamListCalls } = await setup({}, { list: () => ({ tools: [UPSTREAM_TOOLS[0]], nextCursor: 'again' }) });

    await expect(agent.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool: no_such_tool/);

    expect(upstreamListCalls.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'again']);
  });

  it('上游游标永不结束：最多翻 100 页', async () => {
    const { agent, upstreamListCalls } = await setup(
      {},
      { list: (cursor) => ({ tools: [], nextCursor: `c${Number(cursor?.slice(1) ?? 0) + 1}` }) },
    );

    await expect(agent.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool/);

    expect(upstreamListCalls).toHaveBeenCalledTimes(100);
  });

  it('未知工具每次调用至多触发一次完整刷新', async () => {
    const { agent, upstreamListCalls } = await setup();

    await expect(agent.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool/);
    await expect(agent.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/Unknown tool/);

    expect(upstreamListCalls).toHaveBeenCalledTimes(2);
  });
});

describe('aster-guard-mcp 代理：Action 构造', () => {
  it('action.name 为工具名，context 为工具参数（null 保留），principal 来自配置，resource 由 resourceFromArg 抽取', async () => {
    const { agent, api } = await setup({ resourceFromArg: 'customerId', agentModel: 'claude-x' });
    await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-1001', reason: null } });
    expect((api.requests[0].body as { action: unknown }).action).toEqual({
      principal: PRINCIPAL,
      action: { name: 'delete_customer' },
      resource: { type: 'arg', id: 'C-1001' },
      context: { customerId: 'C-1001', reason: null },
      agent: { model: 'claude-x' },
    });
  });

  it('按工具映射：actionName、resourceFrom 与 digestArgs', async () => {
    const { agent, api, upstreamCalls } = await setup({
      actions: { echo: { actionName: 'say', resourceFrom: 'to', digestArgs: ['text'] } },
    });
    await agent.callTool({ name: 'echo', arguments: { to: 'a@x', text: 'hi' } });
    const action = (api.requests[0].body as { action: GuardAction }).action;
    expect(action.action).toEqual({ name: 'say' });
    expect(action.resource).toEqual({ type: 'arg', id: 'a@x' });
    expect(action.context).toEqual({ text: { $sha256: jcsSha256('hi') }, to: 'a@x' });
    expect(upstreamCalls.mock.calls[0][0].arguments).toEqual({ text: 'hi', to: 'a@x' });
  });

  it('每次调用使用新的幂等键：取自全局 crypto.randomUUID，不从 JSON-RPC id 派生', async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID');
    onTestFinished(() => randomUUID.mockRestore());
    const { agent, api } = await setup();
    await agent.callTool({ name: 'echo', arguments: { text: 'same' } });
    await agent.callTool({ name: 'echo', arguments: { text: 'same' } });
    const keys = api.requests.filter((r) => r.path === '/api/v1/guard/decisions').map((r) => r.headers['Idempotency-Key']);
    expect(keys[0]).toMatch(UUID);
    expect(keys[0]).not.toBe(keys[1]);
    expect(randomUUID.mock.results.map((r) => r.value)).toEqual(expect.arrayContaining(keys));
  });
});

describe('aster-guard-mcp 代理：上游超时与 progress 转发', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const hangingCall: UpstreamCall = () => new Promise<CallToolResult>(() => undefined);

  /** 假上游先报告一次 progress（token 取上游请求里的 progressToken），再返回结果。 */
  const reportsProgress: UpstreamCall = async (request, extra) => {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: request.params._meta?.progressToken ?? 'missing', progress: 1, total: 2, message: 'half' },
    });
    return { content: [{ type: 'text', text: 'done' }] };
  };

  it('上游超过 upstreamTimeoutMs 未响应 → 下游收到 RequestTimeout 错误，而不是成功结果', async () => {
    const { agent, upstreamCalls } = await setup({ upstreamTimeoutMs: 200 }, { call: hangingCall });
    useFakeClock();

    const call = settledState(agent.callTool({ name: 'echo', arguments: {} }));
    await flush();
    expect(upstreamCalls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    await expect(call.promise).rejects.toMatchObject({ code: ErrorCode.RequestTimeout, data: { timeout: 200 } });
  });

  it('upstreamTimeoutMs 缺省为 600000', async () => {
    const { agent } = await setup({}, { call: hangingCall });
    useFakeClock();

    // agent 自己的请求超时放宽到 1 小时，确保先到时的是代理对上游的超时。
    const call = settledState(agent.callTool({ name: 'echo', arguments: {} }, undefined, { timeout: 3_600_000 }));
    await flush();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    await expect(call.promise).rejects.toMatchObject({ code: ErrorCode.RequestTimeout, data: { timeout: 600_000 } });
  });

  it.each([
    ['tools/list 透传', (agent: Client) => agent.listTools()],
    ['tools/call 前刷新工具名', (agent: Client) => agent.callTool({ name: 'echo', arguments: {} })],
  ])('上游 tools/list 超过 upstreamTimeoutMs → %s 收到 RequestTimeout 错误', async (_label, act) => {
    const { agent, api } = await setup(
      { upstreamTimeoutMs: 200 },
      { list: () => new Promise<ListToolsResult>(() => undefined) },
    );
    useFakeClock();

    const pending = settledState(act(agent));
    await flush();
    await vi.advanceTimersByTimeAsync(200);

    expect(pending.settled).toBe(true);
    await expect(pending.promise).rejects.toMatchObject({ code: ErrorCode.RequestTimeout, data: { timeout: 200 } });
    expect(api.requests).toHaveLength(0);
  });

  it('上游在超时前报告 progress 会重置计时（resetTimeoutOnProgress）：总耗时超过 upstreamTimeoutMs 仍成功', async () => {
    const slowWithProgress: UpstreamCall = async (request, extra) => {
      await sleep(150);
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: request.params._meta?.progressToken ?? 'missing', progress: 1 },
      });
      await sleep(150);
      return { content: [{ type: 'text', text: 'done' }] };
    };
    const { agent } = await setup({ upstreamTimeoutMs: 200 }, { call: slowWithProgress });
    useFakeClock();

    const call = settledState(agent.callTool({ name: 'echo', arguments: {} }));
    await flush();
    await vi.advanceTimersByTimeAsync(300);

    expect(call.settled).toBe(true);
    const result = await call.promise;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('done');
  });

  it('下游带 progressToken：上游 progress 以下游原 token 转发，下游 onprogress 收到', async () => {
    const { agent } = await setup({}, { call: reportsProgress });
    const onprogress = vi.fn();

    const result = await agent.callTool({ name: 'echo', arguments: {} }, undefined, { onprogress });

    expect(textOf(result)).toBe('done');
    expect(onprogress).toHaveBeenCalledTimes(1);
    expect(onprogress).toHaveBeenCalledWith({ progress: 1, total: 2, message: 'half' });
  });

  it('转发的 progressToken 与下游请求中的原值完全一致（字符串 token 亦然）', async () => {
    const { agent, agentNotifications } = await setup({}, { call: reportsProgress });
    // agent 没为 'tok-1' 登记回调，SDK 会经 onerror 报「未知 token」；这里只断言线上原文。
    agent.onerror = () => undefined;

    await agent.request(
      { method: 'tools/call', params: { name: 'echo', arguments: {}, _meta: { progressToken: 'tok-1' } } },
      CallToolResultSchema,
    );

    expect(agentNotifications).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 1, total: 2, message: 'half' },
      },
    ]);
  });

  it('下游未带 progressToken：上游 progress 不转发', async () => {
    const { agent, agentNotifications } = await setup({}, { call: reportsProgress });

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(textOf(result)).toBe('done');
    expect(agentNotifications).toEqual([]);
  });
});

describe('aster-guard-mcp 代理：上游未就绪（ready() 为 false）', () => {
  /** 直接以 InMemory 连接代理；上游是带 ready() 的桩，记录是否被触达。 */
  async function rig(ready: () => boolean, tools?: string[]) {
    const guard = mockGuard();
    const upstream = {
      ready,
      listTools: vi.fn(async () => ({ tools: UPSTREAM_TOOLS })),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'executed' }] })),
      close: vi.fn(async () => undefined),
    };
    const proxy = createGuardProxyServer({
      client: guard as unknown as GuardClientLike,
      upstream: upstream as unknown as GuardProxyOptions['upstream'],
      principal: PRINCIPAL,
      ...(tools ? { tools } : {}),
    });
    const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
    await proxy.server.connect(proxySide);
    const agent = new Client({ name: 'agent', version: '0.0.0' });
    await agent.connect(agentSide);
    cleanups.push(async () => {
      await agent.close();
      await proxy.close();
    });
    return { agent, guard, upstream };
  }

  it('upstreamUnavailableFailsClosedBeforeDecision：不裁决、不转发、不刷新工具列表', async () => {
    const { agent, guard, upstream } = await rig(() => false);
    const result = (await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-1' } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result._meta?.asterGuard).toEqual({
      status: 'blocked',
      reasonCode: 'upstream_unavailable',
      reason: '上游 MCP 服务器暂不可用（正在重连），本次调用未裁决、未转发',
    });
    expect(textOf(result)).toMatch(/^Blocked by Aster Guard: 上游 MCP 服务器暂不可用/);
    for (const fn of Object.values(guard)) expect(fn).not.toHaveBeenCalled();
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(upstream.listTools).not.toHaveBeenCalled();
  });

  it('白名单外的工具仍是 Unknown tool（白名单先于就绪判定）', async () => {
    const { agent, guard } = await rig(() => false, ['echo']);
    await expect(agent.callTool({ name: 'delete_customer', arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(guard.run).not.toHaveBeenCalled();
  });

  it('ready() 为 true 时照常经 GuardClient.run', async () => {
    const { agent, guard } = await rig(() => true);
    guard.run.mockResolvedValue({ kind: 'blocked', decision: { decisionId: 'd-1', outcome: 'DENY', effectiveOutcome: 'DENY', reason: 'no' } });
    const result = (await agent.callTool({ name: 'echo', arguments: {} })) as CallToolResult;
    expect(guard.run).toHaveBeenCalledTimes(1);
    expect(result._meta?.asterGuard).toMatchObject({ status: 'denied', decisionId: 'd-1' });
  });
});

describe('createGuardProxyServer.close', () => {
  it('关闭上游且只关闭一次：连续两次 close()，假上游的 onclose 只触发一次', async () => {
    const { proxy, fakeUpstream } = await setup();
    const upstreamClosed = vi.fn();
    fakeUpstream.onclose = upstreamClosed;

    await proxy.close();
    await proxy.close();

    expect(upstreamClosed).toHaveBeenCalledTimes(1);
  });
});

describe('createGuardProxyServer 参数校验', () => {
  it('approvalTimeoutMs 非法属于编程错误，构造时抛出', () => {
    expect(() =>
      createGuardProxyServer({ client: mockGuard() as unknown as GuardClientLike, principal: PRINCIPAL, approvalTimeoutMs: -1 }),
    ).toThrow(TypeError);
  });

  // 上限是 setTimeout 的 32 位上限：超过时 Node 会把计时器改成 1 ms，等于每次上游调用立刻超时。
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'upstreamTimeoutMs 为 %s 属于编程错误，构造时抛出',
    (upstreamTimeoutMs) => {
      expect(() =>
        createGuardProxyServer({ client: mockGuard() as unknown as GuardClientLike, principal: PRINCIPAL, upstreamTimeoutMs }),
      ).toThrow(TypeError);
    },
  );
});
