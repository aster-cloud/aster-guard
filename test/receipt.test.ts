import { describe, expect, it } from 'vitest';
import { hashAction } from '../src/hash/jcs.js';
import { JwksCache, verifyExecutionReceipt } from '../src/receipt.js';
import type { ExecutionReceipt, ExecutionReceiptPayload, GuardJwk } from '../src/types.js';
import { signReceipt, testKey } from './fixtures/fake-api.js';

// 执行收据离线验签（ADR 0040 §12 D6）、D12 策略版本绑定（ADR 0054 §11.3）与签名覆盖的策略地址（ADR 0040 §13 R68）。

const T0 = Date.parse('2026-11-14T10:00:00Z');
const ACTION_HASH = hashAction({ principal: { id: 'p' }, action: { name: 'refund' } });
const key = testKey('k-1');

function payload(extra: Partial<ExecutionReceiptPayload> = {}): ExecutionReceiptPayload {
  return {
    actionHash: ACTION_HASH,
    decisionId: 'd-1',
    expiresAt: new Date(T0 + 300_000).toISOString(),
    issuedAt: new Date(T0).toISOString(),
    kid: 'k-1',
    outcome: 'ALLOW',
    policyFunction: 'decide',
    policyModule: 'guard.strict',
    policyVersionId: 7,
    tenantId: 't-1',
    v: 1,
    ...extra,
  };
}

function harness(keys: GuardJwk[] = [key.jwk], clock = { t: T0 }) {
  let fetches = 0;
  let fail = false;
  const cache = new JwksCache(async () => {
    fetches++;
    return fail ? undefined : { revision: 1, keys };
  }, () => clock.t);
  const expect0 = {
    tenantId: 't-1',
    decisionId: 'd-1',
    actionHash: ACTION_HASH,
    policy: { module: 'guard.strict', function: 'decide' },
    policyVersionId: 7 as number | undefined,
  };
  return {
    cache,
    clock,
    fetches: () => fetches,
    failFetch: () => (fail = true),
    verify: (r: unknown, e = expect0) => verifyExecutionReceipt(r, e, cache, () => clock.t),
    expect0,
  };
}

const ok = { ok: true };
const bad = (detail: string) => ({ ok: false, reasonCode: 'receipt_invalid', detail });

describe('verifyExecutionReceipt', () => {
  it('validReceiptVerifies', async () => {
    expect(await harness().verify(signReceipt(payload(), key.privateKey))).toEqual(ok);
  });

  it('anyPayloadByteChangeFails：逐字段改动', async () => {
    const h = harness();
    const good = signReceipt(payload(), key.privateKey);
    const tampered: Array<Partial<ExecutionReceiptPayload>> = [
      { actionHash: '0'.repeat(64) },
      { decisionId: 'd-2' },
      { expiresAt: new Date(T0 + 600_000).toISOString() },
      { issuedAt: new Date(T0 + 1).toISOString() },
      { policyVersionId: 8 },
      { tenantId: 't-2' },
      { policyModule: 'guard.strict2' },
      { policyFunction: 'decide2' },
    ];
    for (const change of tampered) {
      const r: ExecutionReceipt = { ...good, payload: { ...good.payload, ...change } };
      expect(await h.verify(r), JSON.stringify(change)).toEqual(bad('bad_signature'));
    }
  });

  it('swappedSignatureFails', async () => {
    const other = signReceipt(payload({ decisionId: 'd-9' }), key.privateKey);
    const r = { ...signReceipt(payload(), key.privateKey), signature: other.signature };
    expect(await harness().verify(r)).toEqual(bad('bad_signature'));
  });

  it('unknownKidRefreshesOnceThenFails', async () => {
    const h = harness();
    const stranger = testKey('k-x');
    const r = signReceipt(payload({ kid: 'k-x' }), stranger.privateKey);
    expect(await h.verify(r)).toEqual(bad('kid_unknown'));
    expect(h.fetches()).toBe(2);
  });

  it('windowIsIssuedAtMinus60InclusiveToExpiresAtExclusive', async () => {
    const r = signReceipt(payload(), key.privateKey);
    const h = harness();
    h.clock.t = T0 - 60_000;
    expect(await h.verify(r)).toEqual(ok);
    h.clock.t = T0 - 60_001;
    expect(await h.verify(r)).toEqual(bad('outside_window'));
    h.clock.t = T0 + 300_000;
    expect(await h.verify(r)).toEqual(bad('outside_window'));
  });

  it('tenantDecisionOutcomeActionHashPolicyEachChecked', async () => {
    const h = harness();
    const r = signReceipt(payload(), key.privateKey);
    expect(await h.verify(r, { ...h.expect0, tenantId: 't-2' })).toEqual(bad('tenant_mismatch'));
    expect(await h.verify(r, { ...h.expect0, decisionId: 'd-2' })).toEqual(bad('decision_mismatch'));
    expect(await h.verify(r, { ...h.expect0, actionHash: '1'.repeat(64) })).toEqual(bad('action_hash_mismatch'));
    expect(await h.verify(r, { ...h.expect0, policyVersionId: 8 })).toEqual(bad('policy_mismatch'));
    expect(await h.verify(r, { ...h.expect0, policyVersionId: undefined })).toEqual(bad('policy_mismatch'));
    const deny = signReceipt({ ...payload(), outcome: 'DENY' as 'ALLOW' }, key.privateKey);
    expect(await h.verify(deny)).toEqual(bad('not_allow'));
  });

  it('receiptWithoutPolicyVersionIdIsPolicyMismatch（#517：收据必须绑定期望策略）', async () => {
    const { policyVersionId: _omit, ...rest } = payload();
    void _omit;
    const r = signReceipt(rest as ExecutionReceiptPayload, key.privateKey);
    expect(await harness().verify(r)).toEqual(bad('policy_mismatch'));
  });

  describe('R68 签名覆盖的策略地址（#517）', () => {
    it('地址与期望一致 → 通过', async () => {
      expect(await harness().verify(signReceipt(payload(), key.privateKey))).toEqual(ok);
    });

    it.each([
      ['模块不同', { policyModule: 'guard.lenient' }],
      ['函数不同', { policyFunction: 'decideLenient' }],
      ['大小写不同', { policyModule: 'Guard.Strict' }],
      ['空串', { policyModule: '' }],
    ])('签名有效但%s → policy_mismatch', async (_name, change) => {
      const r = signReceipt(payload(change), key.privateKey);
      expect(await harness().verify(r)).toEqual(bad('policy_mismatch'));
    });

    it.each(['policyModule', 'policyFunction'] as const)('缺 %s（R68 之前的 aster-api 签发）→ policy_mismatch，fail-closed', async (k) => {
      const { [k]: _omit, ...rest } = payload();
      void _omit;
      const r = signReceipt(rest as ExecutionReceiptPayload, key.privateKey);
      expect(await harness().verify(r)).toEqual(bad('policy_mismatch'));
    });

    it('两键都缺 → policy_mismatch', async () => {
      const { policyModule: _m, policyFunction: _f, ...rest } = payload();
      void _m;
      void _f;
      expect(await harness().verify(signReceipt(rest as ExecutionReceiptPayload, key.privateKey))).toEqual(bad('policy_mismatch'));
    });

    it('签名后把地址改成期望值（换模块收据冒充）→ bad_signature', async () => {
      const lenient = signReceipt(payload({ policyModule: 'guard.lenient' }), key.privateKey);
      const forged = { ...lenient, payload: { ...lenient.payload, policyModule: 'guard.strict' } };
      expect(await harness().verify(forged)).toEqual(bad('bad_signature'));
    });

    it('签名后删掉地址键 → bad_signature（不会落成 policy_mismatch 以外的放行）', async () => {
      const good = signReceipt(payload(), key.privateKey);
      const { policyModule: _m, ...stripped } = good.payload;
      void _m;
      expect(await harness().verify({ ...good, payload: stripped })).toEqual(bad('bad_signature'));
    });

    it('地址键不是字符串 → malformed', async () => {
      const r = signReceipt({ ...payload(), policyModule: 7 as unknown as string }, key.privateKey);
      expect(await harness().verify(r)).toEqual(bad('malformed'));
    });

    it('地址一致但 policyVersionId 不符 → 仍 policy_mismatch（R66 核对保留）', async () => {
      const h = harness();
      const r = signReceipt(payload(), key.privateKey);
      expect(await h.verify(r, { ...h.expect0, policyVersionId: 8 })).toEqual(bad('policy_mismatch'));
    });
  });

  it('malformed：外层 kid 与 payload.kid 不同 / 缺字段', async () => {
    const r = signReceipt(payload(), key.privateKey);
    expect(await harness().verify({ ...r, kid: 'k-2' })).toEqual(bad('malformed'));
    expect(await harness().verify(undefined)).toEqual(bad('malformed'));
    expect(await harness().verify({ ...r, signature: 'not base64!' })).toEqual(bad('malformed'));
  });

  it('keysFetchFailureIsKeysUnavailable', async () => {
    const h = harness();
    h.failFetch();
    expect(await h.verify(signReceipt(payload(), key.privateKey))).toEqual(bad('keys_unavailable'));
  });

  it('cacheHonours300s 与强制刷新 60 s 节流', async () => {
    const h = harness();
    const r = signReceipt(payload(), key.privateKey);
    await h.verify(r);
    await h.verify(r);
    expect(h.fetches()).toBe(1);
    h.clock.t += 300_000;
    await h.verify(signReceipt(payload({ issuedAt: new Date(h.clock.t).toISOString(), expiresAt: new Date(h.clock.t + 1000).toISOString() }), key.privateKey));
    expect(h.fetches()).toBe(2);
    expect(await h.cache.forceRefresh()).toBe('refreshed');
    expect(await h.cache.forceRefresh()).toBe('throttled');
    await h.cache.noteRevision(99);
    expect(h.fetches()).toBe(3);
    h.clock.t += 60_000;
    await h.cache.noteRevision(99);
    expect(h.fetches()).toBe(4);
    await h.cache.noteRevision(1);
    expect(h.fetches()).toBe(4);
  });
});
