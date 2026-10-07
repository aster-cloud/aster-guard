import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNode } from './helpers.js';

// scripts/e2e-local.mjs 的行为测试：脚本面向真实 aster-api，这里用本地 mock HTTP 服务代替，
// 验证参数契约、成功路径、SKIP 路径，以及断言失败时确实以非零码退出（确定性，不依赖外部网络）。

const SCRIPT = fileURLToPath(new URL('../scripts/e2e-local.mjs', import.meta.url));
const SCRIPT_TEST_TIMEOUT_MS = 15_000;

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

/** 单个 mock 响应：状态码与 JSON 体。 */
type Reply = { status?: number; body: unknown };

let server: HttpServer;
let baseUrl: string;
let requests: RecordedRequest[];
/** 按 `METHOD url` 取响应；check 的响应按调用顺序逐个消费。 */
let checkReplies: Reply[];
let routes: Record<string, Reply>;

beforeEach(async () => {
  requests = [];
  checkReplies = [];
  routes = {};
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const method = req.method ?? '';
      const url = req.url ?? '';
      requests.push({ method, url, headers: req.headers, body: JSON.parse(raw || '{}') as Record<string, unknown> });
      const reply =
        method === 'POST' && url === '/api/v1/guard/decisions' ? checkReplies.shift() : routes[`${method} ${url}`];
      const { status = 200, body } = reply ?? { status: 404, body: { error: 'not_found', message: `${method} ${url}` } };
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // 先断开脚本留下的 keep-alive 连接，否则 close 要等它们超时才回调。
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 以最小环境运行脚本（不继承父进程的 ASTER_GUARD_*），返回退出码与输出。 */
function runScript(env: NodeJS.ProcessEnv) {
  return runNode(SCRIPT, [], env, { killAfterMs: SCRIPT_TEST_TIMEOUT_MS - 1_000 });
}

const allow = (decisionId: string): Reply => ({
  body: { decisionId, outcome: 'ALLOW', effectiveOutcome: 'ALLOW' },
});

const pending = (decisionId: string, approvalId: string): Reply => ({
  body: {
    decisionId,
    outcome: 'REQUIRE_APPROVAL',
    effectiveOutcome: 'PENDING',
    approval: { id: approvalId, status: 'PENDING', expiresAt: '2030-01-01T00:00:00Z', requiredRole: 'Data Protection Officer' },
  },
});

const deny = (decisionId: string): Reply => ({
  body: { decisionId, outcome: 'DENY', effectiveOutcome: 'DENY', reasonCode: 'policy_deny', reason: 'blocked in test' },
});

describe('scripts/e2e-local.mjs', { timeout: SCRIPT_TEST_TIMEOUT_MS }, () => {
  it('缺 ASTER_GUARD_API_KEY → 用法写 stderr，stdout 保持干净，退出码 2，且不发任何请求', async () => {
    const { code, stdout, stderr } = await runScript({ ASTER_GUARD_BASE_URL: baseUrl });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('ASTER_GUARD_API_KEY');
    expect(requests).toHaveLength(0);
  });

  it('ASTER_GUARD_API_KEY 只有空白 → 视为未设置：用法写 stderr，退出码 2，且不发任何请求', async () => {
    const { code, stdout, stderr } = await runScript({ ASTER_GUARD_BASE_URL: baseUrl, ASTER_GUARD_API_KEY: ' \t ' });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('缺少必填环境变量 ASTER_GUARD_API_KEY');
    expect(stderr).toContain('用法');
    expect(requests).toHaveLength(0);
  });

  it('其余变量去掉首尾空白，只有空白时取缺省值：缺省策略、审批步骤 SKIP', async () => {
    checkReplies = [allow('d-read'), pending('d-delete', 'ap-1')];
    const { code, stdout } = await runScript({
      ASTER_GUARD_BASE_URL: ` ${baseUrl} `,
      ASTER_GUARD_API_KEY: ' ak_req ',
      ASTER_GUARD_POLICY: '   ',
      ASTER_GUARD_APPROVER_API_KEY: ' ',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('SKIP: 审批步骤需要第二把 API key');
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.authorization).toBe('Bearer ak_req');
    expect(requests[0].body).toMatchObject({ policyModule: 'guard.customer', policyFunction: 'decide' });
  });

  it('ASTER_GUARD_POLICY 不是 <module>/<function> → 用法写 stderr，退出码 2', async () => {
    const { code, stdout, stderr } = await runScript({
      ASTER_GUARD_BASE_URL: baseUrl,
      ASTER_GUARD_API_KEY: 'ak_req',
      ASTER_GUARD_POLICY: 'guard.customer',
    });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('ASTER_GUARD_POLICY');
    expect(requests).toHaveLength(0);
  });

  it('断言失败 → stdout 出现 ✗ 与完整决策 JSON，退出码 1', async () => {
    // 第一次 check 符合预期（ALLOW），第二次本应 PENDING 却返回 DENY。
    checkReplies = [allow('d-read'), deny('d-delete')];
    const { code, stdout } = await runScript({ ASTER_GUARD_BASE_URL: baseUrl, ASTER_GUARD_API_KEY: 'ak_req' });
    expect(code).toBe(1);
    expect(stdout).toContain('✓');
    expect(stdout).toContain('✗');
    expect(stdout).toContain('"decisionId": "d-delete"');
    expect(stdout).toContain('blocked in test');
    // 失败标签本身写出实际的 effectiveOutcome，不必在 JSON 里找。
    expect(stdout).toMatch(/✗ \[2\] delete_customer_record → PENDING（实际 DENY，approvalId 缺失）/);
    // 断言失败后不再进入审批步骤。
    expect(requests.map((r) => r.url)).toEqual(['/api/v1/guard/decisions', '/api/v1/guard/decisions']);
  });

  it('read 步骤不是 ALLOW → 立即失败，退出码 1', async () => {
    checkReplies = [deny('d-read')];
    const { code, stdout } = await runScript({ ASTER_GUARD_BASE_URL: baseUrl, ASTER_GUARD_API_KEY: 'ak_req' });
    expect(code).toBe(1);
    expect(stdout).toContain('✗');
    expect(requests).toHaveLength(1);
  });

  it('PENDING 但缺 approvalId → 视为断言失败，退出码 1', async () => {
    checkReplies = [
      allow('d-read'),
      { body: { decisionId: 'd-delete', outcome: 'REQUIRE_APPROVAL', effectiveOutcome: 'PENDING' } },
    ];
    const { code, stdout } = await runScript({ ASTER_GUARD_BASE_URL: baseUrl, ASTER_GUARD_API_KEY: 'ak_req' });
    expect(code).toBe(1);
    expect(stdout).toContain('✗');
    expect(stdout).toContain('approvalId');
  });

  it('无审批人 key → SKIP 审批步骤，仍退出 0；请求使用新 principal、默认策略与 Bearer key', async () => {
    checkReplies = [allow('d-read'), pending('d-delete', 'ap-1')];
    const { code, stdout } = await runScript({ ASTER_GUARD_BASE_URL: baseUrl, ASTER_GUARD_API_KEY: 'ak_req' });
    expect(code).toBe(0);
    expect(stdout).toContain('SKIP: 审批步骤需要第二把 API key (ASTER_GUARD_APPROVER_API_KEY)');
    expect(stdout).not.toContain('✗');

    expect(requests).toHaveLength(2);
    const [read, del] = requests;
    expect(read.headers.authorization).toBe('Bearer ak_req');
    expect(read.body).toMatchObject({
      policyModule: 'guard.customer',
      policyFunction: 'decide',
      action: { action: { name: 'read_customer_record' } },
    });
    expect(del.body).toMatchObject({ action: { action: { name: 'delete_customer_record' } } });
    const principal = (read.body.action as { principal: { id: string } }).principal;
    expect(principal.id).toMatch(/^e2e-\d+/);
    expect((del.body.action as { principal: { id: string } }).principal.id).toBe(principal.id);
  });

  it('有审批人 key → 审批人批准（带 businessRole），请求人读到 ALLOW，退出 0', async () => {
    checkReplies = [allow('d-read'), pending('d-delete', 'ap-1')];
    routes['POST /api/v1/guard/approvals/ap-1/approve'] = allow('d-delete');
    routes['GET /api/v1/guard/decisions/d-delete'] = allow('d-delete');
    const { code, stdout } = await runScript({
      ASTER_GUARD_BASE_URL: baseUrl,
      ASTER_GUARD_API_KEY: 'ak_req',
      ASTER_GUARD_APPROVER_API_KEY: 'ak_appr',
      ASTER_GUARD_POLICY: 'guard.custom/judge',
      ASTER_GUARD_APPROVER_ROLE: 'Compliance Officer',
    });
    expect(code).toBe(0);
    expect(stdout).not.toContain('SKIP');
    expect(stdout).not.toContain('✗');

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/v1/guard/decisions',
      'POST /api/v1/guard/decisions',
      'POST /api/v1/guard/approvals/ap-1/approve',
      'GET /api/v1/guard/decisions/d-delete',
    ]);
    const [read, , approve, get] = requests;
    expect(read.body).toMatchObject({ policyModule: 'guard.custom', policyFunction: 'judge' });
    expect(approve.headers.authorization).toBe('Bearer ak_appr');
    expect(approve.headers['x-user-business-role']).toBe('Compliance Officer');
    expect(approve.body).toEqual({ comment: 'e2e' });
    expect(get.headers.authorization).toBe('Bearer ak_req');
  });

  it('审批被服务端拒绝（如四眼规则）→ 打印错误 JSON，退出码 1', async () => {
    checkReplies = [allow('d-read'), pending('d-delete', 'ap-1')];
    routes['POST /api/v1/guard/approvals/ap-1/approve'] = {
      status: 403,
      body: { error: 'segregation_of_duties', message: '审批人不能是提交人' },
    };
    const { code, stdout } = await runScript({
      ASTER_GUARD_BASE_URL: baseUrl,
      ASTER_GUARD_API_KEY: 'ak_req',
      ASTER_GUARD_APPROVER_API_KEY: 'ak_appr',
    });
    expect(code).toBe(1);
    expect(stdout).toContain('✗');
    expect(stdout).toContain('segregation_of_duties');
  });

  it('审批后请求人读到的仍不是 ALLOW → 退出码 1', async () => {
    checkReplies = [allow('d-read'), pending('d-delete', 'ap-1')];
    routes['POST /api/v1/guard/approvals/ap-1/approve'] = allow('d-delete');
    routes['GET /api/v1/guard/decisions/d-delete'] = pending('d-delete', 'ap-1');
    const { code, stdout } = await runScript({
      ASTER_GUARD_BASE_URL: baseUrl,
      ASTER_GUARD_API_KEY: 'ak_req',
      ASTER_GUARD_APPROVER_API_KEY: 'ak_appr',
    });
    expect(code).toBe(1);
    expect(stdout).toContain('✗');
  });
});
