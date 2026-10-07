import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardProxyServer, type GuardClientLike } from '../src/mcp/proxy.js';
import type { GuardDecision } from '../src/types.js';

// 无上游时的五个治理工具：一一对应 GuardClient 方法，结果以 JSON 文本返回（ADR 0040 §6）。

const PRINCIPAL = { id: 'agent-42', type: 'agent' };

const ALLOW: GuardDecision = { decisionId: 'd-1', outcome: 'ALLOW', effectiveOutcome: 'ALLOW' };
const DENY: GuardDecision = { decisionId: 'd-2', outcome: 'DENY', effectiveOutcome: 'DENY', reasonCode: 'policy_denied' };

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

async function setup(agentModel?: string) {
  const guard = mockGuard();
  const proxy = createGuardProxyServer({ client: guard as unknown as GuardClientLike, principal: PRINCIPAL, agentModel });
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(proxySide);
  const agent = new Client({ name: 'agent', version: '0.0.0' });
  await agent.connect(agentSide);
  cleanups.push(async () => {
    await agent.close();
    await proxy.close();
  });
  return { agent, guard };
}

/** 取唯一一段文本内容。 */
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return content[0].text ?? '';
}

describe('治理工具：tools/list', () => {
  it('无上游时列出五个工具，inputSchema 为 object 型 JSON Schema', async () => {
    const { agent } = await setup();
    const { tools } = await agent.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      'guard_check',
      'guard_status',
      'guard_list_approvals',
      'guard_approve',
      'guard_reject',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    const reject = tools.find((t) => t.name === 'guard_reject');
    expect(reject?.inputSchema.required).toEqual(['approvalId', 'comment']);
  });
});

describe('治理工具：guard_check', () => {
  it('调用 client.check（principal 与 agent 来自配置）并以 JSON 文本返回决策', async () => {
    const { agent, guard } = await setup('claude-x');
    guard.check.mockResolvedValue(ALLOW);

    const result = await agent.callTool({
      name: 'guard_check',
      arguments: {
        action: { name: 'delete_customer_record' },
        resource: { type: 'customer', id: 'C-1001' },
        context: { amount: 250000 },
        waitSeconds: 5,
      },
    });

    expect(guard.check).toHaveBeenCalledWith(
      {
        principal: PRINCIPAL,
        action: { name: 'delete_customer_record' },
        resource: { type: 'customer', id: 'C-1001' },
        context: { amount: 250000 },
        agent: { model: 'claude-x' },
      },
      { waitSeconds: 5 },
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual(ALLOW);
    expect(textOf(result)).toBe(JSON.stringify(ALLOW, null, 2));
  });

  it('参数中的 principal 被忽略：主体只来自配置', async () => {
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue(ALLOW);

    await agent.callTool({
      name: 'guard_check',
      arguments: { action: { name: 'x' }, principal: { id: 'someone-else' } },
    });

    expect(guard.check.mock.calls[0][0].principal).toEqual(PRINCIPAL);
  });

  it('DENY → isError', async () => {
    const { agent, guard } = await setup();
    guard.check.mockResolvedValue(DENY);

    const result = await agent.callTool({ name: 'guard_check', arguments: { action: { name: 'x' } } });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual(DENY);
  });

  it('参数不合 schema → isError，不调用 client', async () => {
    const { agent, guard } = await setup();

    const result = await agent.callTool({ name: 'guard_check', arguments: { action: {} } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Invalid arguments for guard_check/);
    expect(guard.check).not.toHaveBeenCalled();
  });
});

describe('治理工具：guard_status / guard_list_approvals', () => {
  it('guard_status 调用 client.get；DENY → isError', async () => {
    const { agent, guard } = await setup();
    guard.get.mockResolvedValueOnce(ALLOW).mockResolvedValueOnce(DENY);

    const ok = await agent.callTool({ name: 'guard_status', arguments: { decisionId: 'd-1' } });
    const denied = await agent.callTool({ name: 'guard_status', arguments: { decisionId: 'd-2' } });

    expect(guard.get).toHaveBeenNthCalledWith(1, 'd-1');
    expect(guard.get).toHaveBeenNthCalledWith(2, 'd-2');
    expect(ok.isError).toBeFalsy();
    expect(denied.isError).toBe(true);
  });

  it('guard_list_approvals 缺省参数沿用 client 的默认值；ok:false → isError', async () => {
    const { agent, guard } = await setup();
    const page = { ok: true as const, items: [], page: 0, size: 20 };
    guard.listApprovals
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ ok: false, status: 401, error: 'unauthorized', message: 'bad key' });

    const ok = await agent.callTool({ name: 'guard_list_approvals', arguments: {} });
    const failed = await agent.callTool({
      name: 'guard_list_approvals',
      arguments: { status: 'APPROVED', page: 2, size: 50 },
    });

    expect(guard.listApprovals).toHaveBeenNthCalledWith(1, undefined, undefined, undefined);
    expect(guard.listApprovals).toHaveBeenNthCalledWith(2, 'APPROVED', 2, 50);
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(textOf(ok))).toEqual(page);
    expect(failed.isError).toBe(true);
  });
});

describe('治理工具：guard_approve / guard_reject', () => {
  it('guard_approve 调用 client.approve；ok:false → isError', async () => {
    const { agent, guard } = await setup();
    guard.approve
      .mockResolvedValueOnce({ ok: true, decision: ALLOW })
      .mockResolvedValueOnce({ ok: false, status: 403, error: 'segregation_of_duties', message: 'same key' });

    const ok = await agent.callTool({
      name: 'guard_approve',
      arguments: { approvalId: 'a-1', comment: 'looks fine', businessRole: 'DPO' },
    });
    const failed = await agent.callTool({ name: 'guard_approve', arguments: { approvalId: 'a-2' } });

    expect(guard.approve).toHaveBeenNthCalledWith(1, 'a-1', { comment: 'looks fine', businessRole: 'DPO' });
    expect(guard.approve).toHaveBeenNthCalledWith(2, 'a-2', {});
    expect(ok.isError).toBeFalsy();
    expect(failed.isError).toBe(true);
    expect(JSON.parse(textOf(failed))).toMatchObject({ ok: false, error: 'segregation_of_duties' });
  });

  it('guard_reject 调用 client.reject', async () => {
    const { agent, guard } = await setup();
    guard.reject.mockResolvedValue({ ok: true, decision: DENY });

    const result = await agent.callTool({
      name: 'guard_reject',
      arguments: { approvalId: 'a-1', comment: 'not allowed' },
    });

    expect(guard.reject).toHaveBeenCalledWith('a-1', { comment: 'not allowed' });
    expect(result.isError).toBeFalsy();
  });

  it('guard_reject 缺 comment → isError，不调用 client', async () => {
    const { agent, guard } = await setup();

    const result = await agent.callTool({ name: 'guard_reject', arguments: { approvalId: 'a-1' } });

    expect(result.isError).toBe(true);
    expect(guard.reject).not.toHaveBeenCalled();
  });
});

describe('治理工具：未知工具', () => {
  it('→ MCP 错误', async () => {
    const { agent } = await setup();
    await expect(agent.callTool({ name: 'echo', arguments: {} })).rejects.toThrow(/Unknown tool: echo/);
  });
});
