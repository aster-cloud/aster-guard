import { describe, expect, it } from 'vitest';
import { GuardClient } from '../src/client.js';
import type { GuardSideEffect } from '../src/types.js';
import { fakeApi } from './fixtures/fake-api.js';

// reportSideEffects 与 aster-api 已合并的 #465 契约（ADR 0054 §10.2，SideEffectReport / GuardSideEffectResource）对齐：
// POST /api/v1/guard/side-effects，体 { effects: [...] }，200 { accepted, duplicates }；400 invalid_side_effect 不抛异常。

const EFFECT: GuardSideEffect = {
  effectId: 'refund-row-42',
  source: 'billing-db',
  occurredAt: '2026-11-15T00:00:00Z',
  action: { name: 'refund_payment' },
  resource: { type: 'payment', id: 'P-1' },
  decisionId: '3f1c2a4e-0000-4000-8000-000000000001',
  attemptId: '3f1c2a4e-0000-4000-8000-000000000002',
  actionHash: 'a'.repeat(64),
};

describe('GuardClient.reportSideEffects', () => {
  it('按契约发送并解析 { accepted, duplicates }', async () => {
    const api = fakeApi();
    api.override((req) =>
      req.path === '/api/v1/guard/side-effects' ? new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), { status: 200 }) : undefined,
    );
    const result = await new GuardClient(api.clientOptions()).reportSideEffects([EFFECT]);
    expect(result).toEqual({ ok: true, accepted: 1, duplicates: 0 });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: 'POST', path: '/api/v1/guard/side-effects', body: { effects: [EFFECT] } });
    expect(api.requests[0].headers.Authorization).toBe('Bearer ak_test');
  });

  it('400 invalid_side_effect → { ok: false }，不抛', async () => {
    const api = fakeApi();
    api.override(() => new Response(JSON.stringify({ error: 'invalid_side_effect', index: 0, field: 'source' }), { status: 400 }));
    const result = await new GuardClient(api.clientOptions()).reportSideEffects([{ ...EFFECT, source: 'Bad Source' }]);
    expect(result).toMatchObject({ ok: false, status: 400, error: 'invalid_side_effect' });
  });
});
