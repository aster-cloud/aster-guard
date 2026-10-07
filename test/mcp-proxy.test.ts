import { createHash } from 'node:crypto';
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
import { createGuardProxyServer, type GuardClientLike, type GuardProxyOptions } from '../src/mcp/index.js';
import type { GuardDecision } from '../src/types.js';
import { mockGuard, textOf, UUID } from './helpers.js';

// 代理集成测试：内存 MCP 上游（假服务器）+ mock GuardClient + SDK Client（ADR 0040 §6）。
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

const ALLOW: GuardDecision = { decisionId: 'd-1', outcome: 'ALLOW', effectiveOutcome: 'ALLOW', ruleId: 'R-1' };
const PENDING: GuardDecision = {
  decisionId: 'd-3',
  outcome: 'REQUIRE_APPROVAL',
  effectiveOutcome: 'PENDING',
  approval: { id: 'a-3', status: 'PENDING', expiresAt: '2026-10-09T00:00:00Z', requiredRole: 'DPO' },
};

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
 * 搭起完整链路；返回 agent 侧 Client、mock guard、代理、假上游，「上游收到的 tools/list 游标 / tools/call」记录，
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

  const guard = mockGuard();
  const proxy = createGuardProxyServer({
    client: guard as unknown as GuardClientLike,
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
  return { agent, guard, proxy, fakeUpstream, upstreamCalls, upstreamListCalls, agentNotifications };
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
    const { agent, guard } = await setup();
    const { tools } = await agent.listTools();
    expect(tools).toEqual(UPSTREAM_TOOLS);
    expect(guard.check).not.toHaveBeenCalled();
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

describe('aster-guard-mcp 代理：tools/call', () => {
  it('ALLOW 时转发并返回上游结果', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue(ALLOW);

    const result = await agent.callTool({ name: 'echo', arguments: { text: 'hi' } });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('{"text":"hi"}');
    expect(upstreamCalls).toHaveBeenCalledTimes(1);
    expect(upstreamCalls.mock.calls[0][0]).toMatchObject({ name: 'echo', arguments: { text: 'hi' } });
    expect(guard.waitFor).not.toHaveBeenCalled();
  });

  it('DENY 时返回 isError（含 reason 与 decisionId），上游未被调用', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue({
      decisionId: 'd-2',
      outcome: 'DENY',
      effectiveOutcome: 'DENY',
      reasonCode: 'policy_denied',
      reason: 'amount exceeds limit',
    });

    const result = await agent.callTool({ name: 'echo', arguments: { text: 'hi' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Blocked by Aster Guard: amount exceeds limit (decision d-2)');
    expect(upstreamCalls).not.toHaveBeenCalled();
    expect(guard.waitFor).not.toHaveBeenCalled();
  });

  it('DENY 没有 reason 时用 reasonCode', async () => {
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue({ decisionId: 'd-2', outcome: 'DENY', effectiveOutcome: 'DENY', reasonCode: 'not_a_verdict' });

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Blocked by Aster Guard: not_a_verdict (decision d-2)');
  });

  it('PENDING→ALLOW：waitFor 按 approvalTimeoutMs 等到 ALLOW 后转发', async () => {
    const { agent, guard, upstreamCalls } = await setup({ approvalTimeoutMs: 1_234 });
    guard.check.mockResolvedValue(PENDING);
    guard.waitFor.mockResolvedValue({ ...ALLOW, decisionId: 'd-3' });

    const result = await agent.callTool({ name: 'echo', arguments: { text: 'later' } });

    expect(guard.waitFor).toHaveBeenCalledWith('d-3', { timeoutMs: 1_234, signal: expect.any(AbortSignal) });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('{"text":"later"}');
    expect(upstreamCalls).toHaveBeenCalledTimes(1);
  });

  it('approvalTimeoutMs 缺省为 300000', async () => {
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue(PENDING);
    guard.waitFor.mockResolvedValue({ ...ALLOW, decisionId: 'd-3' });

    await agent.callTool({ name: 'echo', arguments: {} });

    expect(guard.waitFor).toHaveBeenCalledWith('d-3', { timeoutMs: 300_000, signal: expect.any(AbortSignal) });
  });

  it('PENDING→等待超时（wait_timeout）：拒绝，保留 decisionId，上游未被调用', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue(PENDING);
    guard.waitFor.mockResolvedValue({
      decisionId: 'd-3',
      outcome: 'DENY',
      effectiveOutcome: 'DENY',
      reasonCode: 'wait_timeout',
      reason: 'no final decision within 300000 ms',
    });

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Blocked by Aster Guard: no final decision within 300000 ms (decision d-3)');
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('PENDING→审批被拒：拒绝', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue(PENDING);
    guard.waitFor.mockResolvedValue({ decisionId: 'd-3', outcome: 'REQUIRE_APPROVAL', effectiveOutcome: 'DENY', reasonCode: 'approval_rejected' });

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Blocked by Aster Guard: approval_rejected (decision d-3)');
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  // Review Focus 5：guard 服务不可达时 GuardClient fail-closed 为 decisionId 为空串的 DENY，代理必须拒绝。
  it.each([
    ['client_error', 'fetch failed'],
    ['client_timeout', 'request did not complete within 12000 ms'],
    ['http_503', 'HTTP 503'],
  ])('guard 服务不可达（%s）→ 拒绝，上游未被调用', async (reasonCode, reason) => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue({ decisionId: '', outcome: 'DENY', effectiveOutcome: 'DENY', reasonCode, reason });

    const result = await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-1' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`Blocked by Aster Guard: ${reason} (decision n/a)`);
    expect(upstreamCalls).not.toHaveBeenCalled();
    expect(guard.waitFor).not.toHaveBeenCalled();
  });

  it('GuardClient 实现抛异常时同样 fail-closed：拒绝，上游未被调用', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockRejectedValue(new Error('boom'));

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Blocked by Aster Guard: boom (decision n/a)');
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('没有 decisionId 的 ALLOW 不算服务端确认的放行：拒绝', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue({ ...ALLOW, decisionId: '' });

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Blocked by Aster Guard: .+ \(decision n\/a\)$/);
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('下游在等待审批期间取消请求：审批随后通过也不转发', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue(PENDING);
    let release!: (decision: GuardDecision) => void;
    guard.waitFor.mockReturnValue(new Promise<GuardDecision>((resolve) => (release = resolve)));
    const controller = new AbortController();

    const call = agent.callTool({ name: 'echo', arguments: {} }, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(guard.waitFor).toHaveBeenCalled());
    const waitSignal = guard.waitFor.mock.calls[0][1]?.signal;
    expect(waitSignal?.aborted).toBe(false);

    controller.abort('agent gave up');
    await expect(call).rejects.toThrow();
    await flush();
    // 取消经 notifications/cancelled 传到代理，交给 waitFor 的 signal 随之中止，轮询得以停止。
    expect(waitSignal?.aborted).toBe(true);
    release({ ...ALLOW, decisionId: 'd-3' });
    await flush();

    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('waitFor 抛异常 → 拒绝，文本保留 PENDING 的 decisionId，上游未被调用', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue(PENDING);
    guard.waitFor.mockRejectedValue(new Error('poll exploded'));

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Blocked by Aster Guard: poll exploded (decision d-3)');
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('未知工具 → MCP 错误，不调用 guard 与上游', async () => {
    const { agent, guard, upstreamCalls } = await setup();

    await expect(agent.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool: no_such_tool/);
    expect(guard.check).not.toHaveBeenCalled();
    expect(upstreamCalls).not.toHaveBeenCalled();
  });

  it('未先 tools/list 也能识别上游工具', async () => {
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue(ALLOW);

    // setup 里 agent 未调用 listTools；代理需自行向上游查询工具集。
    const result = await agent.callTool({ name: 'delete_customer', arguments: { customerId: 'C-9' } });

    expect(result.isError).toBeFalsy();
  });
});

describe('aster-guard-mcp 代理：上游工具名缓存与分页守卫', () => {
  it('完整列出一次后缓存工具名：已知工具不再向上游 tools/list', async () => {
    const { agent, guard, upstreamListCalls } = await setup();
    guard.check.mockResolvedValue(ALLOW);

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
    const { agent, guard, upstreamListCalls } = await setup({}, { list: (cursor) => pages[cursor ?? 'first'] });
    guard.check.mockResolvedValue(ALLOW);

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
  it('action.name 为工具名，context 为工具参数，principal 来自配置，resource 由 resourceFromArg 抽取', async () => {
    const { agent, guard } = await setup({ resourceFromArg: 'customerId', agentModel: 'claude-x' });
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({ name: 'delete_customer', arguments: { customerId: 1001, reason: 'gdpr' } });

    expect(guard.check).toHaveBeenCalledTimes(1);
    const [action, opts] = guard.check.mock.calls[0];
    expect(action).toEqual({
      principal: PRINCIPAL,
      action: { name: 'delete_customer' },
      resource: { type: 'arg', id: '1001' },
      context: { customerId: 1001, reason: 'gdpr' },
      agent: { model: 'claude-x' },
    });
    expect(opts?.idempotencyKey).toMatch(UUID);
  });

  it('未配置 resourceFromArg、参数缺失或为 null 时不带 resource；null 参数从 context 剔除；无参数时 context 为 {}', async () => {
    const { agent, guard } = await setup({ resourceFromArg: 'customerId' });
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({ name: 'echo', arguments: { customerId: null } });
    await agent.callTool({ name: 'echo' });

    const [first] = guard.check.mock.calls[0];
    const [second] = guard.check.mock.calls[1];
    expect(first.resource).toBeUndefined();
    expect(first.agent).toBeUndefined();
    expect(first.context).toStrictEqual({});
    expect(second.resource).toBeUndefined();
    expect(second.context).toStrictEqual({});
  });

  it('context 递归剔除 null 键与数组中的 null 元素（服务端拒绝 null 值）；上游仍收到原始参数', async () => {
    const { agent, guard, upstreamCalls } = await setup();
    guard.check.mockResolvedValue(ALLOW);
    const args = {
      keep: 0,
      drop: null,
      nested: { gone: null, list: [1, null, { gone: null, flag: false }], text: '' },
      empty: [null],
    };

    const result = await agent.callTool({ name: 'echo', arguments: args });

    expect(result.isError).toBeFalsy();
    expect(guard.check.mock.calls[0][0].context).toStrictEqual({
      keep: 0,
      nested: { list: [1, { flag: false }], text: '' },
      empty: [],
    });
    expect(upstreamCalls.mock.calls[0][0].arguments).toStrictEqual(args);
  });

  it.each([
    ['字符串', 'C-1', 'C-1'],
    ['数字', 42, '42'],
    ['布尔', true, 'true'],
    ['对象', { tenant: 't1', id: 7 }, '{"tenant":"t1","id":7}'],
    ['数组', ['a', 'b'], '["a","b"]'],
  ])('resource.id：%s 参数值序列化为稳定文本（对象 / 数组用 JSON，不是 "[object Object]"）', async (_label, value, expected) => {
    const { agent, guard } = await setup({ resourceFromArg: 'target' });
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({ name: 'echo', arguments: { target: value } });

    expect(guard.check.mock.calls[0][0].resource).toEqual({ type: 'arg', id: expected });
  });

  const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const longObject = { blob: 'y'.repeat(300) };

  it.each([
    ['超过 255 字符的字符串 → sha256', 'x'.repeat(256), sha256('x'.repeat(256))],
    ['JSON 超过 255 字符的对象 → JSON 的 sha256', longObject, sha256(JSON.stringify(longObject))],
    ['JSON 超过 255 字符的数组 → JSON 的 sha256', ['a'.repeat(300)], sha256(JSON.stringify(['a'.repeat(300)]))],
    ['含控制字符的字符串 → sha256', 'C-1\n', sha256('C-1\n')],
    ['恰好 255 字符的字符串 → 原样', 'z'.repeat(255), 'z'.repeat(255)],
  ])('resource.id 超出服务端文本限制（≤ 255 字符、无控制字符）时改用哈希：%s', async (_label, value, expected) => {
    const { agent, guard } = await setup({ resourceFromArg: 'target' });
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({ name: 'echo', arguments: { target: value } });

    expect(guard.check.mock.calls[0][0].resource).toEqual({ type: 'arg', id: expected });
  });

  it('每次调用使用新的幂等键：取自全局 crypto.randomUUID，不从 JSON-RPC id 派生', async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID');
    onTestFinished(() => randomUUID.mockRestore());
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({ name: 'echo', arguments: { text: 'same' } });
    await agent.callTool({ name: 'echo', arguments: { text: 'same' } });

    const keys = guard.check.mock.calls.map(([, opts]) => opts?.idempotencyKey);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toMatch(UUID);
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
    const { agent, guard, upstreamCalls } = await setup({ upstreamTimeoutMs: 200 }, { call: hangingCall });
    guard.check.mockResolvedValue(ALLOW);
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
    const { agent, guard } = await setup({}, { call: hangingCall });
    guard.check.mockResolvedValue(ALLOW);
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
    const { agent, guard } = await setup(
      { upstreamTimeoutMs: 200 },
      { list: () => new Promise<ListToolsResult>(() => undefined) },
    );
    useFakeClock();

    const pending = settledState(act(agent));
    await flush();
    await vi.advanceTimersByTimeAsync(200);

    expect(pending.settled).toBe(true);
    await expect(pending.promise).rejects.toMatchObject({ code: ErrorCode.RequestTimeout, data: { timeout: 200 } });
    expect(guard.check).not.toHaveBeenCalled();
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
    const { agent, guard } = await setup({ upstreamTimeoutMs: 200 }, { call: slowWithProgress });
    guard.check.mockResolvedValue(ALLOW);
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
    const { agent, guard } = await setup({}, { call: reportsProgress });
    guard.check.mockResolvedValue(ALLOW);
    const onprogress = vi.fn();

    const result = await agent.callTool({ name: 'echo', arguments: {} }, undefined, { onprogress });

    expect(textOf(result)).toBe('done');
    expect(onprogress).toHaveBeenCalledTimes(1);
    expect(onprogress).toHaveBeenCalledWith({ progress: 1, total: 2, message: 'half' });
  });

  it('转发的 progressToken 与下游请求中的原值完全一致（字符串 token 亦然）', async () => {
    const { agent, guard, agentNotifications } = await setup({}, { call: reportsProgress });
    guard.check.mockResolvedValue(ALLOW);
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
    const { agent, guard, agentNotifications } = await setup({}, { call: reportsProgress });
    guard.check.mockResolvedValue(ALLOW);

    const result = await agent.callTool({ name: 'echo', arguments: {} });

    expect(textOf(result)).toBe('done');
    expect(agentNotifications).toEqual([]);
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
