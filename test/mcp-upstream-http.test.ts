import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GuardClient } from '../src/client.js';
import { createGuardProxyServer, type Isolation } from '../src/mcp/index.js';
import { connectUpstream } from '../src/mcp/upstream.js';
import { CONSUME_TICKET_META_KEY } from '../src/tool/consume-ticket.js';
import { fakeApi } from './fixtures/fake-api.js';
import { startHttpUpstream, type HttpUpstream } from './fixtures/http-upstream.js';

// HTTP 上游（ADR 0054 §12 D1/D4）：代理经 Streamable HTTP 连接上游，auth 隔离时在 _meta 附 consume 票据，
// --upstream-auth-env 指定的变量作为 Bearer 发给上游。链路：agent ⇄ InMemory ⇄ 代理 ⇄ HTTP ⇄ 夹具上游。

const PRINCIPAL = { id: 'agent-42', type: 'agent' };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(isolation: readonly Isolation[], env: NodeJS.ProcessEnv = {}, authEnv?: string) {
  const http: HttpUpstream = await startHttpUpstream();
  const upstream = await connectUpstream({ kind: 'http', url: http.url, ...(authEnv ? { authEnv } : {}) }, env, 'ASTER_GUARD_API_KEY');
  const api = fakeApi();
  const proxy = createGuardProxyServer({ client: new GuardClient(api.clientOptions()), upstream, principal: PRINCIPAL, isolation });
  const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(proxySide);
  const agent = new Client({ name: 'agent', version: '0.0.0' });
  await agent.connect(agentSide);
  cleanups.push(async () => {
    await agent.close();
    await proxy.close();
    await http.close();
  });
  return { agent, api, http };
}

describe('HTTP 上游', () => {
  it('authIsolationForwardsTicketInMetaOverHttp', async () => {
    const { agent, http } = await setup(['auth', 'network']);
    const result = (await agent.callTool({ name: 'echo', arguments: { text: 'hi' } })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    const ticket = (http.calls[0].meta as Record<string, { decisionId: string; attemptId: string }>)[CONSUME_TICKET_META_KEY];
    const guard = (result._meta as { asterGuard: { decisionId: string; attemptId: string } }).asterGuard;
    expect(ticket.decisionId).toBe(guard.decisionId);
    expect(ticket.attemptId).toBe(guard.attemptId);
  });

  it('networkOnlyForwardsNoTicket', async () => {
    const { agent, http } = await setup(['network']);
    await agent.callTool({ name: 'echo', arguments: { text: 'hi' } });

    expect(http.calls).toHaveLength(1);
    expect((http.calls[0].meta as Record<string, unknown> | undefined)?.[CONSUME_TICKET_META_KEY]).toBeUndefined();
  });

  it('upstreamAuthEnvSendsBearer', async () => {
    const { agent, http } = await setup(['network'], { UPSTREAM_TOKEN: 's3cret' }, 'UPSTREAM_TOKEN');
    await agent.callTool({ name: 'echo', arguments: { text: 'hi' } });

    expect(http.calls[0].authorization).toBe('Bearer s3cret');
  });

  it('denyIsNotForwardedOverHttp', async () => {
    const { agent, api, http } = await setup(['auth', 'network']);
    api.script('DENY');
    const result = (await agent.callTool({ name: 'echo', arguments: { text: 'hi' } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(http.calls).toEqual([]);
  });
});
