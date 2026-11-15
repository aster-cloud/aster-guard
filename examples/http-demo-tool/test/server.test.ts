import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GuardClient } from '../../../src/client.js';
import { startHttpProxy } from '../../../src/mcp/index.js';
import { fakeApi, type FakeApi } from '../../../test/fixtures/fake-api.js';
import { DemoToolConfigError, startDemoTool } from '../src/server.js';

// 演示 HTTP 工具（aster-api ADR 0054 §12 D6）：TICKET_CHECK=on 时每个 tools/call 先核对 consume 票据，
// 核对与执行用同一个已解析的请求体；/effects 记录副作用。决策经假 aster-api。

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const GUARD_ENV = {
  ASTER_API_BASE_URL: 'https://api.test',
  ASTER_GUARD_TOOL_API_KEY: 'ak_tool',
  ASTER_GUARD_TENANT_ID: 'tenant-test',
  ASTER_GUARD_POLICY: 'guard.test/decide',
};

async function tool(api: FakeApi, env: Record<string, string> = {}) {
  const t = await startDemoTool({ PORT: '0', HOST: '127.0.0.1', ...GUARD_ENV, ...env }, { fetch: api.fetch, log: () => undefined });
  cleanups.push(() => t.close());
  return t;
}

const mcp = (url: URL) => new URL('/mcp', url);
const effects = async (url: URL, marker?: string) =>
  (await (await fetch(new URL(`/effects${marker ? `?marker=${encodeURIComponent(marker)}` : ''}`, url))).json()) as {
    count: number;
    unticketed: number;
    last: Array<{ tool: string; marker: string; decisionId: string | null; attemptId: string | null }>;
  };
const post = (url: URL, body: string) =>
  fetch(mcp(url), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body });
const call = (params: Record<string, unknown>, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params });

/**
 * 经真实代理（startHttpProxy，auth 隔离）调用一次 demo_echo，在代理把带票据的请求转发给工具之前截下请求体，
 * 不放行——票据此时已 consume 但工具未认领、代理未回写结果。返回原文与放行函数（放行时让代理的转发失败）。
 */
async function captureTicketedCall(api: FakeApi, toolUrl: URL, message: string) {
  let captured: (body: string) => void;
  const bodyPromise = new Promise<string>((resolve) => (captured = resolve));
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const fetchUpstream: typeof fetch = async (input, init) => {
    const text = typeof init?.body === 'string' ? init.body : '';
    if (text.includes('"tools/call"')) {
      captured(text);
      await held;
      return new Response('withheld', { status: 503 });
    }
    return fetch(input, init);
  };
  const upstream = new Client({ name: 'aster-guard-mcp', version: '0' });
  await upstream.connect(new StreamableHTTPClientTransport(mcp(toolUrl), { fetch: fetchUpstream }));
  const token = 'agent-token';
  const proxy = await startHttpProxy({
    listen: { host: '127.0.0.1', port: 0 },
    agents: [{ id: 'canary', tokenSha256: createHash('sha256').update(token).digest('hex') }],
    upstream,
    makeProxyOptions: () => ({ client: new GuardClient(api.clientOptions()), principal: { id: 'x', type: 'agent' }, isolation: ['auth', 'network'] }),
  });
  const agent = new Client({ name: 'agent', version: '0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL('/mcp', proxy.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const pending = agent.callTool({ name: 'demo_echo', arguments: { message } }).catch(() => undefined);
  const body = await bodyPromise;
  cleanups.push(async () => {
    release();
    await pending;
    await agent.close();
    await proxy.close();
    await upstream.close();
  });
  return body;
}

const ticketOf = (body: string) =>
  (JSON.parse(body) as { params: { _meta: Record<string, { decisionId: string; attemptId: string }> } }).params._meta['io.aster/guard-consume'];

describe('demo tool（TICKET_CHECK=on）', () => {
  it('missingTicketIs401AndNothingExecutes', async () => {
    const t = await tool(fakeApi());
    const res = await post(t.url, call({ name: 'demo_echo', arguments: { message: 'm' } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'ticket_rejected', reason: 'missing_ticket' });
    expect((await effects(t.url)).count).toBe(0);
  });

  it('forgedTicketIs401', async () => {
    const t = await tool(fakeApi());
    const envelope = { principal: { id: 'agent', type: 'agent' }, action: { name: 'demo_echo' } };
    const ticket = { decisionId: randomUUID(), attemptId: randomUUID(), envelope };
    const res = await post(t.url, call({ name: 'demo_echo', arguments: { message: 'm' }, _meta: { 'io.aster/guard-consume': ticket } }));
    expect(res.status).toBe(401);
    expect(['guard_unavailable', 'not_allowed']).toContain(((await res.json()) as { reason: string }).reason);
    expect((await effects(t.url)).count).toBe(0);
  });

  it('malformedTicketIs401', async () => {
    const t = await tool(fakeApi());
    const res = await post(t.url, call({ name: 'demo_echo', arguments: { message: 'm' }, _meta: { 'io.aster/guard-consume': { decisionId: 'x' } } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'ticket_rejected', reason: 'malformed_ticket' });
  });

  it('validTicketViaProxyExecutesOnce', async () => {
    const api = fakeApi();
    const t = await tool(api);
    const upstream = new Client({ name: 'aster-guard-mcp', version: '0' });
    await upstream.connect(new StreamableHTTPClientTransport(mcp(t.url)));
    const proxy = await startHttpProxy({
      listen: { host: '127.0.0.1', port: 0 },
      agents: [{ id: 'canary', tokenSha256: createHash('sha256').update('tok').digest('hex') }],
      upstream,
      makeProxyOptions: () => ({ client: new GuardClient(api.clientOptions()), principal: { id: 'x', type: 'agent' }, isolation: ['auth', 'network'] }),
    });
    const agent = new Client({ name: 'agent', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL('/mcp', proxy.url), { requestInit: { headers: { Authorization: 'Bearer tok' } } }));
    cleanups.push(async () => {
      await agent.close();
      await proxy.close();
      await upstream.close();
    });

    const result = (await agent.callTool({ name: 'demo_echo', arguments: { message: 'hello' } })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const guard = (result._meta as { asterGuard: { decisionId: string; attemptId: string } }).asterGuard;
    expect(result.structuredContent).toEqual({ echoed: 'hello', decisionId: guard.decisionId, attemptId: guard.attemptId });
    const snap = await effects(t.url);
    expect(snap.count).toBe(1);
    expect(snap.unticketed).toBe(0);
    expect(snap.last[0]).toMatchObject({ tool: 'demo_echo', marker: 'hello', attemptId: guard.attemptId, decisionId: guard.decisionId });
  });

  it('replayedTicketIs401', async () => {
    const api = fakeApi();
    const t = await tool(api);
    const body = await captureTicketedCall(api, t.url, 'once');

    const first = await post(t.url, body);
    expect(first.status).toBe(200);
    const replay = await post(t.url, body);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'ticket_rejected', reason: 'ticket_replayed' });
    expect((await effects(t.url)).count).toBe(1);
  });

  it('batchRequestIsRejected', async () => {
    const api = fakeApi();
    const t = await tool(api);
    const body = await captureTicketedCall(api, t.url, 'batched');
    for (const batch of [`[${body}]`, `[${call({ name: 'demo_echo', arguments: { message: 'x' } })}]`]) {
      const res = await post(t.url, batch);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'batch_not_supported' });
    }
    expect((await effects(t.url)).count).toBe(0);
  });

  it('ticketIsReadFromTheSameParsedBody', async () => {
    const api = fakeApi();
    const t = await tool(api);
    // 1) 合法 params 在前、篡改的 params 在后：JSON.parse 取后者，票据与参数不符 → 401，不执行。
    const a = await captureTicketedCall(api, t.url, 'A');
    const aParams = JSON.stringify((JSON.parse(a) as { params: unknown }).params);
    const tampered = JSON.stringify({ name: 'demo_echo', arguments: { message: 'B' }, _meta: { 'io.aster/guard-consume': ticketOf(a) } });
    const dupA = `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":${aParams},"params":${tampered}}`;
    const r1 = await post(t.url, dupA);
    expect(r1.status).toBe(401);
    expect((await effects(t.url)).count).toBe(0);

    // 2) 无票据的 params 在前、合法 params 在后：核对通过的就是执行的——记录的 marker 与 decisionId 都来自后者。
    const c = await captureTicketedCall(api, t.url, 'C');
    const cParams = JSON.stringify((JSON.parse(c) as { params: unknown }).params);
    const dupC = `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"demo_delete","arguments":{"id":"D"}},"params":${cParams}}`;
    const r2 = await post(t.url, dupC);
    expect(r2.status).toBe(200);
    const snap = await effects(t.url);
    expect(snap.count).toBe(1);
    expect(snap.last[0]).toMatchObject({ tool: 'demo_echo', marker: 'C', decisionId: ticketOf(c).decisionId });
  });

  it('只有精确的 tools/call 会执行：大小写变体不执行', async () => {
    const t = await tool(fakeApi());
    const res = await post(t.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'Tools/Call', params: { name: 'demo_echo', arguments: { message: 'm' } } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error?: { code: number } }).error?.code).toBe(-32601);
    expect((await effects(t.url)).count).toBe(0);
  });

  it('toolsListNeedsNoTicket', async () => {
    const t = await tool(fakeApi());
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(mcp(t.url)));
    cleanups.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(['demo_delete', 'demo_echo']);
  });

  it('healthz 与 413', async () => {
    const t = await tool(fakeApi());
    expect(await (await fetch(new URL('/healthz', t.url))).json()).toEqual({ status: 'ok', ticketCheck: 'on' });
    const big = call({ name: 'demo_echo', arguments: { message: 'x'.repeat(1024 * 1024) } });
    expect((await post(t.url, big)).status).toBe(413);
  });

  it('startupFailsWithoutGuardEnvWhenCheckOn', async () => {
    for (const missing of Object.keys(GUARD_ENV)) {
      const env: Record<string, string> = { PORT: '0', ...GUARD_ENV };
      delete env[missing];
      await expect(startDemoTool(env, { log: () => undefined })).rejects.toThrow(DemoToolConfigError);
    }
    await expect(startDemoTool({ PORT: '0', ...GUARD_ENV, TICKET_CHECK: 'maybe' }, { log: () => undefined })).rejects.toThrow(/TICKET_CHECK/);
    await expect(startDemoTool({ PORT: '0', ...GUARD_ENV, ASTER_GUARD_POLICY: 'nope' }, { log: () => undefined })).rejects.toThrow(
      /ASTER_GUARD_POLICY/,
    );
  });
});

describe('demo tool（TICKET_CHECK=off，仅红队副本）', () => {
  it('ticketCheckOffExecutesUnticketed', async () => {
    const logs: string[] = [];
    const t = await startDemoTool({ PORT: '0', HOST: '127.0.0.1', TICKET_CHECK: 'off' }, { log: (m) => logs.push(m) });
    cleanups.push(() => t.close());
    const res = await post(t.url, call({ name: 'demo_echo', arguments: { message: 'unticketed' } }));
    expect(res.status).toBe(200);
    const snap = await effects(t.url, 'unticketed');
    expect(snap).toMatchObject({ count: 1, unticketed: 1 });
    expect(snap.last[0]).toMatchObject({ marker: 'unticketed', decisionId: null });
    expect(await (await fetch(new URL('/healthz', t.url))).json()).toEqual({ status: 'ok', ticketCheck: 'off' });
    expect(logs.some((m) => m.includes('INSECURE'))).toBe(true);
  });
});
