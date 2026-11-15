// 代理的结构化返回（ADR 0054 §2.2，R66 D4）。这些字段是非授权信息：只供人与审计阅读，
// 代理与 SDK 不据此做任何替代执行（静态断言见 test/bypass/static-no-branch-on-reason.test.ts）。
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GuardDecision, GuardGrant } from '../types.js';

/** 被代理阻断（而不是被规则拒绝）的原因码：验签 / consume / 网络 / 超时 / 取消。 */
const BLOCKING_CODES = new Set([
  'receipt_invalid',
  'receipt_consumed',
  'receipt_expired',
  'action_mismatch',
  'not_allowed',
  'client_error',
  'client_timeout',
  'cancelled',
  'wait_aborted',
  'idempotency_mismatch',
  'upstream_unavailable',
]);

/** 载荷位置：总在 `_meta.asterGuard`；上游工具未声明 outputSchema 时另放 structuredContent（D4）。 */
function guardResult(payload: Record<string, unknown>, decision: GuardDecision, hasOutputSchema: boolean): CallToolResult {
  const why = decision.reason || decision.reasonCode || `effectiveOutcome ${decision.effectiveOutcome}`;
  const body = { asterGuard: withoutUndefined(payload) };
  return {
    isError: true,
    content: [{ type: 'text', text: `Blocked by Aster Guard: ${why} (decision ${decision.decisionId || 'n/a'})` }],
    _meta: body,
    ...(hasOutputSchema ? {} : { structuredContent: body }),
  };
}

/** 规则 DENY（含审批被拒）。 */
export function deniedResult(d: GuardDecision, hasOutputSchema: boolean): CallToolResult {
  return guardResult(
    {
      status: 'denied',
      decisionId: d.decisionId,
      outcome: d.outcome,
      reasonCode: d.reasonCode,
      reason: d.reason,
      ruleId: d.ruleId,
      controls: d.controls,
    },
    d,
    hasOutputSchema,
  );
}

/** 等审批到超时仍 PENDING：再次调用同名工具是新决策，不复用本次审批。 */
export function pendingResult(d: GuardDecision, hasOutputSchema: boolean): CallToolResult {
  return guardResult(
    {
      status: 'pending',
      decisionId: d.decisionId,
      approvalId: d.approval?.id,
      requiredRole: d.approval?.requiredRole,
      expiresAt: d.approval?.expiresAt,
      poll: `GET /api/v1/guard/decisions/${d.decisionId}`,
    },
    { ...d, reason: d.reason ?? '等待人工审批' },
    hasOutputSchema,
  );
}

/** 验签 / consume / 网络 / 超时 / 取消导致的阻断。 */
export function blockedResult(d: GuardDecision, hasOutputSchema: boolean): CallToolResult {
  return guardResult(
    { status: 'blocked', decisionId: d.decisionId || undefined, reasonCode: d.reasonCode, reason: d.reason },
    d,
    hasOutputSchema,
  );
}

/**
 * 上游未就绪（监听模式下启动后尚未连上，或断开后重连中）：在裁决之前拒绝，没有决策、没有 consume、不转发。
 * 是否重试由调用方决定；代理不会替它排队或延后执行。
 */
export function unavailableResult(hasOutputSchema: boolean): CallToolResult {
  return blockedResult(
    {
      decisionId: '',
      outcome: 'DENY',
      effectiveOutcome: 'DENY',
      reasonCode: 'upstream_unavailable',
      reason: '上游 MCP 服务器暂不可用（正在重连），本次调用未裁决、未转发',
    },
    hasOutputSchema,
  );
}

/** run 的 blocked 结局归类为 denied 或 blocked。 */
export function refusedResult(d: GuardDecision, hasOutputSchema: boolean): CallToolResult {
  const code = d.reasonCode ?? '';
  const blocking = d.decisionId === '' || BLOCKING_CODES.has(code) || /^http_\d+$/.test(code);
  return blocking ? blockedResult(d, hasOutputSchema) : deniedResult(d, hasOutputSchema);
}

/** ALLOW 且上游返回：上游原值 + `_meta.asterGuard = { decisionId, attemptId }`。 */
export function withGuardMeta(result: CallToolResult, grant: Pick<GuardGrant, 'decisionId' | 'attemptId'>): CallToolResult {
  return { ...result, _meta: { ...result._meta, asterGuard: { decisionId: grant.decisionId, attemptId: grant.attemptId } } };
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
}
