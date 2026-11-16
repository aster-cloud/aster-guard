// 测试用假 aster-api：以注入的 fetch 实现 /guard/decisions、/keys、/receipts/{id}/consume|result 的契约，
// 用测试 Ed25519 密钥真实签发执行收据（与 aster-api 同一 jcs-sha256/v1 字节）。只用于测试。
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalize, jcsSha256 } from '../../src/hash/jcs.js';
import type { ExecutionReceipt, ExecutionReceiptPayload, GuardDecision } from '../../src/types.js';

export const TENANT = 'tenant-test';
export const POLICY_VERSION_ID = 42;

/** 一把测试签名密钥：kid 与对应的 JWK 公钥。 */
export function testKey(kid = 'k-test') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  return { kid, privateKey, jwk: { alg: 'EdDSA' as const, crv: 'Ed25519' as const, kid, kty: 'OKP' as const, use: 'sig' as const, x } };
}

/** 按 aster-api 的方式签收据。 */
export function signReceipt(payload: ExecutionReceiptPayload, privateKey: KeyObject, revision = 1): ExecutionReceipt {
  const signature = sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64url');
  return { kid: payload.kid, payload, revision, signature };
}

export type Script = 'ALLOW' | 'DENY' | 'PENDING';

interface Stored {
  response: GuardDecision;
  /** 请求体里的策略地址：回读字段与收据签名载荷（ADR 0040 §13 R68）都取它。 */
  policy: { module: string; function: string };
  action: unknown;
  actionHash: string;
  pending: boolean;
  consumedBy?: { attemptId: string; consumedAt: string; executorId: string };
  result?: { resultAt: string; status: string };
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Override = (req: RecordedRequest) => Response | Promise<Response> | undefined;

/**
 * 假 API。`script` 依次给出后续 `POST /decisions` 的结论（缺省 ALLOW）；`approve / reject` 让 PENDING 决策转终态；
 * `override` 截获任意请求（返回 undefined 则交回缺省实现）。`requests` 记录全部请求。
 */
export function fakeApi(opts: { tenantId?: string; policyVersionId?: number; now?: () => number } = {}) {
  const tenantId = opts.tenantId ?? TENANT;
  const policyVersionId = opts.policyVersionId ?? POLICY_VERSION_ID;
  const now = opts.now ?? Date.now;
  const key = testKey();
  const decisions = new Map<string, Stored>();
  const queue: Script[] = [];
  const requests: RecordedRequest[] = [];
  const overrides: Override[] = [];
  let revision = 1;
  let mutateReceipt: ((r: ExecutionReceipt) => ExecutionReceipt) | undefined;
  let rewritePayload: ((p: ExecutionReceiptPayload) => ExecutionReceiptPayload) | undefined;

  // 与 aster-api R68 同形：载荷签名覆盖决策的 policyModule / policyFunction（v 仍为 1）。
  // rewritePayload 在签名前改载荷（模拟服务端签出的另一地址 / R68 之前的无地址收据），签名仍有效；
  // mutateReceipt 在签名后改（模拟传输中篡改），验签必然失败。
  const receiptFor = (decisionId: string, actionHash: string, policy: Stored['policy']): ExecutionReceipt => {
    const t = now();
    const signed: ExecutionReceiptPayload = {
      actionHash,
      decisionId,
      expiresAt: new Date(t + 300_000).toISOString(),
      issuedAt: new Date(t).toISOString(),
      kid: key.kid,
      outcome: 'ALLOW',
      policyFunction: policy.function,
      policyModule: policy.module,
      policyVersionId,
      tenantId,
      v: 1,
    };
    const receipt = signReceipt(rewritePayload ? rewritePayload(signed) : signed, key.privateKey, revision);
    return mutateReceipt ? mutateReceipt(receipt) : receipt;
  };

  const allowOf = (decisionId: string, actionHash: string, policy: Stored['policy']): GuardDecision => ({
    decisionId,
    outcome: 'ALLOW',
    effectiveOutcome: 'ALLOW',
    ruleId: 'R-ALLOW',
    policyVersion: { id: policyVersionId, sourceHash: 'src-hash', version: 1 },
    executionReceipt: receiptFor(decisionId, actionHash, policy),
  });

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  function view(s: Stored): GuardDecision {
    return {
      ...s.response,
      policyModule: s.policy.module,
      policyFunction: s.policy.function,
      ...(s.consumedBy ? { actionHash: s.actionHash, consumedBy: s.consumedBy } : {}),
      ...(s.result ? { result: s.result } : {}),
    };
  }

  async function handle(req: RecordedRequest): Promise<Response> {
    for (const o of overrides) {
      const r = await o(req);
      if (r) return r;
    }
    const { method, path, body } = req;
    if (method === 'GET' && path === '/api/v1/guard/keys') {
      return json(200, { keys: [key.jwk], revision });
    }
    if (method === 'POST' && path === '/api/v1/guard/decisions') {
      const { action, policyModule, policyFunction } = body as { action: unknown; policyModule: string; policyFunction: string };
      const policy = { module: policyModule, function: policyFunction };
      const actionHash = jcsSha256(action);
      const decisionId = crypto.randomUUID();
      const script = queue.shift() ?? 'ALLOW';
      const response: GuardDecision =
        script === 'ALLOW'
          ? allowOf(decisionId, actionHash, policy)
          : script === 'DENY'
            ? { decisionId, outcome: 'DENY', effectiveOutcome: 'DENY', reason: '规则拒绝', ruleId: 'R-DENY', controls: ['C-1'] }
            : {
                decisionId,
                outcome: 'REQUIRE_APPROVAL',
                effectiveOutcome: 'PENDING',
                approval: { id: crypto.randomUUID(), status: 'PENDING', expiresAt: '2099-01-01T00:00:00Z', requiredRole: 'DPO' },
              };
      decisions.set(decisionId, { response, policy, action, actionHash, pending: script === 'PENDING' });
      return json(200, response);
    }
    const read = /^\/api\/v1\/guard\/decisions\/([^/]+)$/.exec(path);
    if (method === 'GET' && read) {
      const s = decisions.get(read[1]);
      return s ? json(200, view(s)) : json(404);
    }
    const receipt = /^\/api\/v1\/guard\/receipts\/([^/]+)\/(consume|result)$/.exec(path);
    if (method === 'POST' && receipt) {
      const s = decisions.get(receipt[1]);
      if (!s) return json(404);
      const b = body as Record<string, string>;
      if (receipt[2] === 'consume') {
        if (s.response.effectiveOutcome !== 'ALLOW') return json(409, { error: 'not_allowed' });
        if (s.consumedBy) return json(409, { error: 'receipt_consumed' });
        if (b.actionHash !== s.actionHash) return json(409, { error: 'action_mismatch' });
        s.consumedBy = { attemptId: b.attemptId, executorId: b.executorId, consumedAt: new Date(now()).toISOString() };
        return json(200, { consumedAt: s.consumedBy.consumedAt, decisionId: receipt[1] });
      }
      if (!s.consumedBy) return json(409, { error: 'not_consumed' });
      if (s.result) return json(409, { error: 'result_recorded' });
      s.result = { resultAt: new Date(now()).toISOString(), status: b.status };
      return json(200, { decisionId: receipt[1], resultAt: s.result.resultAt, status: b.status });
    }
    return json(404);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const text = typeof init?.body === 'string' ? init.body : undefined;
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: text === undefined ? undefined : JSON.parse(text),
      headers,
    };
    requests.push(req);
    return handle(req);
  };

  return {
    fetch,
    key,
    tenantId,
    policyVersionId,
    requests,
    decisions,
    script(...outcomes: Script[]) {
      queue.push(...outcomes);
    },
    override(o: Override) {
      overrides.push(o);
    },
    mutateReceipts(fn: (r: ExecutionReceipt) => ExecutionReceipt) {
      mutateReceipt = fn;
    },
    /** 签名前改写后续收据的载荷（签名对改写后的载荷有效）。 */
    rewritePayloads(fn: (p: ExecutionReceiptPayload) => ExecutionReceiptPayload) {
      rewritePayload = fn;
    },
    bumpRevision() {
      revision++;
    },
    /** 审批通过：决策转 ALLOW 并签发收据（与 aster-api 审批后转 ALLOW 同形）。 */
    approve(decisionId: string) {
      const s = decisions.get(decisionId);
      if (!s) throw new Error(`no decision ${decisionId}`);
      s.response = { ...allowOf(decisionId, s.actionHash, s.policy), outcome: 'REQUIRE_APPROVAL', approval: { ...s.response.approval!, status: 'APPROVED' } };
      s.pending = false;
    },
    reject(decisionId: string) {
      const s = decisions.get(decisionId);
      if (!s) throw new Error(`no decision ${decisionId}`);
      s.response = { ...s.response, effectiveOutcome: 'DENY', approval: { ...s.response.approval!, status: 'REJECTED' } };
    },
    /** 指定路径的请求序列（方法 + 路径，路径中的 id 归一为 {id}）。 */
    sequence(): string[] {
      return requests.map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/g, '{id}')}`);
    },
    clientOptions(extra: Record<string, unknown> = {}) {
      return {
        baseUrl: 'https://api.test',
        apiKey: 'ak_test',
        policyModule: 'guard.test',
        policyFunction: 'decide',
        principal: { id: 'agent-42', type: 'agent' },
        tenantId,
        fetch,
        sleep: async () => undefined,
        ...extra,
      };
    },
  };
}

export type FakeApi = ReturnType<typeof fakeApi>;
