import { hostname } from 'node:os';
import { hashAction, JcsError } from './hash/jcs.js';
import { BEFORE_CONSUME, type InternalRunHooks } from './internal/hooks.js';
import { JwksCache, verifyExecutionReceipt } from './receipt.js';
import type {
  GuardAction,
  GuardGrant,
  GuardJwk,
  GuardResultStatus,
  GuardRunOptions,
  GuardRunOutcome,
  GuardSideEffect,
  ReceiptCheck,
  GuardActionInput,
  GuardApiError,
  GuardApprovalInput,
  GuardApprovalInputResult,
  GuardApprovalListResult,
  GuardApprovalPage,
  GuardApprovalResult,
  GuardApprovalStatus,
  GuardApproveOptions,
  GuardCheckOptions,
  GuardClientOptions,
  GuardDecision,
  GuardPrincipal,
  GuardRejectOptions,
  GuardWaitOptions,
} from './types.js';

/** 服务端评估超时为 10 秒（§3.2），客户端多留 2 秒余量，避免把「慢但成功」的 ALLOW 报成 DENY。 */
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_WAIT_INTERVAL_MS = 2_000;
/** 服务端对 waitSeconds 的上限（ADR 0040 §3.1）；客户端超时按此上限延长，避免先于服务端放弃。 */
const MAX_WAIT_SECONDS = 30;

const DECISIONS_PATH = '/api/v1/guard/decisions';
const RECEIPTS_PATH = '/api/v1/guard/receipts';
const KEYS_PATH = '/api/v1/guard/keys';
const SIDE_EFFECTS_PATH = '/api/v1/guard/side-effects';
/** executorId 的上限（ADR 0054 §5）。 */
const MAX_EXECUTOR_ID = 255;
/** consume 的 409 码（ADR 0040 §12 D5）；kid_revoked 归为 receipt_invalid 并强制刷新 JWKS。 */
const CONSUME_CONFLICTS = new Set(['not_allowed', 'receipt_consumed', 'receipt_expired', 'action_mismatch']);
const APPROVALS_PATH = '/api/v1/guard/approvals';

const OUTCOMES = new Set<unknown>(['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ESCALATE']);
const EFFECTIVE_OUTCOMES = new Set<unknown>(['ALLOW', 'DENY', 'PENDING']);

/** 一次 HTTP 往返：收到响应（任意状态码；body 为解析后的 JSON，空体或非 JSON 时为 undefined），或客户端侧失败。 */
type Exchange =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'failure'; error: 'client_error' | 'client_timeout'; message: string };

/** 合乎契约的 2xx 响应体，或 GuardApiError。 */
type Checked<T> = { ok: true; body: T } | GuardApiError;

interface ExchangeRequest {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Action Guard 客户端（ADR 0040 §6）。
 *
 * fail-closed：check / get / waitFor 对任何非 2xx、网络错误、响应体不合契约或超时都返回
 * effectiveOutcome 为 DENY 的决策，**对 guard 结果从不抛异常**——抛异常会让调用方在 catch 里误放行。
 * 审批操作（listApprovals / approve / reject）不是 guard 结论，返回带错误码的 `{ ok: false }`，同样不抛异常。
 * 只有编程错误才抛 TypeError：构造时缺 baseUrl / apiKey 等配置，或调用 waitFor 时选项非法。
 */
export class GuardClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly policyModule: string;
  private readonly policyFunction: string;
  private readonly principal: GuardPrincipal | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly tenantId: string | undefined;
  private jwks: JwksCache | undefined;

  constructor(options: GuardClientOptions) {
    this.baseUrl = requireText(options.baseUrl, 'baseUrl').replace(/\/+$/, '');
    this.apiKey = requireText(options.apiKey, 'apiKey');
    this.policyModule = requireText(options.policyModule, 'policyModule');
    this.policyFunction = requireText(options.policyFunction, 'policyFunction');
    this.principal = options.principal;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(Number.isFinite(this.timeoutMs) && this.timeoutMs > 0)) {
      throw new TypeError('GuardClient: timeoutMs 须为正数');
    }
    // 默认在调用时才取 globalThis.fetch，避免以错误的 this 调用宿主 fetch。
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.tenantId = options.tenantId;
  }

  /**
   * 推荐入口（ADR 0054 §2.1）：按固定顺序「哈希 → 决策（PENDING 则等待）→ 验签 → consume → 执行 → 回写」运行一次受守卫动作。
   * 任一步失败即返回，回调不被调用；没有跳过验签或 consume 的选项。只有本次请求的决策验签通过且 consume 200 才算授权
   * （ADR 0054 §11.4）——别处读到的 ALLOW 或收据都不是。回调抛错 → 回写 failed 并以 `failed` 返回原错误（不吞）；
   * 回写失败不影响结局（副作用已落地，回写是对账证据）。缺 tenantId 或 executorId 非法属于编程错误，抛 TypeError。
   */
  async run<T>(
    input: GuardActionInput,
    execute: (grant: GuardGrant) => Promise<T>,
    opts: GuardRunOptions<T> = {},
  ): Promise<GuardRunOutcome<T>> {
    const tenantId = this.requireTenant('run');
    const executorId = requireExecutorId(opts.executorId ?? `aster-guard-sdk@${hostname()}`);
    const principal = input.principal ?? this.principal;
    if (!principal) {
      return blockedOutcome(undefined, 'client_error', 'principal 缺失：action.principal 与配置 principal 均未提供');
    }
    // 顶层可选键为 undefined 等同缺省（不进请求体，也不进哈希）；更深层的 undefined 由 hashAction 拒绝。
    const action = Object.fromEntries(
      Object.entries({ ...input, principal }).filter(([, value]) => value !== undefined),
    ) as unknown as GuardAction;
    let actionHash: string;
    try {
      actionHash = hashAction(action);
    } catch (e) {
      if (!(e instanceof JcsError)) throw e;
      return blockedOutcome(undefined, 'client_error', `action 无法按 jcs-sha256/v1 规范化（${e.code}）：${e.message}`);
    }
    const first = await this.check(action, { idempotencyKey: crypto.randomUUID() });
    let decision = first;
    if (first.effectiveOutcome === 'PENDING') {
      decision = await this.waitFor(first.decisionId, { timeoutMs: opts.approvalTimeoutMs, signal: opts.signal });
      if (decision.reasonCode === 'wait_timeout') return { kind: 'pending', decision: first };
      if (decision.reasonCode === 'wait_aborted') return blockedOutcome(first, 'cancelled', '调用方在审批结论前取消');
    }
    if (decision.effectiveOutcome !== 'ALLOW' || decision.decisionId === '') {
      return { kind: 'blocked', decision };
    }
    const check = await this.verifyReceiptAgainst(decision.executionReceipt, {
      tenantId,
      decisionId: decision.decisionId,
      actionHash,
      policyVersionId: decision.policyVersion?.id,
    });
    if (!check.ok) {
      return blockedOutcome(decision, 'receipt_invalid', `执行收据核对失败：${check.detail}`);
    }
    if (opts.signal?.aborted) return blockedOutcome(decision, 'cancelled', '调用方在 consume 前取消');
    const attemptId = crypto.randomUUID();
    (opts as InternalRunHooks)[BEFORE_CONSUME]?.();
    // consume 时按当前对象重算哈希：决策之后若有人改了将被执行的对象，服务端以 409 action_mismatch 拒绝，而不是放行改过的动作。
    let consumeHash: string;
    try {
      consumeHash = hashAction(action);
    } catch (e) {
      if (!(e instanceof JcsError)) throw e;
      return blockedOutcome(decision, 'client_error', `action 在决策后变得无法规范化（${e.code}）`);
    }
    const consumed = await this.consume(decision.decisionId, { actionHash: consumeHash, attemptId, executorId });
    if (!consumed.ok) {
      return this.consumeRejected(decision, consumed, { attemptId, executorId });
    }
    const grant: GuardGrant = { decisionId: decision.decisionId, attemptId, actionHash: consumeHash };
    const report = (status: GuardResultStatus, extra: { errorCode?: string; resultHash?: string } = {}) =>
      this.reportResult(decision.decisionId, { attemptId, executorId, status, ...extra }).catch(() => undefined);
    if (opts.signal?.aborted) {
      await report('aborted', { errorCode: 'cancelled' });
      return blockedOutcome(decision, 'cancelled', '调用方在执行前取消（已 consume，未执行）');
    }
    let result: T;
    try {
      result = await execute(grant);
    } catch (error) {
      await report('failed', { errorCode: errorCodeOf(error) });
      return { kind: 'failed', decisionId: decision.decisionId, attemptId, error };
    }
    let verdict: { status: 'executed' | 'failed'; errorCode?: string; resultHash?: string };
    try {
      verdict = opts.classify?.(result) ?? { status: 'executed' };
    } catch (error) {
      // 副作用已落地而归类失败：照样回写（failed / classify_error），不让已消耗的尝试没有结果记录。
      await report('failed', { errorCode: 'classify_error' });
      return { kind: 'failed', decisionId: decision.decisionId, attemptId, error };
    }
    await report(verdict.status, { errorCode: verdict.errorCode, resultHash: verdict.resultHash });
    return { kind: 'executed', decisionId: decision.decisionId, attemptId, result };
  }

  /** 验签公钥（`GET /api/v1/guard/keys`）。 */
  async keys(): Promise<({ ok: true; revision: number; keys: GuardJwk[] }) | GuardApiError> {
    const result = interpret(await this.exchange('GET', KEYS_PATH), isKeySet);
    return result.ok ? { ok: true, revision: result.body.revision, keys: result.body.keys } : result;
  }

  /**
   * 核对收据（ADR 0040 §12 D6 + ADR 0054 §11 D12 + ADR 0040 §13 R68）：expect 给出本次决策 id、本地 actionHash 与同一响应的
   * 策略版本 id；期望的策略地址取本客户端配置的 `policyModule / policyFunction`，收据签名覆盖的地址缺失或不符即 `policy_mismatch`。
   * 低层方法，供代理与测试使用；业务代码用 {@link run}。
   */
  verifyReceipt(
    receipt: unknown,
    expect: { decisionId: string; actionHash: string; policyVersionId: number | undefined },
  ): Promise<ReceiptCheck> {
    return this.verifyReceiptAgainst(receipt, { tenantId: this.requireTenant('verifyReceipt'), ...expect });
  }

  /** 消耗收据（低层；先验签再调用）。409 时 `error` 为服务端码，`body` 为原始错误体。 */
  async consume(
    decisionId: string,
    body: { actionHash: string; attemptId: string; executorId: string },
  ): Promise<{ ok: true; consumedAt: string } | (GuardApiError & { body?: Record<string, unknown> })> {
    const exchange = await this.exchange('POST', `${RECEIPTS_PATH}/${encodeURIComponent(decisionId)}/consume`, { body });
    const result = interpret(exchange, isConsumed);
    if (result.ok) return { ok: true, consumedAt: result.body.consumedAt };
    return exchange.kind === 'response' && isRecord(exchange.body) ? { ...result, body: exchange.body } : result;
  }

  /** 结果回写（低层）。 */
  async reportResult(
    decisionId: string,
    body: {
      attemptId: string;
      executorId: string;
      status: GuardResultStatus;
      finishedAt?: string;
      resultHash?: string;
      errorCode?: string;
    },
  ): Promise<{ ok: true } | GuardApiError> {
    const payload = { ...body, finishedAt: body.finishedAt ?? new Date(this.now()).toISOString() };
    const result = interpret(
      await this.exchange('POST', `${RECEIPTS_PATH}/${encodeURIComponent(decisionId)}/result`, { body: payload }),
      isRecord,
    );
    return result.ok ? { ok: true } : result;
  }

  /**
   * 副作用上报（#465，ADR 0054 §10.2 / §10.5 I2）：给**工具侧 / 业务系统**用——每次实际执行后上报一条，有 consume 票据
   * 带票据里的 decisionId / attemptId，没有也照报；网络重试沿用同一 effectId。代理与 SDK 执行方不上报（§11.5）。
   */
  async reportSideEffects(
    effects: GuardSideEffect[],
  ): Promise<{ ok: true; accepted: number; duplicates: number } | GuardApiError> {
    const result = interpret(await this.exchange('POST', SIDE_EFFECTS_PATH, { body: { effects } }), isSideEffectAck);
    return result.ok ? { ok: true, ...result.body } : result;
  }

  private async verifyReceiptAgainst(
    receipt: unknown,
    expect: { tenantId: string; decisionId: string; actionHash: string; policyVersionId: number | undefined },
  ): Promise<ReceiptCheck> {
    // 期望地址只取自身配置：决策请求带的也是这两项，收据须证明出自同一 module.function（R68）。
    const policy = { module: this.policyModule, function: this.policyFunction };
    return verifyExecutionReceipt(receipt, { ...expect, policy }, this.jwksCache(), this.now);
  }

  private jwksCache(): JwksCache {
    this.jwks ??= new JwksCache(async () => {
      const keys = await this.keys();
      return keys.ok ? { revision: keys.revision, keys: keys.keys } : undefined;
    }, this.now);
    return this.jwks;
  }

  /** consume 未成功：响应丢失 → 尽力回写 aborted；kid_revoked → 强制刷新 JWKS 并按 receipt_invalid 拒绝。 */
  private async consumeRejected<T>(
    decision: GuardDecision,
    rejected: GuardApiError & { body?: Record<string, unknown> },
    attempt: { attemptId: string; executorId: string },
  ): Promise<GuardRunOutcome<T>> {
    if (rejected.status === 0 || rejected.status >= 500) {
      // consume 可能已在服务端生效：不执行，回写 aborted 让对账知道这次尝试放弃了（ADR 0040 §12 D5）。
      await this.reportResult(decision.decisionId, {
        ...attempt,
        status: 'aborted',
        errorCode: 'consume_response_lost',
      }).catch(() => undefined);
      const code = rejected.error === 'client_timeout' ? 'client_timeout' : 'client_error';
      return blockedOutcome(decision, code, `consume 未得到确认：${rejected.message}`);
    }
    if (rejected.status === 409 && rejected.error === 'kid_revoked') {
      const revision = rejected.body?.revision;
      if (typeof revision === 'number') await this.jwksCache().noteRevision(revision);
      else await this.jwksCache().forceRefresh();
      return blockedOutcome(decision, 'receipt_invalid', '签名密钥已吊销');
    }
    const code = rejected.status === 409 && CONSUME_CONFLICTS.has(rejected.error) ? rejected.error : 'client_error';
    return blockedOutcome(decision, code, `consume 被拒绝（HTTP ${rejected.status} ${rejected.error}）`);
  }

  private requireTenant(method: string): string {
    if (typeof this.tenantId !== 'string' || this.tenantId.trim() === '') {
      throw new TypeError(`GuardClient.${method}: 需要配置 tenantId（核对收据租户）`);
    }
    return this.tenantId;
  }

  /**
   * 对提议动作请求决策。未给 idempotencyKey 时为本次尝试生成新的 UUID：键绑定一次尝试的结论，
   * 不得跨尝试复用（收到瞬时 DENY 后重试必须换键，§6）。
   */
  async check(action: GuardActionInput, opts: GuardCheckOptions = {}): Promise<GuardDecision> {
    const principal = action.principal ?? this.principal;
    if (!principal) {
      return clientDeny('client_error', 'principal 缺失：action.principal 与配置 principal 均未提供');
    }
    const { idempotencyKey = crypto.randomUUID(), waitSeconds } = opts;
    const body = {
      policyModule: this.policyModule,
      policyFunction: this.policyFunction,
      action: { ...action, principal },
      ...(waitSeconds === undefined ? {} : { waitSeconds }),
    };
    const exchange = await this.exchange('POST', DECISIONS_PATH, {
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
      timeoutMs: this.timeoutMs + serverWaitMs(waitSeconds),
    });
    return toDecision(interpret(exchange, isDecision));
  }

  /** 读取决策的当前状态（approval.status 与 effectiveOutcome 反映审批进展）。 */
  async get(decisionId: string): Promise<GuardDecision> {
    return toDecision(await this.readDecision(decisionId));
  }

  /**
   * 轮询直到服务端给出非 PENDING 的结论。只有服务端确认的 ALLOW 才会返回 ALLOW。
   *
   * - 瞬时失败（未收到响应、5xx、429）不结束等待，继续轮询到截止时刻；
   * - 其他失败（400 / 401 / 403 / 404、不合契约的 2xx 等）立即返回对应 DENY，decisionId 保留为被等待的 id；
   * - 到时仍未得到结论返回 DENY `wait_timeout`（保留 decisionId），reason 说明最后一次轮询的情况；
   * - `signal` 中止后返回 DENY `wait_aborted`（保留 decisionId）：调用方已放弃，即使随后读到最终结论也不再返回它。
   *
   * 最后一次睡眠只睡到截止时刻，实际耗时可能再多出一次请求的超时。选项非法属于编程错误，抛 TypeError。
   */
  async waitFor(decisionId: string, opts: GuardWaitOptions = {}): Promise<GuardDecision> {
    const { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_WAIT_INTERVAL_MS, signal } = opts;
    requireWaitOptions(timeoutMs, intervalMs);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) return waitAborted(decisionId);
      const result = await this.readDecision(decisionId);
      if (signal?.aborted) return waitAborted(decisionId);
      if (result.ok && result.body.effectiveOutcome !== 'PENDING') return result.body;
      if (!result.ok && !isTransient(result)) return { ...denyOf(result), decisionId };
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) return waitTimeout(decisionId, timeoutMs, result);
      await sleepUnlessAborted(this.sleep, Math.min(intervalMs, remainingMs), signal);
    }
  }

  /** 租户内按状态分页列出审批；page 从 0 起，size 由服务端夹到 1–200。 */
  async listApprovals(status: GuardApprovalStatus = 'PENDING', page = 0, size = 20): Promise<GuardApprovalListResult> {
    const query = new URLSearchParams({ status, page: String(page), size: String(size) });
    const result = interpret(await this.exchange('GET', `${APPROVALS_PATH}?${query}`), isApprovalPage);
    return result.ok ? { ok: true, ...result.body } : result;
  }

  /** 批准；成功时返回 effectiveOutcome 为 ALLOW 的决策。 */
  approve(approvalId: string, opts: GuardApproveOptions = {}): Promise<GuardApprovalResult> {
    return this.decideApproval(approvalId, 'approve', opts.comment, opts.businessRole, opts.inputSnapshotHash);
  }

  /** 拒绝；comment 必填，缺失或空白时在客户端直接返回 `comment_required`，不发请求。 */
  async reject(approvalId: string, opts: GuardRejectOptions): Promise<GuardApprovalResult> {
    const { comment, businessRole, inputSnapshotHash } = opts;
    if (typeof comment !== 'string' || comment.trim() === '') {
      return { ok: false, status: 0, error: 'comment_required', message: '拒绝必须填写 comment' };
    }
    return this.decideApproval(approvalId, 'reject', comment, businessRole, inputSnapshotHash);
  }

  /**
   * 审批输入视图（打码，aster-api#460）：无副作用。旧 aster-api 没有该端点时为 `{ ok: false, status: 404 }`，
   * 调用方应按「输入不可用」处理并照常审批（不带哈希）。
   */
  async getApprovalInput(approvalId: string): Promise<GuardApprovalInputResult> {
    const result = interpret(
      await this.exchange('GET', `${APPROVALS_PATH}/${encodeURIComponent(approvalId)}/input`),
      isApprovalInput,
    );
    return result.ok ? { ok: true, input: result.body } : result;
  }

  /**
   * 解除原值（请求体为空对象 `{}`，与 approve 的空体口径一致）：只有审批 PENDING 且已验证业务角色包含所需角色者可调用；每人每审批首次解除以本人身份记入审计链。
   * 403 `reveal_not_permitted`、409 `input_not_available` / `approval_not_pending`、503 `receipt_unavailable`
   * 以 `{ ok: false }` 返回，响应中不含原值。
   */
  async revealApprovalInput(approvalId: string): Promise<GuardApprovalInputResult> {
    const result = interpret(
      await this.exchange('POST', `${APPROVALS_PATH}/${encodeURIComponent(approvalId)}/input/reveal`, { body: {} }),
      isApprovalInput,
    );
    return result.ok ? { ok: true, input: result.body } : result;
  }

  private async readDecision(decisionId: string): Promise<Checked<GuardDecision>> {
    return interpret(await this.exchange('GET', `${DECISIONS_PATH}/${encodeURIComponent(decisionId)}`), isDecision);
  }

  private async decideApproval(
    approvalId: string,
    verb: 'approve' | 'reject',
    comment: string | undefined,
    businessRole: string | undefined,
    inputSnapshotHash: string | undefined,
  ): Promise<GuardApprovalResult> {
    const exchange = await this.exchange('POST', `${APPROVALS_PATH}/${encodeURIComponent(approvalId)}/${verb}`, {
      // 值为 undefined 的字段 JSON.stringify 不写，请求体为 {}。
      body: { comment, inputSnapshotHash },
      headers: businessRole ? { 'X-User-Business-Role': businessRole } : {},
    });
    const result = interpret(exchange, isDecision);
    return result.ok ? { ok: true, decision: result.body } : result;
  }

  /**
   * 发出一次请求，在超时内得到 Exchange；从不 reject。超时由计时器与请求赛跑决定：
   * 即使注入的 fetch 不理会 AbortSignal，也会按时返回 client_timeout，同时中止底层请求。
   */
  private async exchange(method: 'GET' | 'POST', path: string, request: ExchangeRequest = {}): Promise<Exchange> {
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Exchange>((resolve) => {
      timer = setTimeout(() => {
        // 先定下超时结果再中止，保证由中止引起的 fetch 失败不会抢先被当作 client_error。
        resolve({ kind: 'failure', error: 'client_timeout', message: `请求超过 ${timeoutMs} ms 未完成` });
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.roundTrip(method, path, request, controller.signal), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** fetch 并读取响应体；网络错误、读体失败一律归为 client_error。 */
  private async roundTrip(
    method: 'GET' | 'POST',
    path: string,
    { body, headers }: ExchangeRequest,
    signal: AbortSignal,
  ): Promise<Exchange> {
    const hasBody = body !== undefined;
    try {
      const response = await this.fetchImpl(this.baseUrl + path, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      return { kind: 'response', status: response.status, body: parseJson(await response.text()) };
    } catch (e) {
      return { kind: 'failure', error: 'client_error', message: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** 把一次往返解释为「合乎契约的 2xx 响应体」或 GuardApiError。 */
function interpret<T>(exchange: Exchange, isValid: (body: unknown) => body is T): Checked<T> {
  if (exchange.kind === 'failure') {
    return { ok: false, status: 0, error: exchange.error, message: exchange.message };
  }
  const { status, body } = exchange;
  if (!isSuccess(status)) {
    const fields = isRecord(body) ? body : {};
    return {
      ok: false,
      status,
      error: typeof fields.error === 'string' ? fields.error : `http_${status}`,
      message: typeof fields.message === 'string' ? fields.message : `HTTP ${status}`,
    };
  }
  if (!isValid(body)) {
    return { ok: false, status, error: 'client_error', message: '响应体不符合 aster-api 契约' };
  }
  return { ok: true, body };
}

/** guard 结论的 fail-closed 映射：任何失败都成为 DENY。 */
function toDecision(result: Checked<GuardDecision>): GuardDecision {
  return result.ok ? result.body : denyOf(result);
}

function denyOf(error: GuardApiError): GuardDecision {
  return clientDeny(denyReasonCode(error), error.message);
}

/** 等待中可重试的失败：未收到 HTTP 响应（status 0）、限流 429、服务端 5xx。 */
function isTransient({ status }: GuardApiError): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** waitFor 到时的 DENY：保留被等待的 decisionId，reason 说明最后一次轮询是 PENDING 还是失败。 */
function waitTimeout(decisionId: string, timeoutMs: number, last: Checked<GuardDecision>): GuardDecision {
  const lastPoll = last.ok ? '决策仍为 PENDING' : `最后一次读取失败（${denyReasonCode(last)}：${last.message}）`;
  return { ...clientDeny('wait_timeout', `等待 ${timeoutMs} ms 未得到最终结论，${lastPoll}`), decisionId };
}

/** 调用方中止等待时的 DENY：保留被等待的 decisionId。 */
function waitAborted(decisionId: string): GuardDecision {
  return { ...clientDeny('wait_aborted', '调用方在得到最终结论前中止了等待'), decisionId };
}

/** 睡眠 ms 毫秒；signal 中止时提前结束（不抛异常）。注入的 sleep 不必理会 signal。 */
function sleepUnlessAborted(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    sleep(ms).then(done, done);
  });
}

/** 客户端侧失败（status 0）与不合契约的 2xx 沿用其错误码；HTTP 错误为 http_<status>，422 为 idempotency_mismatch。 */
function denyReasonCode({ status, error }: GuardApiError): string {
  if (status === 0 || isSuccess(status)) return error;
  return status === 422 ? 'idempotency_mismatch' : `http_${status}`;
}

function clientDeny(reasonCode: string, reason: string): GuardDecision {
  return { decisionId: '', outcome: 'DENY', effectiveOutcome: 'DENY', reasonCode, reason };
}

/** 服务端为 waitSeconds 额外占用的毫秒数（按服务端口径夹到 0–30 秒；非数值按 0）。 */
function serverWaitMs(waitSeconds: number | undefined): number {
  const seconds = typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) ? waitSeconds : 0;
  return Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1000;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** run 的阻断结局：effectiveOutcome 一律 DENY，保留已知的 decisionId / outcome，便于追查。 */
function blockedOutcome<T>(base: GuardDecision | undefined, reasonCode: string, reason: string): GuardRunOutcome<T> {
  return {
    kind: 'blocked',
    decision: {
      ...(base ?? {}),
      decisionId: base?.decisionId ?? '',
      outcome: base?.outcome ?? 'DENY',
      effectiveOutcome: 'DENY',
      reasonCode,
      reason,
    },
  };
}

function errorCodeOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : 'error';
}

/** executorId：1–255 字符、无控制字符（ADR 0054 §5）。 */
export function requireExecutorId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_EXECUTOR_ID || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`executorId 须为 1–${MAX_EXECUTOR_ID} 个字符且不含控制字符`);
  }
  return value;
}

function isKeySet(body: unknown): body is { revision: number; keys: GuardJwk[] } {
  return isRecord(body) && typeof body.revision === 'number' && Array.isArray(body.keys);
}

function isConsumed(body: unknown): body is { consumedAt: string } {
  return isRecord(body) && typeof body.consumedAt === 'string';
}

function isSideEffectAck(body: unknown): body is { accepted: number; duplicates: number } {
  return isRecord(body) && typeof body.accepted === 'number' && typeof body.duplicates === 'number';
}

/** 只认三值内的 effectiveOutcome：未知结论绝不能被调用方误当成放行。 */
function isDecision(body: unknown): body is GuardDecision {
  return (
    isRecord(body) &&
    typeof body.decisionId === 'string' &&
    OUTCOMES.has(body.outcome) &&
    EFFECTIVE_OUTCOMES.has(body.effectiveOutcome)
  );
}

function isApprovalPage(body: unknown): body is GuardApprovalPage {
  return isRecord(body) && Array.isArray(body.items) && typeof body.page === 'number' && typeof body.size === 'number';
}

const INPUT_STATUSES: ReadonlySet<unknown> = new Set([
  'available',
  'unavailable',
  'purged',
  'integrity_failed',
  'too_large',
]);

const MARKS_SOURCES: ReadonlySet<unknown> = new Set(['version', 'evaluation', 'none']);
const INPUT_BINDINGS: ReadonlySet<unknown> = new Set(['direct', 'evaluated', 'unbound']);

/**
 * 只认已知状态：未知状态的视图不能被当成可审阅的输入。`available` 时视图字段与快照哈希必须齐全，
 * 否则调用方会拿着不完整的视图去审批；其余状态没有输入快照，只要求公共字段。
 */
function isApprovalInput(body: unknown): body is GuardApprovalInput {
  if (
    !isRecord(body) ||
    typeof body.approvalId !== 'string' ||
    typeof body.decisionId !== 'string' ||
    !INPUT_STATUSES.has(body.status) ||
    typeof body.maskRules !== 'string' ||
    typeof body.revealed !== 'boolean' ||
    typeof body.revealedByMe !== 'boolean'
  ) {
    return false;
  }
  return (
    body.status !== 'available' ||
    (typeof body.contextHash === 'string' &&
      typeof body.inputSnapshotHash === 'string' &&
      MARKS_SOURCES.has(body.marksSource) &&
      INPUT_BINDINGS.has(body.inputBinding) &&
      isRecord(body.input))
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requireWaitOptions(timeoutMs: number, intervalMs: number): void {
  // !(x >= 0) 同时拦下 NaN 与负数；Infinity 表示不设截止时刻。
  if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0)) {
    throw new TypeError('GuardClient.waitFor: timeoutMs 须为 ≥ 0 的数（可为 Infinity）');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('GuardClient.waitFor: intervalMs 须为有限正数');
  }
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`GuardClient: ${name} 不能为空`);
  }
  return value;
}
