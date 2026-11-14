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

  const receiptFor = (decisionId: string, actionHash: string): ExecutionReceipt => {
    const t = now();
    const receipt = signReceipt(
      {
        actionHash,
        decisionId,
        expiresAt: new Date(t + 300_000).toISOString(),
        issuedAt: new Date(t).toISOString(),
        kid: key.kid,
        outcome: 'ALLOW',
        policyVersionId,
        tenantId,
        v: 1,
      },
      key.privateKey,
      revision,
    );
    return mutateReceipt ? mutateReceipt(receipt) : receipt;
  };

  const allowOf = (decisionId: string, actionHash: string): GuardDecision => ({
    decisionId,
    outcome: 'ALLOW',
    effectiveOutcome: 'ALLOW',
    ruleId: 'R-ALLOW',
    policyVersion: { id: policyVersionId, sourceHash: 'src-hash', version: 1 },
    executionReceipt: receiptFor(decisionId, actionHash),
  });

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  function view(s: Stored): GuardDecision {
    return {
      ...s.response,
      policyModule: 'guard.test',
      policyFunction: 'decide',
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
      const action = (body as { action: unknown }).action;
      const actionHash = jcsSha256(action);
      const decisionId = crypto.randomUUID();
      const script = queue.shift() ?? 'ALLOW';
      const response: GuardDecision =
        script === 'ALLOW'
          ? allowOf(decisionId, actionHash)
          : script === 'DENY'
            ? { decisionId, outcome: 'DENY', effectiveOutcome: 'DENY', reason: '规则拒绝', ruleId: 'R-DENY', controls: ['C-1'] }
            : {
                decisionId,
                outcome: 'REQUIRE_APPROVAL',
                effectiveOutcome: 'PENDING',
                approval: { id: crypto.randomUUID(), status: 'PENDING', expiresAt: '2099-01-01T00:00:00Z', requiredRole: 'DPO' },
              };
      decisions.set(decisionId, { response, action, actionHash, pending: script === 'PENDING' });
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
    bumpRevision() {
      revision++;
    },
    /** 审批通过：决策转 ALLOW 并签发收据（与 aster-api 审批后转 ALLOW 同形）。 */
    approve(decisionId: string) {
      const s = decisions.get(decisionId);
      if (!s) throw new Error(`no decision ${decisionId}`);
      s.response = { ...allowOf(decisionId, s.actionHash), outcome: 'REQUIRE_APPROVAL', approval: { ...s.response.approval!, status: 'APPROVED' } };
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
