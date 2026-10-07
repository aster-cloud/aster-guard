import type {
  GuardActionInput,
  GuardApiError,
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

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_WAIT_INTERVAL_MS = 2_000;
/** 服务端对 waitSeconds 的上限（ADR 0040 §3.1）；客户端超时按此上限延长，避免先于服务端放弃。 */
const MAX_WAIT_SECONDS = 30;

const DECISIONS_PATH = '/api/v1/guard/decisions';
const APPROVALS_PATH = '/api/v1/guard/approvals';

const OUTCOMES = new Set<unknown>(['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ESCALATE']);
const EFFECTIVE_OUTCOMES = new Set<unknown>(['ALLOW', 'DENY', 'PENDING']);

/** 一次 HTTP 往返：收到响应（任意状态码；body 为解析后的 JSON，空体或非 JSON 时为 undefined），或客户端侧失败。 */
type Exchange =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'failure'; error: 'client_error' | 'client_timeout'; message: string };

interface ExchangeRequest {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Action Guard 客户端（ADR 0040 §6）。
 *
 * fail-closed：check / get / waitFor 对任何非 2xx、网络错误、响应体不合契约或超时都返回
 * effectiveOutcome 为 DENY 的决策，**从不抛异常**——抛异常会让调用方在 catch 里误放行。
 * 审批操作（listApprovals / approve / reject）不是 guard 结论，返回带错误码的 `{ ok: false }`，同样不抛异常。
 * 只有编程错误（缺 baseUrl / apiKey 等配置）在构造时抛出。
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
    return toDecision(exchange);
  }

  /** 读取决策的当前状态（approval.status 与 effectiveOutcome 反映审批进展）。 */
  async get(decisionId: string): Promise<GuardDecision> {
    return toDecision(await this.exchange('GET', `${DECISIONS_PATH}/${encodeURIComponent(decisionId)}`));
  }

  /**
   * 轮询直到决策不再 PENDING。到时仍为 PENDING 时返回 DENY `wait_timeout`（保留真实 decisionId，便于之后再查）。
   * 轮询中任何一次读取失败都会得到 DENY，按 fail-closed 直接返回。最后一次睡眠只睡到截止时刻，
   * 实际耗时可能再多出一次请求的超时。
   */
  async waitFor(decisionId: string, opts: GuardWaitOptions = {}): Promise<GuardDecision> {
    const { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_WAIT_INTERVAL_MS } = opts;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const decision = await this.get(decisionId);
      if (decision.effectiveOutcome !== 'PENDING') return decision;
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        return { ...clientDeny('wait_timeout', `等待 ${timeoutMs} ms 后决策仍为 PENDING`), decisionId };
      }
      await this.sleep(Math.min(intervalMs, remainingMs));
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
    return this.decideApproval(approvalId, 'approve', opts.comment, opts.businessRole);
  }

  /** 拒绝；comment 必填，缺失或空白时在客户端直接返回 `comment_required`，不发请求。 */
  async reject(approvalId: string, opts: GuardRejectOptions): Promise<GuardApprovalResult> {
    const { comment, businessRole } = opts;
    if (typeof comment !== 'string' || comment.trim() === '') {
      return { ok: false, status: 0, error: 'comment_required', message: '拒绝必须填写 comment' };
    }
    return this.decideApproval(approvalId, 'reject', comment, businessRole);
  }

  private async decideApproval(
    approvalId: string,
    verb: 'approve' | 'reject',
    comment: string | undefined,
    businessRole: string | undefined,
  ): Promise<GuardApprovalResult> {
    const exchange = await this.exchange('POST', `${APPROVALS_PATH}/${encodeURIComponent(approvalId)}/${verb}`, {
      // comment 为 undefined 时 JSON.stringify 不写该字段，请求体为 {}。
      body: { comment },
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
function interpret<T>(exchange: Exchange, isValid: (body: unknown) => body is T): { ok: true; body: T } | GuardApiError {
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
function toDecision(exchange: Exchange): GuardDecision {
  const result = interpret(exchange, isDecision);
  return result.ok ? result.body : clientDeny(denyReasonCode(result), result.message);
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`GuardClient: ${name} 不能为空`);
  }
  return value;
}
