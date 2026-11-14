// auth 隔离模式的工具侧核对（ADR 0054 §3.3，R66 D2 / D11 / D12）。
// 代理在 consume 200 后把 { decisionId, attemptId, envelope } 放进转发请求的 params._meta；工具用**自己的** API key
// 回读决策，按自己的映射对实际收到的参数重算 actionHash，任一不符即拒绝（fail-closed），最后经原子账本认领 attemptId。
import type { GuardClient } from '../client.js';
import { canonicalize, hashAction, JcsError } from '../hash/jcs.js';
import { buildToolAction, canonicalArgs, type ActionMapping } from '../mcp/action-mapping.js';
import type { GuardAction, GuardDecision } from '../types.js';

/** consume 票据在 MCP 请求 `params._meta` 中的键。 */
export const CONSUME_TICKET_META_KEY = 'io.aster/guard-consume';

/** 票据：非签名的 JSON；完整性由与回读 actionHash 的比对保证（envelope 不受信）。 */
export interface ConsumeTicket {
  attemptId: string;
  decisionId: string;
  envelope: Omit<GuardAction, 'context'>;
}

/**
 * 原子认领：同一 attemptId 首次认领返回 true，之后恒为 false（at-most-once 放行，ADR 0054 §11 D11）。
 * 作用域须覆盖该工具的全部副本并跨重启存活至少 ttl：多副本 / 会重启的工具用共享持久存储实现（如数据库唯一键插入）。
 */
export interface AttemptLedger {
  claim(attemptId: string, decisionId: string): Promise<boolean>;
}

/**
 * 单进程内存账本：条目保留 ttlMs。只适用于单副本工具；进程重启后 ttl 窗口内同一票据可被再放行一次（README 写明）。
 */
export class MemoryAttemptLedger implements AttemptLedger {
  private readonly claimed = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_TICKET_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async claim(attemptId: string): Promise<boolean> {
    const t = this.now();
    for (const [id, at] of this.claimed) {
      if (t - at > this.ttlMs) this.claimed.delete(id);
    }
    if (this.claimed.has(attemptId)) return false;
    this.claimed.set(attemptId, t);
    return true;
  }
}

/** 缺省票据有效期，同收据 TTL PT5M。 */
export const DEFAULT_TICKET_TTL_MS = 300_000;

export type TicketRejection =
  | 'missing_ticket'
  | 'malformed_ticket'
  | 'guard_unavailable'
  | 'not_allowed'
  | 'policy_mismatch'
  | 'action_mismatch'
  | 'attempt_mismatch'
  | 'ticket_expired'
  | 'result_recorded'
  | 'ticket_replayed';

export interface VerifyConsumeTicketInput {
  /** 工具收到的 MCP 请求 `params._meta`。 */
  meta: unknown;
  /** 工具收到的参数。 */
  args: Record<string, unknown> | undefined;
  toolName: string;
  /** 与代理同一份 `actions.<toolName>` 映射。 */
  mapping?: ActionMapping;
  /** 期望的策略地址（D12）：回读决策的 policyModule / policyFunction 必须与之相等。 */
  policy: { module: string; function: string };
  /** 用工具**自己的** API key 构造的 GuardClient。 */
  client: Pick<GuardClient, 'get'>;
  ledger: AttemptLedger;
  ttlMs?: number;
  now?: () => number;
}

/**
 * 核对 consume 票据；全部通过才返回 ok。顺序：票据形状 → 回读决策（非 200 / 超时 → guard_unavailable）→ ALLOW
 * → 策略地址 → envelope 与工具自身映射一致 → 重算哈希 → 消耗者 attempt → 时间窗 → 未写结果 → 原子认领（最后）。
 */
export async function verifyConsumeTicket(
  input: VerifyConsumeTicketInput,
): Promise<{ ok: true; decisionId: string; attemptId: string } | { ok: false; reason: TicketRejection }> {
  const { toolName, mapping, policy, client, ledger, ttlMs = DEFAULT_TICKET_TTL_MS, now = Date.now } = input;
  const raw = isRecord(input.meta) ? input.meta[CONSUME_TICKET_META_KEY] : undefined;
  if (raw === undefined) return reject('missing_ticket');
  if (!isTicket(raw)) return reject('malformed_ticket');
  let decision: GuardDecision;
  try {
    decision = await client.get(raw.decisionId);
  } catch {
    return reject('guard_unavailable');
  }
  // 客户端 fail-closed 产生的 DENY（404 / 超时 / 5xx）decisionId 为空串：查不到就不放行。
  if (decision.decisionId === '') return reject('guard_unavailable');
  if (decision.decisionId !== raw.decisionId || decision.effectiveOutcome !== 'ALLOW') return reject('not_allowed');
  if (decision.policyModule === undefined || decision.policyFunction === undefined) return reject('guard_unavailable');
  if (decision.policyModule !== policy.module || decision.policyFunction !== policy.function) {
    return reject('policy_mismatch');
  }
  const recomputed = recompute(raw, input.args, toolName, mapping);
  if (recomputed === undefined || recomputed !== decision.actionHash) return reject('action_mismatch');
  const consumed = decision.consumedBy;
  if (!consumed || consumed.attemptId !== raw.attemptId) return reject('attempt_mismatch');
  const consumedAt = Date.parse(consumed.consumedAt);
  if (!(consumedAt > now() - ttlMs)) return reject('ticket_expired');
  if (decision.result !== undefined) return reject('result_recorded');
  if (!(await ledger.claim(raw.attemptId, raw.decisionId))) return reject('ticket_replayed');
  return { ok: true, decisionId: raw.decisionId, attemptId: raw.attemptId };
}

/**
 * 工具只信任自己算出的部分：context 由自己的映射对实际参数构造；action.name 与 resource 必须等于自己的映射结果；
 * principal / agent 取自 envelope，只被哈希绑定。任何一处不符返回 undefined。
 */
function recompute(
  ticket: ConsumeTicket,
  args: Record<string, unknown> | undefined,
  toolName: string,
  mapping: ActionMapping | undefined,
): string | undefined {
  try {
    const own = buildToolAction({ toolName, args: canonicalArgs(args), mapping, principal: ticket.envelope.principal });
    if (ticket.envelope.action?.name !== own.action.name) return undefined;
    if (canonicalize(ticket.envelope.resource ?? null) !== canonicalize(own.resource ?? null)) return undefined;
    return hashAction({ ...ticket.envelope, context: own.context });
  } catch (e) {
    if (e instanceof JcsError) return undefined;
    throw e;
  }
}

function reject(reason: TicketRejection): { ok: false; reason: TicketRejection } {
  return { ok: false, reason };
}

const UUID_SHAPE = /^[0-9a-fA-F-]{36}$/;

function isTicket(value: unknown): value is ConsumeTicket {
  return (
    isRecord(value) &&
    typeof value.decisionId === 'string' &&
    UUID_SHAPE.test(value.decisionId) &&
    typeof value.attemptId === 'string' &&
    UUID_SHAPE.test(value.attemptId) &&
    isRecord(value.envelope) &&
    isRecord(value.envelope.principal) &&
    isRecord(value.envelope.action) &&
    !('context' in value.envelope)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
