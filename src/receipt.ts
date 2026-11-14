// 执行收据离线验签与 JWKS 缓存（ADR 0040 §12 D6）。
// 顺序：kid 在缓存 JWKS（未命中强制刷新一次）→ Ed25519 签名对 payload 的 JCS 字节有效 → 租户 / 决策 / 结论
// → issuedAt − 60 s ≤ now < expiresAt → actionHash → 策略版本（ADR 0054 §11 D12）。
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalize, JcsError } from './hash/jcs.js';
import type { ExecutionReceipt, GuardJwk, ReceiptCheck, ReceiptInvalidDetail } from './types.js';

/** JWKS 缓存有效期（ADR 0040 §12 D6）。 */
export const JWKS_TTL_MS = 300_000;
/** 强制刷新的最小间隔：验签失败、kid_revoked、更大的 revision 都会触发，但每 60 s 至多一次。 */
export const JWKS_FORCE_REFRESH_INTERVAL_MS = 60_000;
/** 签发时刻的时钟偏差容忍。 */
const ISSUED_AT_SKEW_MS = 60_000;
const SIGNATURE_BYTES = 64;

/** 拉取一次 JWKS；失败返回 undefined。 */
export type KeysFetcher = () => Promise<{ revision: number; keys: GuardJwk[] } | undefined>;

/** 进程内 JWKS 缓存：TTL 300 s；强制刷新 60 s 节流；记住见过的最大 revision。 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private revision = -1;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private lastForcedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<boolean> | undefined;

  constructor(
    private readonly fetchKeys: KeysFetcher,
    private readonly now: () => number,
  ) {}

  /** 按 kid 取公钥：缓存过期先刷新；未命中强制刷新一次（受节流）。刷新失败返回 'unavailable'。 */
  async get(kid: string): Promise<KeyObject | 'unknown' | 'unavailable'> {
    if (this.now() - this.fetchedAt >= JWKS_TTL_MS && !(await this.refresh())) {
      return 'unavailable';
    }
    const cached = this.keys.get(kid);
    if (cached) return cached;
    const refreshed = await this.forceRefresh();
    if (refreshed === 'failed') return 'unavailable';
    return this.keys.get(kid) ?? 'unknown';
  }

  /** 强制刷新（60 s 节流）；'throttled' 表示本次被节流，没有发请求。 */
  async forceRefresh(): Promise<'refreshed' | 'throttled' | 'failed'> {
    if (this.now() - this.lastForcedAt < JWKS_FORCE_REFRESH_INTERVAL_MS) return 'throttled';
    this.lastForcedAt = this.now();
    return (await this.refresh()) ? 'refreshed' : 'failed';
  }

  /** 服务端响应带的 revision 大于已知值时强制刷新（受节流）。 */
  async noteRevision(revision: number): Promise<void> {
    if (Number.isInteger(revision) && revision > this.revision) {
      await this.forceRefresh();
    }
  }

  private refresh(): Promise<boolean> {
    this.inflight ??= this.load().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async load(): Promise<boolean> {
    const fetched = await this.fetchKeys();
    if (!fetched) return false;
    const next = new Map<string, KeyObject>();
    for (const jwk of fetched.keys) {
      try {
        next.set(jwk.kid, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }));
      } catch {
        // 单把格式错误的公钥不影响其它 kid：它对应的收据会按 kid_unknown 拒绝。
      }
    }
    this.keys = next;
    this.revision = Math.max(this.revision, fetched.revision);
    this.fetchedAt = this.now();
    return true;
  }
}

/** 核对时的期望值：配置租户、本次决策 id、本地算出的 actionHash、同一响应里的策略版本 id。 */
export interface ReceiptExpectation {
  tenantId: string;
  decisionId: string;
  actionHash: string;
  /** 同一决策响应的 `policyVersion.id`；缺失即无法证明收据来自期望的策略（D12），按 policy_mismatch 拒绝。 */
  policyVersionId: number | undefined;
}

/** 按 ADR 0040 §12 D6 顺序核对收据；任一步失败返回对应 detail，不抛异常。 */
export async function verifyExecutionReceipt(
  receipt: unknown,
  expect: ReceiptExpectation,
  cache: JwksCache,
  now: () => number,
): Promise<ReceiptCheck> {
  if (!isReceiptShape(receipt)) return invalid('malformed');
  const key = await cache.get(receipt.kid);
  if (key === 'unavailable') return invalid('keys_unavailable');
  if (key === 'unknown') return invalid('kid_unknown');
  if (!signatureValid(receipt, key)) {
    // 可能是轮换后的旧缓存：强制刷新（受节流）后再验一次。
    if ((await cache.forceRefresh()) !== 'refreshed') return invalid('bad_signature');
    const again = await cache.get(receipt.kid);
    if (typeof again === 'string' || !signatureValid(receipt, again)) return invalid('bad_signature');
  }
  const p = receipt.payload;
  if (p.tenantId !== expect.tenantId) return invalid('tenant_mismatch');
  if (p.decisionId !== expect.decisionId) return invalid('decision_mismatch');
  if (p.outcome !== 'ALLOW') return invalid('not_allow');
  const t = now();
  const issuedAt = Date.parse(p.issuedAt);
  const expiresAt = Date.parse(p.expiresAt);
  if (!(issuedAt - ISSUED_AT_SKEW_MS <= t && t < expiresAt)) return invalid('outside_window');
  if (p.actionHash !== expect.actionHash) return invalid('action_hash_mismatch');
  if (p.policyVersionId === undefined || p.policyVersionId !== expect.policyVersionId) return invalid('policy_mismatch');
  return { ok: true };
}

function invalid(detail: ReceiptInvalidDetail): ReceiptCheck {
  return { ok: false, reasonCode: 'receipt_invalid', detail };
}

function signatureValid(receipt: ExecutionReceipt, key: KeyObject): boolean {
  const signature = Buffer.from(receipt.signature, 'base64url');
  if (signature.length !== SIGNATURE_BYTES) return false;
  let signed: Buffer;
  try {
    signed = Buffer.from(canonicalize(receipt.payload), 'utf8');
  } catch (e) {
    if (e instanceof JcsError) return false;
    throw e;
  }
  return verify(null, signed, key, signature);
}

/** 结构核对：外层 kid 必须等于 payload.kid；时间可解析；签名为 base64url 文本。 */
function isReceiptShape(value: unknown): value is ExecutionReceipt {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  const p = value.payload;
  return (
    typeof value.kid === 'string' &&
    typeof value.signature === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(value.signature) &&
    typeof value.revision === 'number' &&
    p.kid === value.kid &&
    p.v === 1 &&
    typeof p.actionHash === 'string' &&
    typeof p.decisionId === 'string' &&
    typeof p.tenantId === 'string' &&
    typeof p.outcome === 'string' &&
    typeof p.issuedAt === 'string' &&
    typeof p.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(p.issuedAt)) &&
    !Number.isNaN(Date.parse(p.expiresAt)) &&
    (p.policyVersionId === undefined || typeof p.policyVersionId === 'number')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
