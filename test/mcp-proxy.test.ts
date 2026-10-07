import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardProxyServer, type GuardClientLike, type GuardProxyOptions } from '../src/mcp/proxy.js';
import type { GuardDecision } from '../src/types.js';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mockGuard() {
  return {
    check: vi.fn<GuardClientLike['check']>(),
    get: vi.fn<GuardClientLike['get']>(),
    waitFor: vi.fn<GuardClientLike['waitFor']>(),
    listApprovals: vi.fn<GuardClientLike['listApprovals']>(),
    approve: vi.fn<GuardClientLike['approve']>(),
    reject: vi.fn<GuardClientLike['reject']>(),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** 搭起完整链路；返回 agent 侧 Client、mock guard 与「上游收到的 tools/call」记录。 */
async function setup(options: Partial<Omit<GuardProxyOptions, 'client' | 'upstream'>> = {}) {
  const upstreamCalls = vi.fn<(params: { name: string; arguments?: Record<string, unknown> }) => void>();
  const fakeUpstream = new Server({ name: 'fake-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
  fakeUpstream.setRequestHandler(ListToolsRequestSchema, () => ({ tools: UPSTREAM_TOOLS }));
  fakeUpstream.setRequestHandler(CallToolRequestSchema, (request) => {
    upstreamCalls(request.params);
    return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }] };
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

  cleanups.push(async () => {
    await agent.close();
    await proxy.close();
    await fakeUpstream.close();
  });
  return { agent, guard, upstreamCalls };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return content[0].text ?? '';
}

describe('aster-guard-mcp 代理：tools/list', () => {
  it('原样透传上游工具列表', async () => {
    const { agent, guard } = await setup();
    const { tools } = await agent.listTools();
    expect(tools).toEqual(UPSTREAM_TOOLS);
    expect(guard.check).not.toHaveBeenCalled();
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

    expect(guard.waitFor).toHaveBeenCalledWith('d-3', { timeoutMs: 1_234 });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('{"text":"later"}');
    expect(upstreamCalls).toHaveBeenCalledTimes(1);
  });

  it('approvalTimeoutMs 缺省为 300000', async () => {
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue(PENDING);
    guard.waitFor.mockResolvedValue({ ...ALLOW, decisionId: 'd-3' });

    await agent.callTool({ name: 'echo', arguments: {} });

    expect(guard.waitFor).toHaveBeenCalledWith('d-3', { timeoutMs: 300_000 });
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
    controller.abort('agent gave up');
    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    release({ ...ALLOW, decisionId: 'd-3' });
    await new Promise((resolve) => setTimeout(resolve, 10));

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

  it('未配置 resourceFromArg、参数缺失或为 null 时不带 resource；无参数时 context 为 {}', async () => {
    const { agent, guard } = await setup({ resourceFromArg: 'customerId' });
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({ name: 'echo', arguments: { customerId: null } });
    await agent.callTool({ name: 'echo' });

    const [first] = guard.check.mock.calls[0];
    const [second] = guard.check.mock.calls[1];
    expect(first.resource).toBeUndefined();
    expect(first.agent).toBeUndefined();
    expect(first.context).toEqual({ customerId: null });
    expect(second.resource).toBeUndefined();
    expect(second.context).toEqual({});
  });

  it('每次调用使用新的幂等键（不从 JSON-RPC id 派生）', async () => {
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({ name: 'echo', arguments: { text: 'same' } });
    await agent.callTool({ name: 'echo', arguments: { text: 'same' } });

    const keys = guard.check.mock.calls.map(([, opts]) => opts?.idempotencyKey);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toMatch(UUID);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('createGuardProxyServer 参数校验', () => {
  it('approvalTimeoutMs 非法属于编程错误，构造时抛出', () => {
    expect(() =>
      createGuardProxyServer({ client: mockGuard() as unknown as GuardClientLike, principal: PRINCIPAL, approvalTimeoutMs: -1 }),
    ).toThrow(TypeError);
  });
});
