import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardClient, type GuardClientOptions, type GuardDecision } from '../src/index.js';
import { UUID } from './helpers.js';

// 单元测试：注入 vi.fn() 作为 fetch，不发真实网络请求（ADR 0040 §6）。

const BASE_OPTIONS = {
  baseUrl: 'https://guard.example/',
  apiKey: 'ak_test',
  policyModule: 'acme.guard',
  policyFunction: 'decide',
  principal: { id: 'agent-7', type: 'agent', roles: ['support'] },
} satisfies GuardClientOptions;

const ALLOW: GuardDecision = {
  controls: ['GDPR:ART17'],
  decisionId: 'd-1',
  effectiveOutcome: 'ALLOW',
  outcome: 'ALLOW',
  policyVersion: { id: 1730890123456, sourceHash: 'abc', version: 3 },
  receipt: { auditId: 88213, hash: 'h1', prevHash: 'h0' },
  ruleId: 'CUST-DEL-001',
};

const PENDING: GuardDecision = {
  approval: { expiresAt: '2026-10-08T05:12:00Z', id: 'a-1', requiredRole: 'DPO', status: 'PENDING' },
  decisionId: 'd-1',
  effectiveOutcome: 'PENDING',
  outcome: 'REQUIRE_APPROVAL',
  role: 'DPO',
};

const ACTION = {
  action: { name: 'customer.delete' },
  resource: { type: 'customer', id: 'c-42' },
  context: { reason: 'gdpr request', count: 1 },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 把 fetch 的第 n 次调用还原为 { url, method, headers, body }，便于断言。 */
function request(fetchMock: ReturnType<typeof vi.fn>, n = 0) {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: new Headers(init.headers),
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
  };
}

function client(fetchMock: ReturnType<typeof vi.fn>, extra: Partial<GuardClientOptions> = {}): GuardClient {
  return new GuardClient({ ...BASE_OPTIONS, fetch: fetchMock as unknown as typeof fetch, ...extra });
}

function deny(reasonCode: string, decisionId = ''): Partial<GuardDecision> {
  return { decisionId, outcome: 'DENY', effectiveOutcome: 'DENY', reasonCode };
}

describe('GuardClient 构造', () => {
  it('缺少 baseUrl 或 apiKey 属于编程错误，构造时抛出', () => {
    expect(() => new GuardClient({ ...BASE_OPTIONS, baseUrl: '' })).toThrow(/baseUrl/);
    expect(() => new GuardClient({ ...BASE_OPTIONS, apiKey: '' })).toThrow(/apiKey/);
  });
});

describe('GuardClient.check', () => {
  it('发送正确的路径、头与请求体（principal 缺省取配置）', async () => {
    const fetchMock = vi.fn(async () => json(200, ALLOW));
    await client(fetchMock).check(ACTION, { idempotencyKey: 'k-1', waitSeconds: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = request(fetchMock);
    expect(req.url).toBe('https://guard.example/api/v1/guard/decisions');
    expect(req.method).toBe('POST');
    expect(req.headers.get('Authorization')).toBe('Bearer ak_test');
    expect(req.headers.get('Content-Type')).toBe('application/json');
    expect(req.headers.get('Idempotency-Key')).toBe('k-1');
    expect(req.body).toEqual({
      policyModule: 'acme.guard',
      policyFunction: 'decide',
      action: { ...ACTION, principal: BASE_OPTIONS.principal },
      waitSeconds: 5,
    });
  });

  it('action 自带 principal 时优先于配置；未给 waitSeconds 时不发送该字段', async () => {
    const fetchMock = vi.fn(async () => json(200, ALLOW));
    const principal = { id: 'user-1' };
    await client(fetchMock).check({ ...ACTION, principal });

    const body = request(fetchMock).body;
    expect(body.action.principal).toEqual(principal);
    expect(body).not.toHaveProperty('waitSeconds');
  });

  it('未提供 idempotencyKey 时每次尝试生成不同的 UUID', async () => {
    const fetchMock = vi.fn(async () => json(200, ALLOW));
    const guard = client(fetchMock);
    await guard.check(ACTION);
    await guard.check(ACTION);

    const k1 = request(fetchMock, 0).headers.get('Idempotency-Key');
    const k2 = request(fetchMock, 1).headers.get('Idempotency-Key');
    expect(k1).toMatch(UUID);
    expect(k2).toMatch(UUID);
    expect(k1).not.toBe(k2);
  });

  it('200 ALLOW 原样返回', async () => {
    const fetchMock = vi.fn(async () => json(200, ALLOW));
    await expect(client(fetchMock).check(ACTION)).resolves.toEqual(ALLOW);
  });

  it('500 → DENY http_500', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>boom</html>', { status: 500 }));
    const d = await client(fetchMock).check(ACTION);
    expect(d).toMatchObject(deny('http_500'));
    expect(d.reason).toBeTruthy();
  });

  it('400 invalid_action → DENY http_400，reason 取服务端 message', async () => {
    const fetchMock = vi.fn(async () => json(400, { error: 'invalid_action', message: 'principal.id 必填' }));
    await expect(client(fetchMock).check(ACTION)).resolves.toMatchObject({
      ...deny('http_400'),
      reason: 'principal.id 必填',
    });
  });

  it('422 → DENY idempotency_mismatch', async () => {
    const fetchMock = vi.fn(async () => json(422, { error: 'idempotency_mismatch', message: 'key 已绑定其他动作' }));
    await expect(client(fetchMock).check(ACTION)).resolves.toMatchObject(deny('idempotency_mismatch'));
  });

  it('网络错误 → DENY client_error，不抛异常', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client(fetchMock).check(ACTION)).resolves.toMatchObject({
      ...deny('client_error'),
      reason: 'fetch failed',
    });
  });

  it('2xx 但响应体不是合法 JSON → DENY client_error', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }));
    await expect(client(fetchMock).check(ACTION)).resolves.toMatchObject(deny('client_error'));
  });

  it('2xx 但 effectiveOutcome 不在三值内 → DENY client_error（不把未知结论当放行）', async () => {
    const fetchMock = vi.fn(async () => json(200, { decisionId: 'd-9', outcome: 'ALLOW', effectiveOutcome: 'YES' }));
    await expect(client(fetchMock).check(ACTION)).resolves.toMatchObject(deny('client_error'));
  });

  describe('超时（假定时器）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('超时（fetch 等待 AbortSignal）→ DENY client_timeout', async () => {
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      const pending = client(fetchMock, { timeoutMs: 20 }).check(ACTION);
      await vi.advanceTimersByTimeAsync(20);

      expect(await pending).toMatchObject(deny('client_timeout'));
      expect(request(fetchMock).headers.get('Idempotency-Key')).toBeTruthy();
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    });

    it('fetch 忽略 AbortSignal 永不返回时同样按时 DENY client_timeout，且仍中止请求', async () => {
      const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
      const pending = client(fetchMock, { timeoutMs: 20 }).check(ACTION);
      await vi.advanceTimersByTimeAsync(20);

      await expect(pending).resolves.toMatchObject(deny('client_timeout'));
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    });

    it('waitSeconds 让服务端等待时，客户端超时相应延长', async () => {
      const fetchMock = vi.fn(
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(200, ALLOW)), 60)),
      );
      const pending = client(fetchMock, { timeoutMs: 20 }).check(ACTION, { waitSeconds: 1 });
      await vi.advanceTimersByTimeAsync(60);

      await expect(pending).resolves.toEqual(ALLOW);
    });

    it('默认单次超时为 12000 ms（服务端评估超时 10 秒另留余量）', async () => {
      const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
      let result: GuardDecision | undefined;
      void client(fetchMock).check(ACTION).then((d) => {
        result = d;
      });

      await vi.advanceTimersByTimeAsync(11_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject(deny('client_timeout'));
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    });
  });

  it('既无 action.principal 也无配置 principal → DENY client_error，不发请求', async () => {
    const fetchMock = vi.fn(async () => json(200, ALLOW));
    const guard = client(fetchMock, { principal: undefined });
    await expect(guard.check(ACTION)).resolves.toMatchObject(deny('client_error'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GuardClient.get / waitFor', () => {
  it('get 发送 GET /decisions/{id}；404 → DENY http_404', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    const d = await client(fetchMock).get('d/1');
    const req = request(fetchMock);
    expect(req.url).toBe('https://guard.example/api/v1/guard/decisions/d%2F1');
    expect(req.method).toBe('GET');
    expect(req.headers.get('Authorization')).toBe('Bearer ak_test');
    expect(d).toMatchObject(deny('http_404'));
  });

  it('waitFor：PENDING、PENDING、ALLOW → ALLOW，共调用 3 次', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, PENDING))
      .mockResolvedValueOnce(json(200, PENDING))
      .mockResolvedValueOnce(json(200, { ...PENDING, effectiveOutcome: 'ALLOW' }));
    const sleep = vi.fn(async () => undefined);
    const d = await client(fetchMock, { sleep }).waitFor('d-1', { intervalMs: 500 });

    expect(d.effectiveOutcome).toBe('ALLOW');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(request(fetchMock, 2).url).toBe('https://guard.example/api/v1/guard/decisions/d-1');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('waitFor 超时 → DENY wait_timeout，保留真实 decisionId', async () => {
    let clock = 0;
    const fetchMock = vi.fn(async () => json(200, PENDING));
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const d = await client(fetchMock, { sleep, now: () => clock }).waitFor('d-1', {
      timeoutMs: 5000,
      intervalMs: 2000,
    });

    expect(d).toMatchObject(deny('wait_timeout', 'd-1'));
    // t=0、2000、4000、5000 各轮询一次：最后一次睡眠只睡到截止时刻。
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 2000, 1000]);
  });

  it('waitFor 容忍瞬时错误：PENDING → 网络错误 → 503 → ALLOW 得到 ALLOW，共 4 次轮询', async () => {
    const allow = { ...PENDING, effectiveOutcome: 'ALLOW' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, PENDING))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(json(200, allow));
    const d = await client(fetchMock, { sleep: async () => undefined }).waitFor('d-1');
    expect(d).toEqual(allow);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([429, 502])('waitFor 把 %i 视为瞬时错误，继续轮询', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(status, { error: 'busy', message: 'try later' }))
      .mockResolvedValueOnce(json(200, ALLOW));
    const d = await client(fetchMock, { sleep: async () => undefined }).waitFor('d-1');
    expect(d).toEqual(ALLOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404])('waitFor 中途 %i（非瞬时）立即返回 DENY http_<status>，保留 decisionId', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, PENDING))
      .mockResolvedValueOnce(new Response(null, { status }));
    const d = await client(fetchMock, { sleep: async () => undefined }).waitFor('d-1');
    expect(d).toMatchObject(deny(`http_${status}`, 'd-1'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waitFor 收到不合契约的 2xx 立即返回 DENY client_error，保留 decisionId', async () => {
    const fetchMock = vi.fn(async () => json(200, { decisionId: 'd-1', outcome: 'ALLOW', effectiveOutcome: 'MAYBE' }));
    const d = await client(fetchMock, { sleep: async () => undefined }).waitFor('d-1');
    expect(d).toMatchObject(deny('client_error', 'd-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waitFor 持续 503 到截止时刻 → DENY wait_timeout，保留 decisionId，reason 提及 503', async () => {
    let clock = 0;
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const d = await client(fetchMock, { sleep, now: () => clock }).waitFor('d-1', {
      timeoutMs: 5000,
      intervalMs: 2000,
    });
    expect(d).toMatchObject(deny('wait_timeout', 'd-1'));
    expect(d.reason).toContain('503');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    { timeoutMs: Number.NaN },
    { timeoutMs: -1 },
    { timeoutMs: Number.NEGATIVE_INFINITY },
    { intervalMs: Number.NaN },
    { intervalMs: 0 },
    { intervalMs: -5 },
    { intervalMs: Number.POSITIVE_INFINITY },
  ])('waitFor 选项非法 %o → 抛 TypeError，不发请求', async (opts) => {
    const fetchMock = vi.fn(async () => json(200, ALLOW));
    await expect(client(fetchMock).waitFor('d-1', opts)).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waitFor timeoutMs=0 只轮询一次；timeoutMs=Infinity 合法', async () => {
    const pending = vi.fn(async () => json(200, PENDING));
    await expect(client(pending).waitFor('d-1', { timeoutMs: 0 })).resolves.toMatchObject(deny('wait_timeout', 'd-1'));
    expect(pending).toHaveBeenCalledTimes(1);

    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, PENDING)).mockResolvedValueOnce(json(200, ALLOW));
    const d = await client(fetchMock, { sleep: async () => undefined }).waitFor('d-1', {
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    expect(d).toEqual(ALLOW);
  });
});

describe('GuardClient.waitFor 中止（signal）', () => {
  it('signal 已中止 → 不发请求，返回 DENY wait_aborted，保留 decisionId', async () => {
    const fetchMock = vi.fn(async () => json(200, PENDING));
    const d = await client(fetchMock).waitFor('d-1', { signal: AbortSignal.abort() });
    expect(d).toMatchObject(deny('wait_aborted', 'd-1'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('睡眠中中止 → 立即结束等待，不再轮询，不抛异常', async () => {
    const fetchMock = vi.fn(async () => json(200, PENDING));
    // 注入的睡眠永不结束：只有中止能让 waitFor 返回。
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const waiting = client(fetchMock, { sleep }).waitFor('d-1', { signal: controller.signal });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(waiting).resolves.toMatchObject(deny('wait_aborted', 'd-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('请求进行中被中止，随后读到 ALLOW 也返回 wait_aborted', async () => {
    let respond!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)));
    const controller = new AbortController();
    const waiting = client(fetchMock).waitFor('d-1', { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controller.abort();
    respond(json(200, ALLOW));

    await expect(waiting).resolves.toMatchObject(deny('wait_aborted', 'd-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('未中止时 signal 不影响正常轮询', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, PENDING)).mockResolvedValueOnce(json(200, ALLOW));
    const d = await client(fetchMock, { sleep: async () => undefined }).waitFor('d-1', {
      signal: new AbortController().signal,
    });
    expect(d).toEqual(ALLOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('GuardClient 审批', () => {
  const APPROVED: GuardDecision = {
    ...PENDING,
    approval: { ...PENDING.approval!, status: 'APPROVED' },
    effectiveOutcome: 'ALLOW',
  };

  it('listApprovals 发送 status/page/size 查询参数并返回分页', async () => {
    const page = {
      items: [
        {
          createdAt: '2026-10-07T05:12:00Z',
          decisionId: 'd-1',
          expiresAt: '2026-10-08T05:12:00Z',
          id: 'a-1',
          outcome: 'REQUIRE_APPROVAL',
          principalId: 'agent-7',
          requiredRole: 'DPO',
          status: 'PENDING',
        },
      ],
      page: 1,
      size: 5,
    };
    const fetchMock = vi.fn(async () => json(200, page));
    const r = await client(fetchMock).listApprovals('PENDING', 1, 5);

    const req = request(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://guard.example/api/v1/guard/approvals?status=PENDING&page=1&size=5');
    expect(r).toEqual({ ok: true, ...page });
  });

  it('listApprovals 默认 PENDING / 0 / 20；400 → { ok:false, error }', async () => {
    const fetchMock = vi.fn(async () => json(400, { error: 'invalid_status', message: 'bad status' }));
    const r = await client(fetchMock).listApprovals();
    expect(request(fetchMock).url).toBe('https://guard.example/api/v1/guard/approvals?status=PENDING&page=0&size=20');
    expect(r).toEqual({ ok: false, status: 400, error: 'invalid_status', message: 'bad status' });
  });

  it('approve 携带 X-User-Business-Role 与 comment，返回 { ok:true, decision }', async () => {
    const fetchMock = vi.fn(async () => json(200, APPROVED));
    const r = await client(fetchMock).approve('a-1', { comment: 'ok', businessRole: 'DPO' });

    const req = request(fetchMock);
    expect(req.url).toBe('https://guard.example/api/v1/guard/approvals/a-1/approve');
    expect(req.method).toBe('POST');
    expect(req.headers.get('X-User-Business-Role')).toBe('DPO');
    expect(req.headers.get('Authorization')).toBe('Bearer ak_test');
    expect(req.body).toEqual({ comment: 'ok' });
    expect(r).toEqual({ ok: true, decision: APPROVED });
  });

  it('businessRole 含非 Latin-1 字符（如中文角色名）→ Node fetch 拒绝该请求头，返回 client_error，不抛异常', async () => {
    // 不注入 fetch：头部取值校验发生在内置 fetch 构造请求时，早于任何网络连接。
    const guard = new GuardClient({ ...BASE_OPTIONS, baseUrl: 'http://127.0.0.1:9' });

    const r = await guard.approve('a-1', { businessRole: '数据保护官' });

    expect(r).toMatchObject({ ok: false, status: 0, error: 'client_error' });
    expect(r.ok ? '' : r.message).toMatch(/ByteString/);
  });

  it('approve 不带参数时发送空对象且不带业务角色头', async () => {
    const fetchMock = vi.fn(async () => json(200, APPROVED));
    await client(fetchMock).approve('a-1');
    const req = request(fetchMock);
    expect(req.body).toEqual({});
    expect(req.headers.has('X-User-Business-Role')).toBe(false);
  });

  it('approve 403 → { ok:false, status:403, error:segregation_of_duties }', async () => {
    const fetchMock = vi.fn(async () =>
      json(403, { error: 'segregation_of_duties', message: '审批人不能是发起主体' }),
    );
    await expect(client(fetchMock).approve('a-1')).resolves.toEqual({
      ok: false,
      status: 403,
      error: 'segregation_of_duties',
      message: '审批人不能是发起主体',
    });
  });

  it('approve 网络错误 → { ok:false, status:0, error:client_error }，不抛异常', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client(fetchMock).approve('a-1')).resolves.toEqual({
      ok: false,
      status: 0,
      error: 'client_error',
      message: 'fetch failed',
    });
  });

  it('reject 发送 comment 到 /reject', async () => {
    const rejected = { ...APPROVED, effectiveOutcome: 'DENY' as const };
    const fetchMock = vi.fn(async () => json(200, rejected));
    const r = await client(fetchMock).reject('a-1', { comment: '证据不足' });
    const req = request(fetchMock);
    expect(req.url).toBe('https://guard.example/api/v1/guard/approvals/a-1/reject');
    expect(req.body).toEqual({ comment: '证据不足' });
    expect(r).toEqual({ ok: true, decision: rejected });
  });

  it('reject 无 comment（或空白）在客户端拒绝，不调用 fetch', async () => {
    const fetchMock = vi.fn(async () => json(200, APPROVED));
    const guard = client(fetchMock);
    for (const comment of [undefined, '', '   ']) {
      const r = await guard.reject('a-1', { comment } as { comment: string });
      expect(r).toMatchObject({ ok: false, error: 'comment_required' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GuardClient 审批输入（aster-api#460，ADR 0042 §12 D8）', () => {
  const VIEW = {
    approvalId: 'a-1',
    contextHash: 'c'.repeat(64),
    decisionId: 'd-1',
    input: {
      principal: { id: 'agent-7' },
      context: { amount: 250000, email: { $pii: { level: 'L2', category: 'email' } } },
    },
    inputBinding: 'evaluated',
    inputSnapshotHash: 'h'.repeat(64),
    inputSources: { factIssuers: [], factSources: [], verified: [] },
    marksSource: 'evaluation',
    maskRules: 'v1',
    piiMarks: [{ path: 'context.email', level: 'L2', category: 'email', source: 'ir' }],
    revealed: false,
    revealedByMe: false,
    status: 'available',
  };
  const APPROVED: GuardDecision = {
    ...PENDING,
    approval: { ...PENDING.approval!, status: 'APPROVED' },
    effectiveOutcome: 'ALLOW',
  };

  it('getApprovalInput 发 GET /approvals/{id}/input，返回 { ok:true, input }', async () => {
    const fetchMock = vi.fn(async () => json(200, VIEW));
    const r = await client(fetchMock).getApprovalInput('a 1');
    const req = request(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://guard.example/api/v1/guard/approvals/a%201/input');
    expect(req.body).toBeUndefined();
    expect(req.headers.get('Authorization')).toBe('Bearer ak_test');
    expect(r).toEqual({ ok: true, input: VIEW });
  });

  it('getApprovalInput 对不可用状态同样成功（无 input / inputSnapshotHash）', async () => {
    const unavailable = {
      approvalId: 'a-1',
      decisionId: 'd-1',
      maskRules: 'v1',
      revealed: false,
      revealedByMe: false,
      status: 'unavailable',
    };
    const fetchMock = vi.fn(async () => json(200, unavailable));
    await expect(client(fetchMock).getApprovalInput('a-1')).resolves.toEqual({ ok: true, input: unavailable });
  });

  it('revealApprovalInput POST 空体到 /input/reveal', async () => {
    const revealed = { ...VIEW, revealed: true, revealedByMe: true };
    const fetchMock = vi.fn(async () => json(200, revealed));
    const r = await client(fetchMock).revealApprovalInput('a-1');
    const req = request(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://guard.example/api/v1/guard/approvals/a-1/input/reveal');
    expect(req.body).toEqual({});
    expect(r).toEqual({ ok: true, input: revealed });
  });

  it('403 reveal_not_permitted → { ok:false, status:403, error }', async () => {
    const fetchMock = vi.fn(async () =>
      json(403, { error: 'reveal_not_permitted', message: '需要所需业务角色', verifiedRoles: [] }),
    );
    await expect(client(fetchMock).revealApprovalInput('a-1')).resolves.toEqual({
      ok: false,
      status: 403,
      error: 'reveal_not_permitted',
      message: '需要所需业务角色',
    });
  });

  it('404 → { ok:false, status:404 }（与审批方法同一错误口径）', async () => {
    const fetchMock = vi.fn(async () => json(404, { error: 'approval_not_found', message: '审批不存在' }));
    await expect(client(fetchMock).getApprovalInput('a-1')).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: 'approval_not_found',
    });
  });

  it('不合契约的 200（缺 status / 未知 status）→ client_error', async () => {
    for (const body of [{ approvalId: 'a-1' }, { ...VIEW, status: 'mystery' }, [VIEW]]) {
      const fetchMock = vi.fn(async () => json(200, body));
      await expect(client(fetchMock).getApprovalInput('a-1')).resolves.toMatchObject({
        ok: false,
        status: 200,
        error: 'client_error',
      });
    }
  });

  it('approve 转发 inputSnapshotHash', async () => {
    const fetchMock = vi.fn(async () => json(200, APPROVED));
    await client(fetchMock).approve('a-1', { comment: 'ok', inputSnapshotHash: 'h'.repeat(64) });
    expect(request(fetchMock).body).toEqual({ comment: 'ok', inputSnapshotHash: 'h'.repeat(64) });
  });

  it('reject 转发 inputSnapshotHash；409 input_snapshot_mismatch → { ok:false }', async () => {
    const fetchMock = vi.fn(async () =>
      json(409, { error: 'input_snapshot_mismatch', message: '输入视图已变化，请刷新后重新审阅' }),
    );
    const r = await client(fetchMock).reject('a-1', { comment: 'no', inputSnapshotHash: 'h'.repeat(64) });
    expect(request(fetchMock).body).toEqual({ comment: 'no', inputSnapshotHash: 'h'.repeat(64) });
    expect(r).toMatchObject({ ok: false, status: 409, error: 'input_snapshot_mismatch' });
  });
});
