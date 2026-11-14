// GuardClient 的公开类型：与 aster-api `/api/v1/guard/*` 的请求 / 响应同形（ADR 0040 §2.2、§3.1、§4.2）。

/** Agent 唯一需要看的结论：ALLOW 执行；DENY 不执行；PENDING 等待审批（轮询或 waitFor）。 */
export type GuardEffectiveOutcome = 'ALLOW' | 'DENY' | 'PENDING';

/** 规则给出的原始结论（Verdict outcome）。 */
export type GuardOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'ESCALATE';

/** 待审批记录的状态。 */
export type GuardApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/** 发起主体：id 必填；type 缺省由服务端按 "agent" 处理。 */
export interface GuardPrincipal {
  id: string;
  type?: string;
  roles?: string[];
}

/** 提议动作：谁（principal）对什么（resource）做什么（action），即决策请求体中的 `action`。 */
export interface GuardAction {
  principal: GuardPrincipal;
  action: { name: string };
  resource?: { type?: string; id?: string };
  context?: Record<string, unknown>;
  agent?: { model?: string; session?: string };
}

/** `check` 的入参：principal 可省略，缺省取 {@link GuardClientOptions.principal}。 */
export type GuardActionInput = Omit<GuardAction, 'principal'> & { principal?: GuardPrincipal };

/** 决策上的待审批视图；requiredRole 缺省表示任意复核人（ESCALATE）。 */
export interface GuardDecisionApproval {
  expiresAt: string;
  id: string;
  requiredRole?: string;
  status: GuardApprovalStatus;
}

/** 被评估的活跃策略版本。 */
export interface GuardPolicyVersion {
  id: number;
  sourceHash: string;
  version: number;
}

/** 决策收据：审计哈希链中的行 id、本行哈希与前一行哈希（链首行没有 prevHash）。 */
export interface GuardReceipt {
  auditId: number;
  hash: string;
  prevHash?: string;
}

/**
 * 决策（与 aster-api `GuardDecisionResponse` 同形，服务端省略 null / 空字段）。
 *
 * 客户端 fail-closed 产生的 DENY 只有 decisionId（无法取得时为空串）、outcome、effectiveOutcome、
 * reasonCode、reason。客户端 reasonCode：`http_<status>`、`idempotency_mismatch`、`client_error`、
 * `client_timeout`、`wait_timeout`、`wait_aborted`；服务端 reasonCode 另有 `not_a_verdict`、`evaluation_failed`、
 * `receipt_unavailable` 等（§3.2）。
 */
export interface GuardDecision {
  approval?: GuardDecisionApproval;
  controls?: string[];
  decisionId: string;
  effectiveOutcome: GuardEffectiveOutcome;
  outcome: GuardOutcome;
  policyVersion?: GuardPolicyVersion;
  reason?: string;
  reasonCode?: string;
  receipt?: GuardReceipt;
  role?: string;
  ruleId?: string;
}

/** 审批列表项（aster-api `ApprovalItemView`，时间为 ISO-8601 字符串，null 字段省略）。 */
export interface GuardApproval {
  comment?: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionId: string;
  expiresAt: string;
  id: string;
  outcome: Extract<GuardOutcome, 'REQUIRE_APPROVAL' | 'ESCALATE'>;
  principalId: string;
  requiredRole?: string;
  status: GuardApprovalStatus;
  /** 以下决策字段由 aster-api 按需返回（null 时省略），见 ADR 0042 §4.3。 */
  policyModule?: string;
  policyFunction?: string;
  actionName?: string;
  resourceType?: string;
  resourceId?: string;
  ruleId?: string;
  /** 命中规则关联的合规控制项，如 `GDPR:ART17`。 */
  controls?: string[];
  reason?: string;
  evidenceCorrelationId?: string;
  /**
   * 审批输入状态（ADR 0042 §12 D8）：PENDING 项按输入快照是否存在给出 `available` / `unavailable`；
   * 已决项为审批时记下的值。旧 aster-api 不返回。
   */
  inputStatus?: GuardApprovalInputStatus;
  /** 审批人所据视图的快照哈希；仅已决且输入可用时出现。 */
  inputSnapshotHash?: string;
  /** 审批时提交的哈希是否与服务端为该审批人重算的视图一致；未提交为 false。 */
  inputSnapshotMatched?: boolean;
  /** 审批所据视图是否为该审批人本人的解除视图。 */
  inputRevealed?: boolean;
}

/** 审批输入视图的状态（ADR 0042 §12 D8）。 */
export type GuardApprovalInputStatus = 'available' | 'unavailable' | 'purged' | 'integrity_failed' | 'too_large';

/** 输入视图中一个 `@pii` 字段的标记。 */
export interface GuardPiiMark {
  path: string;
  level: string;
  category?: string;
  source: string;
}

/**
 * 审批输入视图（aster-api `GET /api/v1/guard/approvals/{id}/input`，ADR 0042 §12 D8）。
 *
 * `input` 中声明为 `@pii` 的字段为 `{ "$pii": { level, category } }`，未声明的子树为 `{ "$pii": { level: "unknown" } }`；
 * 解除视图（`revealed: true`）只还原已声明的 `@pii` 字段。`status` 不是 `available` 时没有
 * `input / piiMarks / inputSnapshotHash`，审批照常可用（不带哈希）。
 */
export interface GuardApprovalInput {
  approvalId: string;
  decisionId: string;
  contextHash?: string;
  status: GuardApprovalInputStatus;
  marksSource?: 'version' | 'evaluation' | 'none';
  inputBinding?: 'direct' | 'evaluated' | 'unbound';
  maskRules: string;
  revealed: boolean;
  revealedByMe: boolean;
  input?: Record<string, unknown>;
  piiMarks?: GuardPiiMark[];
  /** 该视图的快照哈希；审批时作为 `inputSnapshotHash` 回传。 */
  inputSnapshotHash?: string;
  inputSources?: { verified: string[]; factIssuers: string[]; factSources: string[] };
  /** 首次决策所依赖的签名事实已失效（不参与快照哈希）。 */
  factsStale?: boolean;
}

/** getApprovalInput / revealApprovalInput 的结果。 */
export type GuardApprovalInputResult = { ok: true; input: GuardApprovalInput } | GuardApiError;

/** 审批列表的一页；page 从 0 起，size 为服务端夹取后的实际值（1–200）。 */
export interface GuardApprovalPage {
  items: GuardApproval[];
  page: number;
  size: number;
}

/**
 * 审批类操作的失败结果。审批不是 guard 结论，调用方需要错误码来区分处理，因此不做 fail-closed 映射。
 *
 * status 为 HTTP 状态码；未发出请求或未收到 HTTP 响应时为 0。error 为服务端错误码
 * （如 `segregation_of_duties`），或客户端错误码 `client_error` / `client_timeout` / `comment_required`，
 * 服务端未给出错误码时为 `http_<status>`。
 */
export interface GuardApiError {
  ok: false;
  status: number;
  error: string;
  message: string;
}

/** approve / reject 的结果：成功时为迁移后的决策（批准 → ALLOW，拒绝 → DENY）。 */
export type GuardApprovalResult = { ok: true; decision: GuardDecision } | GuardApiError;

/** listApprovals 的结果。 */
export type GuardApprovalListResult = ({ ok: true } & GuardApprovalPage) | GuardApiError;

/** `check` 的选项。 */
export interface GuardCheckOptions {
  /** 本次动作尝试的幂等键；省略时自动生成 UUID。只应在同一次尝试的网络重试之间复用（§6）。 */
  idempotencyKey?: string;
  /** PENDING 时服务端最多等待的秒数（服务端夹到 0–30）；客户端超时会相应延长。 */
  waitSeconds?: number;
}

/** `waitFor` 的选项。 */
export interface GuardWaitOptions {
  /** 总等待时长，默认 300000 ms；须 ≥ 0，Infinity 表示不设截止时刻。 */
  timeoutMs?: number;
  /** 轮询间隔，默认 2000 ms；须为有限正数。 */
  intervalMs?: number;
  /**
   * 调用方放弃等待的信号：中止后不再发起新的轮询，睡眠提前结束，返回 DENY `wait_aborted`（保留 decisionId），
   * 不抛异常。已发出的那次请求不中断，最长再等一次请求超时。
   */
  signal?: AbortSignal;
}

/** `approve` 的选项。 */
export interface GuardApproveOptions {
  comment?: string;
  /**
   * 仅作提示：仍作为 `X-User-Business-Role` 头发送，但 aster-api 以 API key 所属成员的已验证业务角色集合判定
   * （aster-cloud 团队成员页授予，ADR 0042 §2.3），自报值不再放行。
   * HTTP 头只能携带 Latin-1 字符：非 Latin-1 的角色名（如中文）会被 fetch 在发出前拒绝，
   * 结果为 `{ ok: false, status: 0, error: 'client_error' }`。
   */
  businessRole?: string;
  /**
   * 审批人所见输入视图的 `inputSnapshotHash`（{@link GuardClient.getApprovalInput} / `revealApprovalInput` 的返回）。
   * 与服务端为该审批人重算的视图不符 → `{ ok: false, status: 409, error: 'input_snapshot_mismatch' }`，刷新视图后重试；
   * 输入不可用时省略。
   */
  inputSnapshotHash?: string;
}

/** `reject` 的选项：comment 必填。 */
export interface GuardRejectOptions {
  comment: string;
  /** 同 {@link GuardApproveOptions.businessRole}：仅限 Latin-1 字符。 */
  businessRole?: string;
  /** 同 {@link GuardApproveOptions.inputSnapshotHash}。 */
  inputSnapshotHash?: string;
}

/** GuardClient 配置。baseUrl、apiKey、policyModule、policyFunction 缺失属于编程错误，构造时抛出。 */
export interface GuardClientOptions {
  /** aster-api 根地址，如 `https://api.example.com`（末尾斜杠可有可无）。 */
  baseUrl: string;
  /** API key，作为 `Authorization: Bearer <apiKey>` 发送。 */
  apiKey: string;
  policyModule: string;
  policyFunction: string;
  /** 默认发起主体；`check` 的 action 未带 principal 时使用。 */
  principal?: GuardPrincipal;
  /** 可注入的 fetch 实现，默认 `globalThis.fetch`。 */
  fetch?: typeof fetch;
  /**
   * 单次请求超时，默认 12000 ms（服务端评估超时 10 秒，另留 2 秒余量）；
   * 超时后中止请求并按 `client_timeout` 处理。
   */
  timeoutMs?: number;
  /** waitFor 使用的睡眠函数，供测试注入。 */
  sleep?: (ms: number) => Promise<void>;
  /** waitFor 使用的时钟（毫秒），供测试注入，默认 `Date.now`。 */
  now?: () => number;
}
