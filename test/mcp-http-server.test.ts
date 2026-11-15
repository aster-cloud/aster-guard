import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardClient } from '../src/client.js';
import { parseCliArgs } from '../src/mcp/config.js';
import { startHttpProxy } from '../src/mcp/index.js';
import { connectUpstream } from '../src/mcp/upstream.js';
import { superviseUpstream } from '../src/mcp/upstream-supervisor.js';
import { CONSUME_TICKET_META_KEY } from '../src/tool/consume-ticket.js';
import { fakeApi } from './fixtures/fake-api.js';
import { freePort, startHttpUpstream, type HttpUpstream } from './fixtures/http-upstream.js';

// 无状态 Streamable HTTP 服务端（ADR 0054 §3.1、§12 D4）：真实 HTTP 客户端 → 代理 → HTTP 上游夹具，
// 决策经假 aster-api。每个请求新建 MCP 服务器与 transport，工具名缓存跨请求共享。

const sha = (token: string) => createHash('sha256').update(token).digest('hex');
const AGENTS = [
  { id: 'agent-a', tokenSha256: sha('token-a') },
  { id: 'agent-b', tokenSha256: sha('token-b'), principalId: 'principal-b', principalRoles: ['ops'] },
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup() {
  const upstreamHttp = await startHttpUpstream();
  const upstream = await connectUpstream({ kind: 'http', url: upstreamHttp.url }, {}, 'ASTER_GUARD_API_KEY');
  const api = fakeApi();
  const clock = { t: 1_000_000 };
  const proxy = await startHttpProxy({
    listen: { host: '127.0.0.1', port: 0 },
    agents: AGENTS,
    upstream,
    // 故意给出错误的 principal：服务端必须以登记项为准覆盖它。
    makeProxyOptions: () => ({
      client: new GuardClient(api.clientOptions()),
      principal: { id: 'spoofed', type: 'agent' },
      isolation: ['auth', 'network'],
    }),
    now: () => clock.t,
  });
  cleanups.push(async () => {
    await proxy.close();
    await upstream.close();
    await upstreamHttp.close();
  });
  const mcpUrl = new URL('/mcp', proxy.url);
  const agent = async (token: string) => {
    const client = new Client({ name: 'agent', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    cleanups.push(() => client.close());
    return client;
  };
  return { api, proxy, mcpUrl, upstreamHttp, agent, clock };
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});
const post = (url: URL, body: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body,
  });

describe('startHttpProxy', () => {
  it('unregisteredTokenIs401AndGuardIsNeverCalled', async () => {
    const { api, mcpUrl } = await setup();
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Basic token-a' }]) {
      const res = await post(mcpUrl, INIT, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(api.requests).toHaveLength(0);
  });

  it('eachAgentDecidesWithItsOwnPrincipal', async () => {
    const { api, agent } = await setup();
    await (await agent('token-a')).callTool({ name: 'echo', arguments: { text: 'a' } });
    await (await agent('token-b')).callTool({ name: 'echo', arguments: { text: 'b' } });

    const principals = api.requests
      .filter((r) => r.method === 'POST' && r.path === '/api/v1/guard/decisions')
      .map((r) => (r.body as { action: { principal: unknown } }).action.principal);
    expect(principals).toEqual([
      { id: 'agent-a', type: 'agent' },
      { id: 'principal-b', type: 'agent', roles: ['ops'] },
    ]);
  });

  it('allowedCallExecutesOnceThroughHttp', async () => {
    const { agent, upstreamHttp } = await setup();
    const result = (await (await agent('token-a')).callTool({ name: 'echo', arguments: { text: 'hi' } })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(upstreamHttp.calls).toHaveLength(1);
    const ticket = (upstreamHttp.calls[0].meta as Record<string, { attemptId: string }>)[CONSUME_TICKET_META_KEY];
    expect(ticket.attemptId).toBe((result._meta as { asterGuard: { attemptId: string } }).asterGuard.attemptId);
  });

  it('deniedCallIsNotForwarded', async () => {
    const { api, agent, upstreamHttp } = await setup();
    api.script('DENY');
    const result = (await (await agent('token-a')).callTool({ name: 'echo', arguments: { text: 'hi' } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect((result._meta as { asterGuard: { status: string } }).asterGuard.status).toBe('denied');
    expect(upstreamHttp.calls).toEqual([]);
  });

  it('toolsListIsFetchedOncePerCacheNotPerRequest', async () => {
    const { agent, upstreamHttp } = await setup();
    const client = await agent('token-a');
    for (const text of ['1', '2', '3']) await client.callTool({ name: 'echo', arguments: { text } });
    const other = await agent('token-b');
    await other.callTool({ name: 'echo', arguments: { text: '4' } });

    expect(upstreamHttp.calls).toHaveLength(4);
    expect(upstreamHttp.listCount).toBe(1);
  });

  it('oversizedBodyIs413', async () => {
    const { api, mcpUrl, upstreamHttp } = await setup();
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x'.repeat(1024 * 1024) } } });
    const res = await post(mcpUrl, big, { Authorization: 'Bearer token-a' });

    expect(res.status).toBe(413);
    expect(api.requests).toHaveLength(0);
    expect(upstreamHttp.calls).toEqual([]);
  });

  it('非 JSON 请求体为 400 解析错误', async () => {
    const { mcpUrl } = await setup();
    const res = await post(mcpUrl, '{oops', { Authorization: 'Bearer token-a' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it('getMcpIs405 与其它路径', async () => {
    const { proxy, mcpUrl } = await setup();
    expect((await fetch(mcpUrl, { headers: { Authorization: 'Bearer token-a' } })).status).toBe(405);
    expect((await fetch(mcpUrl, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(new URL('/other', proxy.url))).status).toBe(404);
    const health = await fetch(new URL('/healthz', proxy.url));
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
  });

  it('readyzIs503WhenUpstreamDown', async () => {
    const { proxy, upstreamHttp, clock } = await setup();
    const readyz = () => fetch(new URL('/readyz', proxy.url)).then((r) => r.status);
    expect(await readyz()).toBe(200);
    await upstreamHttp.close();
    // 缓存 10 s 内仍返回上次结论；30 s 窗口内最近一次成功仍算就绪。
    clock.t += 5_000;
    expect(await readyz()).toBe(200);
    clock.t += 20_000;
    expect(await readyz()).toBe(200);
    clock.t += 11_000;
    expect(await readyz()).toBe(503);
  });

  it('listenModeRejectsPrincipalId', () => {
    const base = ['--base-url', 'https://api.example.com', '--policy', 'guard.demo/decide', '--tenant-id', 't'];
    const http = ['--upstream-url', 'http://tool:8080/mcp', '--isolation', 'network,auth'];
    const env = { ASTER_GUARD_API_KEY: 'k' };
    const listen = ['--listen', '0.0.0.0:8080', '--agents-file', '/etc/aster-guard/agents.json'];
    expect(parseCliArgs([...base, ...http, ...listen], env)).toMatchObject({
      listen: { host: '0.0.0.0', port: 8080 },
      agentsFile: '/etc/aster-guard/agents.json',
    });
    expect(() => parseCliArgs([...base, ...http, ...listen, '--principal-id', 'x'], env)).toThrow(/principal 取自 --agents-file/);
    expect(() => parseCliArgs([...base, ...http, ...listen, '--principal-roles', 'x'], env)).toThrow(/principal 取自 --agents-file/);
  });
});

/**
 * 上游重连（#466 阶段 C 生产问题）：监听模式下上游启动时不可达不退出；未就绪时 /readyz 503、
 * tools/call 在裁决之前即以 upstream_unavailable 拒绝（Guard 无请求、上游无调用）；上游起来 / 恢复后就绪。
 */
describe('startHttpProxy：上游重连', () => {
  async function setupSupervised(upstreamUp: boolean) {
    const port = await freePort();
    const holder: { http?: HttpUpstream } = {};
    if (upstreamUp) holder.http = await startHttpUpstream(port);
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const logs: string[] = [];
    const upstream = superviseUpstream({
      connect: () => connectUpstream({ kind: 'http', url }, {}, 'ASTER_GUARD_API_KEY'),
      backoff: { initialMs: 20, maxMs: 100 },
      log: (m) => logs.push(m),
    });
    const api = fakeApi();
    const clock = { t: 1_000_000 };
    const proxy = await startHttpProxy({
      listen: { host: '127.0.0.1', port: 0 },
      agents: AGENTS,
      upstream,
      makeProxyOptions: () => ({
        client: new GuardClient(api.clientOptions()),
        principal: { id: 'spoofed', type: 'agent' },
        isolation: ['auth', 'network'],
      }),
      now: () => clock.t,
    });
    cleanups.push(async () => {
      await proxy.close();
      await upstream.close();
      await holder.http?.close();
    });
    const client = new Client({ name: 'agent', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', proxy.url), { requestInit: { headers: { Authorization: 'Bearer token-a' } } }),
    );
    cleanups.push(() => client.close());
    const status = (path: string) => fetch(new URL(path, proxy.url)).then((r) => r.status);
    /** 推进时钟越过 /readyz 缓存，直到就绪状态等于 expected。 */
    const readyzBecomes = (expected: number) =>
      vi.waitFor(
        async () => {
          clock.t += 11_000;
          expect(await status('/readyz')).toBe(expected);
        },
        { timeout: 5_000, interval: 20 },
      );
    const start = async () => {
      holder.http = await startHttpUpstream(port);
      return holder.http;
    };
    const decisions = () => api.requests.filter((r) => r.path === '/api/v1/guard/decisions').length;
    return { api, upstream, client, status, readyzBecomes, start, holder, logs, decisions };
  }

  const guardOf = (result: CallToolResult) => (result._meta as { asterGuard: Record<string, unknown> }).asterGuard;

  it('upstreamDownAtStart：healthz 200、readyz 503，tools/call 被拒且未裁决未转发；上游起来后就绪并放行', async () => {
    const { api, upstream, client, status, readyzBecomes, start, logs } = await setupSupervised(false);

    expect(await status('/healthz')).toBe(200);
    expect(await status('/readyz')).toBe(503);
    expect(upstream.ready()).toBe(false);

    const refused = (await client.callTool({ name: 'echo', arguments: { text: 'early' } })) as CallToolResult;
    expect(refused.isError).toBe(true);
    expect(guardOf(refused)).toEqual({
      status: 'blocked',
      reasonCode: 'upstream_unavailable',
      reason: expect.stringContaining('未裁决、未转发'),
    });
    // 工具定义未知：载荷只在 _meta，不放 structuredContent。
    expect(refused.structuredContent).toBeUndefined();
    await expect(client.listTools()).rejects.toThrow(/upstream_unavailable/);
    expect(api.requests).toEqual([]);

    const http = await start();
    await readyzBecomes(200);
    expect(http.calls).toEqual([]);
    expect(logs.some((m) => /无法连接上游/.test(m))).toBe(true);

    const allowed = (await client.callTool({ name: 'echo', arguments: { text: 'later' } })) as CallToolResult;
    expect(allowed.isError).toBeFalsy();
    expect(http.calls.map((c) => c.arguments)).toEqual([{ text: 'later' }]);
  });

  it('upstreamDropAndRecover：断开即不就绪、调用被拒不裁决；同址恢复后不重启进程即可放行', async () => {
    const { client, readyzBecomes, start, holder, decisions, upstream } = await setupSupervised(true);
    await readyzBecomes(200);
    const first = (await client.callTool({ name: 'echo', arguments: { text: 'one' } })) as CallToolResult;
    expect(first.isError).toBeFalsy();
    expect(decisions()).toBe(1);

    await holder.http!.close();
    // readyz 的探测撞上断开的上游 → 监督器判定断开 → 立即 503（不等 30 秒窗口）。
    await readyzBecomes(503);
    expect(upstream.ready()).toBe(false);

    const refused = (await client.callTool({ name: 'echo', arguments: { text: 'two' } })) as CallToolResult;
    expect(guardOf(refused)).toMatchObject({ status: 'blocked', reasonCode: 'upstream_unavailable' });
    // 已知工具（echo 未声明 outputSchema）被拒时照常另放 structuredContent。
    expect(refused.structuredContent).toEqual({ asterGuard: guardOf(refused) });
    expect(decisions()).toBe(1);

    const revived = await start();
    await readyzBecomes(200);
    const third = (await client.callTool({ name: 'echo', arguments: { text: 'three' } })) as CallToolResult;
    expect(third.isError).toBeFalsy();
    expect(revived.calls.map((c) => c.arguments)).toEqual([{ text: 'three' }]);
    expect(decisions()).toBe(2);
  });
});
