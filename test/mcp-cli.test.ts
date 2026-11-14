import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeApi, TENANT } from './fixtures/fake-api.js';
import { runNode, UUID } from './helpers.js';

// CLI 端到端：以子进程运行构建产物 dist/mcp/cli.js（由 pnpm test 先 build 保证），
// 上游为 test/fixtures/echo-upstream.mjs，guard 为本地 mock HTTP 服务（ADR 0040 §6、§8）。

const CLI = fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/echo-upstream.mjs', import.meta.url));
const UPSTREAM = `"${process.execPath}" "${FIXTURE}"`;
const CLI_TEST_TIMEOUT_MS = 15_000;

interface GuardRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: { policyModule: string; policyFunction: string; action: Record<string, unknown> };
}

let guardServer: HttpServer;
let baseUrl: string;
const guardRequests: GuardRequest[] = [];

/**
 * 假 aster-api（真实签收据）挂在本地 HTTP 上：context.deny 为 true 时 DENY；序列化超过 65536 字节的 context 400。
 * 只记录 /decisions 请求。
 */
beforeAll(async () => {
  const api = fakeApi();
  api.override((req) => {
    if (req.path !== '/api/v1/guard/decisions') return undefined;
    const context = ((req.body as GuardRequest['body']).action?.context ?? {}) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(context)) > 65_536) {
      return new Response(JSON.stringify({ error: 'invalid_action', message: 'context 超过 65536 字节' }), { status: 400 });
    }
    if (context.deny === true) {
      const decision = { decisionId: 'd-deny', outcome: 'DENY', effectiveOutcome: 'DENY', reason: 'blocked in test' };
      return new Response(JSON.stringify(decision), { status: 200 });
    }
    return undefined;
  });
  guardServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      if (req.url === '/api/v1/guard/decisions') {
        guardRequests.push({ method: req.method ?? '', url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
      }
      const response = await api.fetch(`http://fake${req.url}`, { method: req.method, headers, body: raw === '' ? undefined : raw });
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(await response.text());
    });
  });
  guardServer.listen(0, '127.0.0.1');
  await once(guardServer, 'listening');
  baseUrl = `http://127.0.0.1:${(guardServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  guardServer.closeAllConnections();
  await new Promise<void>((resolve) => guardServer.close(() => resolve()));
});

function requiredArgs(): string[] {
  return ['--base-url', baseUrl, '--policy', 'guard.test/decide', '--principal-id', 'agent-e2e'];
}

/** 代理模式的执行点参数（ADR 0054 R66 D8）。 */
function proxyArgs(...extra: string[]): string[] {
  return [...requiredArgs(), '--tenant-id', TENANT, '--isolation', 'network', ...extra];
}

/** 运行 CLI 直到其 stdio 全部关闭；stdin 关闭时机见 runNode。 */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}, closeStdin: 'now' | 'never' | RegExp = 'now') {
  return runNode(CLI, args, env, { closeStdin, killAfterMs: CLI_TEST_TIMEOUT_MS - 1_000 });
}

describe('aster-guard-mcp CLI：参数', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('--help → 用法写 stdout，退出码 0', async () => {
    const { code, stdout, stderr } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--upstream');
    expect(stderr).toBe('');
  });

  it('缺必填参数 → 错误与用法写 stderr，stdout 保持干净，退出码 2', async () => {
    const { code, stdout, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--base-url');
    expect(stderr).toContain('--help');
  });

  it('上游无法启动 → stderr 报错，退出码 1', async () => {
    const { code, stdout, stderr } = await runCli(
      [...proxyArgs(), '--upstream', '/nonexistent/upstream-binary --x'],
      { ASTER_GUARD_API_KEY: 'ak_e2e' },
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/上游/);
  });
});

describe('aster-guard-mcp CLI：端到端代理', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('透传 tools/list，ALLOW 转发、DENY 拦截；上游看不到 guard API key', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, ...proxyArgs(), '--upstream', UPSTREAM, '--resource-from', 'text'],
      env: { PATH: process.env.PATH ?? '', ASTER_GUARD_API_KEY: 'ak_e2e', UPSTREAM_MARKER: 'visible' },
      stderr: 'pipe',
    });
    const agent = new Client({ name: 'agent', version: '0.0.0' });
    await agent.connect(transport);
    try {
      const { tools } = await agent.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo', 'env_probe']);

      guardRequests.length = 0;
      const allowed = await agent.callTool({ name: 'echo', arguments: { text: 'hi' } });
      expect(allowed.isError).toBeFalsy();
      expect(allowed.content).toEqual([{ type: 'text', text: '{"text":"hi"}' }]);

      const denied = await agent.callTool({ name: 'echo', arguments: { text: 'no', deny: true } });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([{ type: 'text', text: 'Blocked by Aster Guard: blocked in test (decision d-deny)' }]);
      expect(denied._meta?.asterGuard).toMatchObject({ status: 'denied', decisionId: 'd-deny' });
      expect((allowed._meta?.asterGuard as { decisionId: string }).decisionId).toMatch(UUID);

      const probe = await agent.callTool({ name: 'env_probe', arguments: {} });
      expect(JSON.parse((probe.content as Array<{ text: string }>)[0].text)).toEqual({
        guardKeyVisible: false,
        marker: 'visible',
      });

      expect(guardRequests).toHaveLength(3);
      const [first, second] = guardRequests;
      expect(first.method).toBe('POST');
      expect(first.url).toBe('/api/v1/guard/decisions');
      expect(first.headers.authorization).toBe('Bearer ak_e2e');
      expect(first.headers['idempotency-key']).toMatch(UUID);
      expect(second.headers['idempotency-key']).not.toBe(first.headers['idempotency-key']);
      expect(first.body).toEqual({
        policyModule: 'guard.test',
        policyFunction: 'decide',
        action: {
          principal: { id: 'agent-e2e', type: 'agent' },
          action: { name: 'echo' },
          resource: { type: 'arg', id: 'hi' },
          context: { text: 'hi' },
        },
      });
    } finally {
      await agent.close();
    }
  });

  it('null 原样保留（不再剔除）且与上游收到的参数同一规范化对象；超大 context 被服务端拒绝 → blocked', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, ...proxyArgs(), '--upstream', UPSTREAM],
      env: { PATH: process.env.PATH ?? '', ASTER_GUARD_API_KEY: 'ak_e2e' },
      stderr: 'pipe',
    });
    const agent = new Client({ name: 'agent', version: '0.0.0' });
    await agent.connect(transport);
    try {
      guardRequests.length = 0;
      const allowed = await agent.callTool({ name: 'echo', arguments: { text: 'hi', note: null, tags: ['a', null] } });
      expect(allowed.isError).toBeFalsy();
      expect(allowed.content).toEqual([{ type: 'text', text: '{"note":null,"tags":["a",null],"text":"hi"}' }]);
      expect(guardRequests).toHaveLength(1);
      expect(guardRequests[0].body.action.context).toEqual({ note: null, tags: ['a', null], text: 'hi' });

      const oversize = await agent.callTool({ name: 'echo', arguments: { text: 'x'.repeat(70_000) } });
      expect(oversize.isError).toBe(true);
      expect(oversize._meta?.asterGuard).toMatchObject({ status: 'blocked', reasonCode: 'http_400' });
    } finally {
      await agent.close();
    }
  });

  it('无上游：治理工具模式，guard_check 经 GuardClient 调用 guard HTTP', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, ...requiredArgs(), '--agent-model', 'claude-x'],
      env: { PATH: process.env.PATH ?? '', ASTER_GUARD_API_KEY: 'ak_e2e' },
      stderr: 'pipe',
    });
    const agent = new Client({ name: 'agent', version: '0.0.0' });
    await agent.connect(transport);
    try {
      const { tools } = await agent.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        'guard_check',
        'guard_status',
        'guard_list_approvals',
        'guard_approve',
        'guard_reject',
      ]);

      guardRequests.length = 0;
      const result = await agent.callTool({ name: 'guard_check', arguments: { action: { name: 'send_email' } } });
      expect(result.isError).toBe(false);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
        effectiveOutcome: 'ALLOW',
      });
      expect(guardRequests).toHaveLength(1);
      expect(guardRequests[0].body.action).toEqual({
        principal: { id: 'agent-e2e', type: 'agent' },
        action: { name: 'send_email' },
        agent: { model: 'claude-x' },
      });
    } finally {
      await agent.close();
    }
  });

  it('下游关闭 stdin → 关闭上游子进程并以 0 退出', async () => {
    const { code, stderr } = await runCli(
      [...proxyArgs(), '--upstream', UPSTREAM],
      { ASTER_GUARD_API_KEY: 'ak_e2e' },
      /代理模式已启动/,
    );
    expect(code).toBe(0);
    const pid = Number(/echo-upstream pid=(\d+)/.exec(stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('上游意外退出 → stderr 报告并以 1 退出', async () => {
    const { code, stderr } = await runCli(
      [...proxyArgs(), '--upstream', UPSTREAM],
      { ASTER_GUARD_API_KEY: 'ak_e2e', ECHO_UPSTREAM_EXIT_AFTER_MS: '1000' },
      'never',
    );
    expect(stderr).toMatch(/上游 MCP 服务器已断开/);
    expect(code).toBe(1);
  });
});
