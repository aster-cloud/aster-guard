import { describe, expect, it } from 'vitest';
import { GuardClient } from '../src/client.js';
import { buildToolAction, canonicalArgs, envelopeOf } from '../src/mcp/action-mapping.js';
import { CONSUME_TICKET_META_KEY, MemoryAttemptLedger, verifyConsumeTicket } from '../src/tool/index.js';
import type { GuardDecision } from '../src/types.js';
import { fakeApi } from './fixtures/fake-api.js';

// auth 隔离：工具侧 consume 票据核对（ADR 0054 §3.3，R66 D2 / D11 / D12）。

const MAPPING = { resourceFrom: 'paymentId', digestArgs: ['memo'] };
const ARGS = { paymentId: 'P-1', amount: 10, memo: 'x' };
const POLICY = { module: 'guard.test', function: 'decide' };

/**
 * 跑一次真实 run，在执行回调里截下代理会附带的票据并停在回调内（工具核对发生在执行期间、结果回写之前）；
 * done() 放行回调，run 随后回写 executed。
 */
async function issue(args: Record<string, unknown> = ARGS) {
  const api = fakeApi();
  const executor = new GuardClient(api.clientOptions());
  const action = buildToolAction({ toolName: 'refund', args: canonicalArgs(args), mapping: MAPPING, principal: { id: 'agent-42' } });
  let meta: Record<string, unknown> = {};
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let ready!: () => void;
  const captured = new Promise<void>((resolve) => (ready = resolve));
  const running = executor.run(action, async (grant) => {
    meta = { [CONSUME_TICKET_META_KEY]: { decisionId: grant.decisionId, attemptId: grant.attemptId, envelope: envelopeOf(action) } };
    ready();
    await released;
  }, { executorId: 'aster-guard-mcp@test' });
  await captured;
  const tool = new GuardClient(api.clientOptions({ apiKey: 'ak_tool' }));
  return {
    api,
    meta,
    tool,
    async done() {
      release();
      await running;
    },
  };
}

function check(ctx: Awaited<ReturnType<typeof issue>>, over: Partial<Parameters<typeof verifyConsumeTicket>[0]> = {}) {
  return verifyConsumeTicket({
    meta: ctx.meta,
    args: ARGS,
    toolName: 'refund',
    mapping: MAPPING,
    policy: POLICY,
    client: ctx.tool,
    ledger: new MemoryAttemptLedger(),
    ...over,
  });
}

/** 回读响应改写器：把 GET /decisions/{id} 的响应体换成 patch 后的形状。 */
function patchRead(ctx: Awaited<ReturnType<typeof issue>>, patch: (d: GuardDecision) => GuardDecision) {
  const original = ctx.tool;
  ctx.tool = new GuardClient(
    ctx.api.clientOptions({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await ctx.api.fetch(input, init);
        return new Response(JSON.stringify(patch(await res.json())), { status: res.status });
      },
    }),
  );
  void original;
}

describe('verifyConsumeTicket', () => {
  it('正例：票据正确 + 哈希相等 + attempt 相等 + 窗内 + 未写结果 + Guard 200', async () => {
    const ctx = await issue();
    expect(await check(ctx)).toMatchObject({ ok: true });
  });

  it('missing_ticket / malformed_ticket', async () => {
    const ctx = await issue();
    expect(await check(ctx, { meta: {} })).toEqual({ ok: false, reason: 'missing_ticket' });
    expect(await check(ctx, { meta: { [CONSUME_TICKET_META_KEY]: { decisionId: 'x' } } })).toEqual({ ok: false, reason: 'malformed_ticket' });
  });

  it('guard_unavailable：回读 5xx / 超时', async () => {
    const ctx = await issue();
    ctx.api.override((r) => (r.method === 'GET' ? new Response('', { status: 503 }) : undefined));
    expect(await check(ctx)).toEqual({ ok: false, reason: 'guard_unavailable' });
  });

  it('not_allowed：票据指向非 ALLOW 决策（或另一租户的决策回读 404）', async () => {
    const ctx = await issue();
    patchRead(ctx, (d) => ({ ...d, effectiveOutcome: 'DENY' }));
    expect(await check(ctx)).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('policy_mismatch：换策略模块取得的放行（#517）；旧 aster-api 无地址 → guard_unavailable', async () => {
    const ctx = await issue();
    expect(await check(ctx, { policy: { module: 'guard.lenient', function: 'decide' } })).toEqual({ ok: false, reason: 'policy_mismatch' });
    patchRead(ctx, ({ policyModule: _m, ...rest }) => (void _m, rest as GuardDecision));
    expect(await check(ctx)).toEqual({ ok: false, reason: 'guard_unavailable' });
  });

  it('action_mismatch：参数被改 / digest 字段被改 / envelope 动作名或资源与工具映射不符', async () => {
    const ctx = await issue();
    expect(await check(ctx, { args: { ...ARGS, amount: 11 } })).toEqual({ ok: false, reason: 'action_mismatch' });
    expect(await check(ctx, { args: { ...ARGS, memo: 'y' } })).toEqual({ ok: false, reason: 'action_mismatch' });
    const ticket = ctx.meta[CONSUME_TICKET_META_KEY] as { envelope: Record<string, unknown> };
    const renamed = { [CONSUME_TICKET_META_KEY]: { ...ticket, envelope: { ...ticket.envelope, action: { name: 'other' } } } };
    expect(await check(ctx, { meta: renamed })).toEqual({ ok: false, reason: 'action_mismatch' });
    expect(await check(ctx, { mapping: { digestArgs: ['memo'] } })).toEqual({ ok: false, reason: 'action_mismatch' });
  });

  it('attempt_mismatch：错 attemptId', async () => {
    const ctx = await issue();
    const ticket = ctx.meta[CONSUME_TICKET_META_KEY] as Record<string, unknown>;
    const meta = { [CONSUME_TICKET_META_KEY]: { ...ticket, attemptId: crypto.randomUUID() } };
    expect(await check(ctx, { meta })).toEqual({ ok: false, reason: 'attempt_mismatch' });
  });

  it('ticket_expired：consumedAt 超 ttl', async () => {
    const ctx = await issue();
    expect(await check(ctx, { now: () => Date.now() + 300_001 })).toEqual({ ok: false, reason: 'ticket_expired' });
  });

  it('result_recorded：已写结果的票据重放', async () => {
    const ctx = await issue();
    await ctx.done();
    expect(await check(ctx)).toEqual({ ok: false, reason: 'result_recorded' });
  });

  it('sameTicketTwiceConcurrentlyExecutesOnce 与 sameTicketAfterSuccessIsReplayed', async () => {
    const ctx = await issue();
    const ledger = new MemoryAttemptLedger();
    const both = await Promise.all([check(ctx, { ledger }), check(ctx, { ledger })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'ticket_replayed' }]);
    expect(await check(ctx, { ledger })).toEqual({ ok: false, reason: 'ticket_replayed' });
  });
});
