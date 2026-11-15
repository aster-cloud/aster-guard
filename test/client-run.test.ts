import { describe, expect, it, vi } from 'vitest';
import { GuardClient } from '../src/client.js';
import { hashAction } from '../src/hash/jcs.js';
import type { GuardAction, GuardRunOptions } from '../src/types.js';
import { fakeApi } from './fixtures/fake-api.js';

// GuardClient.run 固定顺序「决策 → 验签 → consume → 执行 → 回写」（ADR 0054 §2.1）。

const INPUT = { action: { name: 'refund_payment' }, resource: { type: 'payment', id: 'P-1' }, context: { amount: 5000, note: null } };
const EXEC = { executorId: 'billing-worker@pod-3' };

function setup(extra: Record<string, unknown> = {}) {
  const api = fakeApi();
  const client = new GuardClient(api.clientOptions(extra));
  return { api, client };
}

function bodyOf(api: ReturnType<typeof fakeApi>, suffix: string): Record<string, unknown> {
  const req = api.requests.find((r) => r.path.endsWith(suffix));
  return req?.body as Record<string, unknown>;
}

describe('GuardClient.run', () => {
  it('orderIsDecideVerifyConsumeExecuteResult', async () => {
    const { api, client } = setup();
    const calls: string[] = [];
    const outcome = await client.run(INPUT, async (grant) => {
      calls.push(`execute ${grant.decisionId}`);
      return 'done';
    }, EXEC);
    expect(outcome.kind).toBe('executed');
    expect(api.sequence()).toEqual([
      'POST /api/v1/guard/decisions',
      'GET /api/v1/guard/keys',
      'POST /api/v1/guard/receipts/{id}/consume',
      'POST /api/v1/guard/receipts/{id}/result',
    ]);
    expect(calls).toHaveLength(1);
    const result = bodyOf(api, '/result');
    expect(result).toMatchObject({ status: 'executed', executorId: EXEC.executorId });
  });

  it('hashedActionIsTheSentAction：principal 由配置补齐、null 保留', async () => {
    const { api, client } = setup();
    await client.run(INPUT, async () => 1, EXEC);
    const sent = (bodyOf(api, '/decisions') as { action: GuardAction }).action;
    expect(sent.principal).toEqual({ id: 'agent-42', type: 'agent' });
    expect(sent.context).toEqual({ amount: 5000, note: null });
    expect(bodyOf(api, '/consume').actionHash).toBe(hashAction(sent));
  });

  it('denyNeverCallsExecuteOrConsume', async () => {
    const { api, client } = setup();
    api.script('DENY');
    const execute = vi.fn();
    const outcome = await client.run(INPUT, execute, EXEC);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { effectiveOutcome: 'DENY', ruleId: 'R-DENY' } });
    expect(execute).not.toHaveBeenCalled();
    expect(api.sequence()).toEqual(['POST /api/v1/guard/decisions']);
  });

  it('pendingTimeoutReturnsPendingWithApprovalAndNeverConsumes', async () => {
    const { api, client } = setup();
    api.script('PENDING');
    const outcome = await client.run(INPUT, vi.fn(), { ...EXEC, approvalTimeoutMs: 0 });
    expect(outcome.kind).toBe('pending');
    if (outcome.kind === 'pending') expect(outcome.decision.approval?.requiredRole).toBe('DPO');
    expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
  });

  it('pendingThenApprovedExecutesWithTheApprovalReceipt', async () => {
    const { api, client } = setup();
    api.script('PENDING');
    api.override((req) => {
      if (req.method === 'GET' && req.path.startsWith('/api/v1/guard/decisions/')) {
        api.approve(req.path.split('/').pop()!);
      }
      return undefined;
    });
    const outcome = await client.run(INPUT, async () => 'ok', EXEC);
    expect(outcome.kind).toBe('executed');
  });

  it('badReceiptBlocksBeforeConsume', async () => {
    const { api, client } = setup();
    api.mutateReceipts((r) => ({ ...r, payload: { ...r.payload, actionHash: '0'.repeat(64) } }));
    const execute = vi.fn();
    const outcome = await client.run(INPUT, execute, EXEC);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid' } });
    expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('receiptFromAnotherPolicyVersionBlocks（#517）', async () => {
    // 响应里的 policyVersion 与收据 payload.policyVersionId 不一致：收据不能证明来自本次请求解析出的策略版本。
    const api = fakeApi();
    const original = api.fetch;
    const client2 = new GuardClient(
      api.clientOptions({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const res = await original(input, init);
          if (String(input).endsWith('/api/v1/guard/decisions')) {
            const body = await res.json();
            return new Response(JSON.stringify({ ...body, policyVersion: { ...body.policyVersion, id: 999 } }), { status: 200 });
          }
          return res;
        },
      }),
    );
    const outcome = await client2.run(INPUT, vi.fn(), EXEC);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid', reason: expect.stringContaining('policy_mismatch') } });
  });

  describe('R68 签名覆盖的策略地址（#517，ADR 0040 §13）', () => {
    it('收据地址等于配置的 policyModule / policyFunction → 执行', async () => {
      const { api, client } = setup();
      const execute = vi.fn(async () => 'ok');
      const outcome = await client.run(INPUT, execute, EXEC);
      expect(outcome.kind).toBe('executed');
      expect(execute).toHaveBeenCalledTimes(1);
      const receipt = (await api.decisions.values().next().value!).response.executionReceipt!;
      expect(receipt.payload).toMatchObject({ policyModule: 'guard.test', policyFunction: 'decide' });
    });

    it.each([
      ['换模块', { policyModule: 'guard.lenient' }],
      ['换函数', { policyFunction: 'decideLenient' }],
    ])('签名有效但%s → blocked receipt_invalid / policy_mismatch，不 consume、不执行', async (_name, change) => {
      const { api, client } = setup();
      api.rewritePayloads((p) => ({ ...p, ...change }));
      const execute = vi.fn();
      const outcome = await client.run(INPUT, execute, EXEC);
      expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid', reason: expect.stringContaining('policy_mismatch') } });
      expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });

    it('收据没有地址键（R68 之前的 aster-api）→ policy_mismatch，fail-closed', async () => {
      const { api, client } = setup();
      api.rewritePayloads(({ policyModule: _m, policyFunction: _f, ...rest }) => (void _m, void _f, rest));
      const execute = vi.fn();
      const outcome = await client.run(INPUT, execute, EXEC);
      expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid', reason: expect.stringContaining('policy_mismatch') } });
      expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });

    it('签名后把地址改写成期望值 → bad_signature，不 consume', async () => {
      const { api, client } = setup();
      api.rewritePayloads((p) => ({ ...p, policyModule: 'guard.lenient' }));
      api.mutateReceipts((r) => ({ ...r, payload: { ...r.payload, policyModule: 'guard.test' } }));
      const execute = vi.fn();
      const outcome = await client.run(INPUT, execute, EXEC);
      expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid', reason: expect.stringContaining('bad_signature') } });
      expect(api.sequence().some((s) => s.includes('consume'))).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });

    it('verifyReceipt（低层）同样核对配置地址', async () => {
      const { api, client } = setup();
      api.rewritePayloads((p) => ({ ...p, policyModule: 'guard.lenient' }));
      const decision = await client.check(INPUT);
      const check = await client.verifyReceipt(decision.executionReceipt, {
        decisionId: decision.decisionId,
        actionHash: hashAction({ ...INPUT, principal: { id: 'agent-42', type: 'agent' } }),
        policyVersionId: decision.policyVersion?.id,
      });
      expect(check).toEqual({ ok: false, reasonCode: 'receipt_invalid', detail: 'policy_mismatch' });
    });
  });

  it.each(['not_allowed', 'receipt_consumed', 'receipt_expired', 'action_mismatch'])('consume 409 %s → blocked 同码，回调未调用', async (code) => {
    const { api, client } = setup();
    api.override((req) => (req.path.endsWith('/consume') ? new Response(JSON.stringify({ error: code }), { status: 409 }) : undefined));
    const execute = vi.fn();
    const outcome = await client.run(INPUT, execute, EXEC);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: code } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('kid_revoked → receipt_invalid 并强制刷新 JWKS', async () => {
    const { api, client } = setup();
    api.override((req) =>
      req.path.endsWith('/consume') ? new Response(JSON.stringify({ error: 'kid_revoked', revision: 5 }), { status: 409 }) : undefined,
    );
    const outcome = await client.run(INPUT, vi.fn(), EXEC);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'receipt_invalid' } });
    expect(api.sequence().filter((s) => s.endsWith('/keys'))).toHaveLength(2);
  });

  it('consumeResponseLostReportsAbortedAndNeverExecutes', async () => {
    const { api, client } = setup({ timeoutMs: 50 });
    api.override((req) => (req.path.endsWith('/consume') ? new Promise<Response>(() => undefined) : undefined));
    const execute = vi.fn();
    const outcome = await client.run(INPUT, execute, EXEC);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'client_timeout' } });
    expect(execute).not.toHaveBeenCalled();
    expect(bodyOf(api, '/result')).toMatchObject({ status: 'aborted', errorCode: 'consume_response_lost' });
  });

  it('callbackThrowReportsFailedAndReturnsFailed', async () => {
    const { api, client } = setup();
    const boom = new TypeError('upstream exploded');
    const outcome = await client.run(INPUT, async () => {
      throw boom;
    }, EXEC);
    expect(outcome).toMatchObject({ kind: 'failed', error: boom });
    expect(bodyOf(api, '/result')).toMatchObject({ status: 'failed', errorCode: 'TypeError' });
  });

  it('classifyFailedStillExecutedOutcome', async () => {
    const { api, client } = setup();
    const outcome = await client.run(INPUT, async () => ({ isError: true }), {
      ...EXEC,
      classify: (r) => (r.isError ? { status: 'failed', errorCode: 'tool_error', resultHash: 'a'.repeat(64) } : { status: 'executed' }),
    });
    expect(outcome.kind).toBe('executed');
    expect(bodyOf(api, '/result')).toMatchObject({ status: 'failed', errorCode: 'tool_error', resultHash: 'a'.repeat(64) });
  });

  it('classify 抛错：仍回写 failed / classify_error，以 failed 返回', async () => {
    const { api, client } = setup();
    const oops = new Error('classify oops');
    const outcome = await client.run(INPUT, async () => 'x', {
      ...EXEC,
      classify: () => {
        throw oops;
      },
    });
    expect(outcome).toMatchObject({ kind: 'failed', error: oops });
    expect(bodyOf(api, '/result')).toMatchObject({ status: 'failed', errorCode: 'classify_error' });
  });

  it('resultWriteFailureDoesNotChangeOutcome', async () => {
    const { api, client } = setup();
    api.override((req) => (req.path.endsWith('/result') ? new Response('', { status: 503 }) : undefined));
    expect((await client.run(INPUT, async () => 'x', EXEC)).kind).toBe('executed');
  });

  it('abortAfterConsumeReportsAbortedAndSkipsCallback', async () => {
    const { api, client } = setup();
    const controller = new AbortController();
    api.override((req) => {
      if (req.path.endsWith('/consume')) controller.abort();
      return undefined;
    });
    const execute = vi.fn();
    const outcome = await client.run(INPUT, execute, { ...EXEC, signal: controller.signal });
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'cancelled' } });
    expect(execute).not.toHaveBeenCalled();
    expect(bodyOf(api, '/result')).toMatchObject({ status: 'aborted', errorCode: 'cancelled' });
  });

  it('missingTenantIdThrowsTypeError / invalidExecutorIdThrowsTypeError', async () => {
    const api = fakeApi();
    const noTenant = new GuardClient({ ...api.clientOptions(), tenantId: undefined });
    await expect(noTenant.run(INPUT, vi.fn(), EXEC)).rejects.toThrow(TypeError);
    const client = new GuardClient(api.clientOptions());
    await expect(client.run(INPUT, vi.fn(), { executorId: 'bad\nid' })).rejects.toThrow(TypeError);
    await expect(client.run(INPUT, vi.fn(), { executorId: 'x'.repeat(256) })).rejects.toThrow(TypeError);
  });

  it('executorId 缺省 aster-guard-sdk@<hostname>（#465 I1）', async () => {
    const { api, client } = setup();
    await client.run(INPUT, async () => 1);
    expect(String(bodyOf(api, '/consume').executorId)).toMatch(/^aster-guard-sdk@/);
  });

  it('nonJsonSafeActionBlockedWithoutRequest', async () => {
    const { api, client } = setup();
    const outcome = await client.run({ ...INPUT, context: { amount: Number.NaN } }, vi.fn(), EXEC);
    expect(outcome).toMatchObject({ kind: 'blocked', decision: { reasonCode: 'client_error' } });
    expect(api.requests).toHaveLength(0);
  });

  it('noSkipOptionExists', () => {
    const opts: GuardRunOptions<unknown> = { executorId: 'x@y', approvalTimeoutMs: 1, classify: () => ({ status: 'executed' }) };
    expect(Object.keys(opts).filter((k) => /skip/i.test(k))).toEqual([]);
    // @ts-expect-error 不存在跳过 consume 的选项
    const skip: GuardRunOptions<unknown> = { skipConsume: true };
    void skip;
  });
});
