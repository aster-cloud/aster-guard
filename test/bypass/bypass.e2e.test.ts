import { describe, expect, it, vi } from 'vitest';
import { GuardClient } from '../../src/client.js';
import { hashAction } from '../../src/hash/jcs.js';
import { buildToolAction, canonicalArgs, envelopeOf } from '../../src/mcp/action-mapping.js';
import { MemoryAttemptLedger, verifyConsumeTicket, type TicketRejection } from '../../src/tool/index.js';
import type { ExecutionReceiptPayload } from '../../src/types.js';
import { fakeApi } from '../fixtures/fake-api.js';
import { E2E, env, guardClient, guardMeta, proxyRig, receiptsOf, SKIP_REASON } from './harness.js';

// 绕过夹具套件（ADR 0054 §7 夹具层；#466 的执行点部分）。每条同时断言 Guard 决策记录、sideEffects 无新增、
// 收据行（consumes / results）与之一致。#1（直连原始工具）只以部署层为准，不在本仓。

if (!E2E) console.warn(`[aster-guard bypass] 跳过夹具层：${SKIP_REASON}`);
const e2e = E2E ? describe : describe.skip;

async function consumedBy(decisionId: string) {
  return (await guardClient().get(decisionId)).consumedBy;
}

e2e('绕过夹具套件（本地 aster-api）', { timeout: 30_000 }, () => {
  it('#2 denyNotForwarded：规则 DENY → denied，无副作用，无 consume', async () => {
    const rig = await proxyRig();
    try {
      const result = await rig.agent.callTool({ name: 'refund_payment', arguments: { paymentId: 'P-1001', amount: 5000 } });
      const meta = guardMeta(result);
      expect(result.isError).toBe(true);
      expect(meta.status).toBe('denied');
      expect(rig.sideEffects).toEqual([]);
      expect(await consumedBy(String(meta.decisionId))).toBeUndefined();
      const receipts = await receiptsOf(String(meta.decisionId));
      expect(receipts).toEqual({ consumes: 0, results: 0 });
    } finally {
      await rig.close();
    }
  });

  it('#2b denyThenOtherToolAndRetry：每次调用独立决策；只有 ALLOW 的那次落地', async () => {
    const rig = await proxyRig();
    try {
      const denied = guardMeta(await rig.agent.callTool({ name: 'refund_payment', arguments: { paymentId: 'P-1', amount: 1 } }));
      const other = await rig.agent.callTool({ name: 'lookup_payment', arguments: { paymentId: 'P-1' } });
      const retried = guardMeta(
        await rig.agent.callTool({ name: 'refund_payment', arguments: { paymentId: 'P-1', amount: 1, approved: true } }),
      );
      const otherMeta = guardMeta(other);
      expect(denied.status).toBe('denied');
      expect(retried.status).toBe('denied');
      expect(other.isError).toBeFalsy();
      expect(new Set([denied.decisionId, retried.decisionId, otherMeta.decisionId]).size).toBe(3);
      expect(rig.sideEffects.map((s) => s.tool)).toEqual(['lookup_payment']);
      expect(await consumedBy(String(otherMeta.decisionId))).toMatchObject({ attemptId: otherMeta.attemptId });
    } finally {
      await rig.close();
    }
  });

  it('#3 mutateAfterAllowIs409：决策后、consume 前改参数 → action_mismatch，不转发、不消耗', async () => {
    const rig = await proxyRig({
      __beforeConsume: (args) => {
        args.to = 'attacker@evil.example';
      },
    });
    try {
      const result = guardMeta(await rig.agent.callTool({ name: 'send_email', arguments: { to: 'a@x', body: 'hi' } }));
      expect(result).toMatchObject({ status: 'blocked', reasonCode: 'action_mismatch' });
      expect(rig.sideEffects).toEqual([]);
      expect(await consumedBy(String(result.decisionId))).toBeUndefined();
    } finally {
      await rig.close();
    }
  });

  it('#3 cc 三例（null / 缺失 / ""）得到三个不同的 actionHash（真实决策回读）', async () => {
    const rig = await proxyRig();
    try {
      const hashes: string[] = [];
      for (const args of [{ to: 'a@x', cc: null }, { to: 'a@x' }, { to: 'a@x', cc: '' }]) {
        const meta = guardMeta(await rig.agent.callTool({ name: 'send_email', arguments: args }));
        hashes.push(String((await guardClient().get(String(meta.decisionId))).actionHash));
      }
      expect(new Set(hashes).size).toBe(3);
      expect(rig.sideEffects).toHaveLength(3);
    } finally {
      await rig.close();
    }
  });

  it('#4 replayConsumeIs409：低层 consume 重放 → receipt_consumed，副作用恰一条', async () => {
    const client = guardClient();
    const sideEffects: string[] = [];
    const action = { action: { name: 'lookup_payment' }, context: { paymentId: 'P-4' } };
    const outcome = await client.run(action, async (grant) => {
      sideEffects.push(grant.attemptId);
      return grant;
    }, { executorId: 'aster-guard-sdk@bypass-suite' });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind !== 'executed') return;
    const replay = await client.consume(outcome.decisionId, {
      actionHash: outcome.result.actionHash,
      attemptId: crypto.randomUUID(),
      executorId: 'aster-guard-sdk@bypass-suite',
    });
    expect(replay).toMatchObject({ ok: false, status: 409, error: 'receipt_consumed' });
    expect(sideEffects).toHaveLength(1);
    const receipts = await receiptsOf(outcome.decisionId);
    expect(receipts).toEqual({ consumes: 1, results: 1 });
  });

  describe('#1b authTicketChecks：工具侧票据核对（auth 隔离）', () => {
    const [module, fn] = env.policy.split('/');
    const POLICY = { module, function: fn };

    /** 工具侧：用自己的 GuardClient 核对票据，任一拒绝不落地副作用。 */
    function toolSide(rejections: TicketRejection[], ledger = new MemoryAttemptLedger(), policy = POLICY, client = guardClient()) {
      return async (tool: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) => {
        const verdict = await verifyConsumeTicket({ meta, args, toolName: tool, policy, client, ledger });
        if (verdict.ok) return undefined;
        rejections.push(verdict.reason);
        return { isError: true, content: [{ type: 'text' as const, text: `401 ${verdict.reason}` }] };
      };
    }

    it('正例：票据正确 → 执行一次', async () => {
      const rejections: TicketRejection[] = [];
      const rig = await proxyRig({ isolation: 'auth' }, toolSide(rejections));
      try {
        const result = await rig.agent.callTool({ name: 'lookup_payment', arguments: { paymentId: 'P-1b' } });
        expect(result.isError).toBeFalsy();
        expect(rejections).toEqual([]);
        expect(rig.sideEffects).toHaveLength(1);
      } finally {
        await rig.close();
      }
    });

    it('缺票据（不经代理直连上游）→ missing_ticket，无副作用', async () => {
      const rejections: TicketRejection[] = [];
      const rig = await proxyRig({ isolation: 'auth' }, toolSide(rejections));
      try {
        await rig.upstream.callTool({ name: 'lookup_payment', arguments: { paymentId: 'P-x' } });
        expect(rejections).toEqual(['missing_ticket']);
        expect(rig.sideEffects).toEqual([]);
      } finally {
        await rig.close();
      }
    });

    it('票据重放：执行期间并发两次只放行一次；执行后再用同一票据 → result_recorded / ticket_replayed', async () => {
      const rejections: TicketRejection[] = [];
      const ledger = new MemoryAttemptLedger();
      let captured: { args: Record<string, unknown>; meta: Record<string, unknown> | undefined } | undefined;
      const verify = toolSide(rejections, ledger);
      const rig = await proxyRig({ isolation: 'auth' }, async (tool, args, meta) => {
        captured ??= { args, meta };
        const [a, b] = await Promise.all([verify(tool, args, meta), verify(tool, args, meta)]);
        return a && b ? a : undefined;
      });
      try {
        await rig.agent.callTool({ name: 'lookup_payment', arguments: { paymentId: 'P-r' } });
        expect(rejections).toEqual(['ticket_replayed']);
        expect(rig.sideEffects).toHaveLength(1);
        rejections.length = 0;
        await rig.upstream.callTool({ name: 'lookup_payment', arguments: captured!.args, _meta: captured!.meta });
        expect(rejections[0]).toMatch(/^(result_recorded|ticket_replayed)$/);
        expect(rig.sideEffects).toHaveLength(1);
      } finally {
        await rig.close();
      }
    });

    it('错 attemptId / 参数被改 / 超 ttl / 另一租户 / Guard 不可达 / 期望策略不符 → 各自拒绝，无副作用', async () => {
      let ticketMeta: Record<string, unknown> | undefined;
      const rig = await proxyRig({ isolation: 'auth' }, async (_tool, _args, meta) => {
        ticketMeta = meta;
        return undefined;
      });
      try {
        await rig.agent.callTool({ name: 'lookup_payment', arguments: { paymentId: 'P-z' } });
        const ticket = ticketMeta!['io.aster/guard-consume'] as Record<string, unknown>;
        const args = { paymentId: 'P-z' };
        const base = { toolName: 'lookup_payment', policy: POLICY, client: guardClient(), ledger: new MemoryAttemptLedger() };
        const cases: Array<[TicketRejection, Parameters<typeof verifyConsumeTicket>[0]]> = [
          ['attempt_mismatch', { ...base, args, meta: { 'io.aster/guard-consume': { ...ticket, attemptId: crypto.randomUUID() } } }],
          ['action_mismatch', { ...base, args: { paymentId: 'P-other' }, meta: ticketMeta }],
          ['ticket_expired', { ...base, args, meta: ticketMeta, now: () => Date.now() + 600_000 }],
          ['guard_unavailable', { ...base, args, meta: ticketMeta, client: guardClient({ baseUrl: 'http://127.0.0.1:9' }) }],
          ['policy_mismatch', { ...base, args, meta: ticketMeta, policy: { module: 'guard.other', function: 'decide' } }],
        ];
        if (env.extraHeaders['X-Tenant-Id']) {
          cases.push(['guard_unavailable', { ...base, args, meta: ticketMeta, client: guardClient({ headers: { 'X-Tenant-Id': 'other-tenant' } }) }]);
        }
        for (const [expected, input] of cases) {
          expect(await verifyConsumeTicket(input), expected).toEqual({ ok: false, reason: expected });
        }
        // 结果已回写：再核对同一票据 → result_recorded
        expect(await verifyConsumeTicket({ ...base, args, meta: ticketMeta })).toEqual({ ok: false, reason: 'result_recorded' });
      } finally {
        await rig.close();
      }
    });

    it.skipIf(!env.lenientPolicy)('#517 换策略模块取得的 ALLOW 被工具侧拒绝（policy_mismatch）', async () => {
      const lenient = guardClient({ policy: env.lenientPolicy });
      const args = canonicalArgs({ paymentId: 'P-517', amount: 9999 });
      const action = buildToolAction({ toolName: 'refund_payment', args, principal: { id: 'bypass-agent', type: 'agent' } });
      let verdict: Awaited<ReturnType<typeof verifyConsumeTicket>> | undefined;
      const outcome = await lenient.run(action, async (grant) => {
        verdict = await verifyConsumeTicket({
          meta: { 'io.aster/guard-consume': { decisionId: grant.decisionId, attemptId: grant.attemptId, envelope: envelopeOf(action) } },
          args,
          toolName: 'refund_payment',
          policy: POLICY,
          client: guardClient(),
          ledger: new MemoryAttemptLedger(),
        });
      }, { executorId: 'direct-caller@bypass-suite' });
      expect(outcome.kind).toBe('executed');
      expect(verdict).toEqual({ ok: false, reason: 'policy_mismatch' });
    });
  });
});

e2e('#8 B8 换策略模块另取 ALLOW 收据（#517，ADR 0040 §13 R68；本地 aster-api）', { timeout: 30_000 }, () => {
  const action = { action: { name: 'refund_payment' }, resource: { type: 'payment', id: 'P-B8' }, context: { amount: 250000 } };

  /** 执行方期望的严格策略 DENY；同一动作换到同租户宽松模块 ALLOW，actionHash 相同，签名覆盖的是宽松模块的地址。 */
  async function switchedAllow() {
    const strict = await guardClient().check(action);
    expect(strict.effectiveOutcome).toBe('DENY');
    expect(strict.executionReceipt).toBeUndefined();
    const switched = await guardClient({ policy: env.lenientPolicy }).check(action);
    expect(switched.effectiveOutcome).toBe('ALLOW');
    const [module, fn] = env.lenientPolicy!.split('/');
    expect(switched.executionReceipt?.payload).toMatchObject({ policyModule: module, policyFunction: fn, v: 1 });
    return switched;
  }

  const expectOf = (d: Awaited<ReturnType<typeof switchedAllow>>) => ({
    decisionId: d.decisionId,
    actionHash: hashAction({ ...action, principal: { id: 'bypass-agent', type: 'agent' } }),
    policyVersionId: d.policyVersion?.id,
  });

  it.skipIf(!env.lenientPolicy)('换模块的收据被期望严格策略的执行方本地拒绝 policy_mismatch，未 consume', async () => {
    const switched = await switchedAllow();
    expect(switched.executionReceipt?.payload.actionHash).toBe(expectOf(switched).actionHash);
    expect(await guardClient().verifyReceipt(switched.executionReceipt, expectOf(switched))).toEqual({
      ok: false,
      reasonCode: 'receipt_invalid',
      detail: 'policy_mismatch',
    });
    expect(await consumedBy(switched.decisionId)).toBeUndefined();
  });

  it.skipIf(!env.lenientPolicy)('把签名载荷的地址改写成期望模块 → bad_signature，未 consume', async () => {
    const switched = await switchedAllow();
    const [module] = env.policy.split('/');
    const receipt = switched.executionReceipt!;
    const forged = { ...receipt, payload: { ...receipt.payload, policyModule: module } };
    expect(await guardClient().verifyReceipt(forged, expectOf(switched))).toEqual({
      ok: false,
      reasonCode: 'receipt_invalid',
      detail: 'bad_signature',
    });
    expect(await consumedBy(switched.decisionId)).toBeUndefined();
  });
});

describe('#8 B8 换策略模块另取 ALLOW 收据（#517，mock /decisions，始终启用）', () => {
  // 假 API 按请求体的 policyModule 签地址：严格模块 DENY、宽松模块 ALLOW。决策请求在线上被改投到宽松模块
  // （直连调用方 / 被篡改的网关），执行方拿到签名有效、actionHash 相同的 ALLOW——只有核对签名覆盖的地址才能拒绝。
  const STRICT = 'guard.strict';
  const LENIENT = 'guard.lenient';
  const INPUT_B8 = { action: { name: 'refund_payment' }, resource: { type: 'payment', id: 'P-B8' }, context: { amount: 250000 } };

  function rig(rewrite?: (p: ExecutionReceiptPayload) => ExecutionReceiptPayload) {
    const api = fakeApi();
    api.override((req) => {
      if (req.method !== 'POST' || req.path !== '/api/v1/guard/decisions') return undefined;
      const body = req.body as { policyModule: string };
      api.script(body.policyModule === STRICT ? 'DENY' : 'ALLOW');
      return undefined;
    });
    if (rewrite) api.mutateReceipts((r) => ({ ...r, payload: rewrite(r.payload) }));
    const switchModule: typeof fetch = (input, init) => {
      if (String(input).endsWith('/api/v1/guard/decisions') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return api.fetch(input, { ...init, body: JSON.stringify({ ...body, policyModule: LENIENT }) });
      }
      return api.fetch(input, init);
    };
    const sideEffects: string[] = [];
    const execute = async (grant: { attemptId: string }) => void sideEffects.push(grant.attemptId);
    const strictExecutor = new GuardClient(api.clientOptions({ policyModule: STRICT, fetch: switchModule }));
    return { api, sideEffects, execute, strictExecutor };
  }

  it('换模块取得的 ALLOW：执行方 policy_mismatch，不 consume、无副作用', async () => {
    const { api, sideEffects, execute, strictExecutor } = rig();
    const outcome = await strictExecutor.run(INPUT_B8, execute, { executorId: 'x@y' });
    expect(api.decisions.values().next().value?.response.executionReceipt?.payload.policyModule).toBe(LENIENT);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid', reason: expect.stringContaining('policy_mismatch') } });
    expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
    expect(sideEffects).toEqual([]);
  });

  it('把载荷地址改写成期望模块 → bad_signature，不 consume、无副作用', async () => {
    const { api, sideEffects, execute, strictExecutor } = rig((p) => ({ ...p, policyModule: STRICT }));
    const outcome = await strictExecutor.run(INPUT_B8, execute, { executorId: 'x@y' });
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid', reason: expect.stringContaining('bad_signature') } });
    expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
    expect(sideEffects).toEqual([]);
  });

  it('正向对照：出自期望模块的收据照常执行恰一次', async () => {
    const api = fakeApi();
    const sideEffects: string[] = [];
    const outcome = await new GuardClient(api.clientOptions({ policyModule: LENIENT })).run(
      INPUT_B8,
      async (grant) => void sideEffects.push(grant.attemptId),
      { executorId: 'x@y' },
    );
    expect(outcome.kind).toBe('executed');
    expect(sideEffects).toHaveLength(1);
    expect(api.sequence().filter((s) => s.endsWith('/consume'))).toHaveLength(1);
  });
});

/** 翻转解码后签名的首字节：必然改变签名字节（改尾部字符可能只动到 base64url 的填充位，解码结果不变）。 */
function flipFirstSignatureByte(signature: string): string {
  const bytes = Buffer.from(signature, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString('base64url');
}

/** 同一签名字节的非规范编码：末字符只承载 2 位有效数据，置位其余 4 个填充位，解码结果与原签名相同。 */
function nonCanonicalSignature(signature: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(signature.slice(-1));
  return `${signature.slice(0, -1)}${alphabet[last | 0b1111]}`;
}

describe('#5 forgedOrExpiredReceiptNeverConsumed（mock /decisions，始终启用）', () => {
  it.each([
    ['篡改签名', (r: { signature: string }) => ({ ...r, signature: flipFirstSignatureByte(r.signature) })],
    ['非规范签名编码', (r: { signature: string }) => ({ ...r, signature: nonCanonicalSignature(r.signature) })],
    ['篡改 actionHash', (r: { payload: object }) => ({ ...r, payload: { ...r.payload, actionHash: '0'.repeat(64) } })],
    ['已过期', (r: { payload: object }) => ({ ...r, payload: { ...r.payload, expiresAt: '2000-01-01T00:00:00Z' } })],
  ])('%s → 不 consume、不执行', async (_name, mutate) => {
    const api = fakeApi();
    api.mutateReceipts(mutate as never);
    const execute = vi.fn();
    const outcome = await new GuardClient(api.clientOptions()).run({ action: { name: 'refund_payment' } }, execute, {
      executorId: 'x@y',
    });
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid' } });
    expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
