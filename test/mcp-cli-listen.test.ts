import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freePort, startHttpUpstream, type HttpUpstream } from './fixtures/http-upstream.js';

// CLI 监听模式（构建产物 dist/mcp/cli.js 子进程）：HTTP 上游启动时不可达 → 进程不退出、立即提供服务，
// /healthz 200、/readyz 503，tools/call 以 upstream_unavailable 拒绝；上游稍后起来 → /readyz 200。#466 阶段 C 生产问题的回归。

const CLI = fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url));
const TEST_TIMEOUT_MS = 20_000;

const children: ChildProcessWithoutNullStreams[] = [];
const servers: HttpUpstream[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const server of servers.splice(0)) await server.close();
});

function agentsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aster-guard-listen-'));
  const path = join(dir, 'agents.json');
  writeFileSync(path, JSON.stringify({ agents: [{ id: 'agent-a', tokenSha256: createHash('sha256').update('token-a').digest('hex') }] }));
  return path;
}

describe('aster-guard-mcp CLI：监听模式上游重连', { timeout: TEST_TIMEOUT_MS }, () => {
  it('上游启动时不可达：不退出、healthz 200 / readyz 503、调用被拒；上游起来后 readyz 200；SIGTERM 以 0 退出', async () => {
    const [listenPort, upstreamPort] = [await freePort(), await freePort()];
    const child = spawn(
      process.execPath,
      [
        CLI,
        // Guard 指向无人监听的地址：若代理在未就绪时去裁决，会得到 client_error 而不是 upstream_unavailable。
        ...['--base-url', 'http://127.0.0.1:9', '--policy', 'guard.test/decide', '--tenant-id', 't'],
        ...['--upstream-url', `http://127.0.0.1:${upstreamPort}/mcp`, '--isolation', 'network'],
        ...['--listen', `127.0.0.1:${listenPort}`, '--agents-file', agentsFile(), '--tools', 'echo'],
      ],
      { env: { PATH: process.env.PATH, ASTER_GUARD_API_KEY: 'ak_listen' } },
    );
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const base = `http://127.0.0.1:${listenPort}`;
    const status = (path: string) =>
      fetch(base + path)
        .then((r) => r.status)
        .catch(() => 0);

    await vi.waitFor(async () => expect(await status('/healthz')).toBe(200), { timeout: 5_000, interval: 50 });
    expect(await status('/readyz')).toBe(503);

    const agent = new Client({ name: 'agent', version: '0.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: 'Bearer token-a' } } }));
    const refused = (await agent.callTool({ name: 'echo', arguments: { text: 'early' } })) as CallToolResult;
    expect(refused.isError).toBe(true);
    expect(refused._meta?.asterGuard).toMatchObject({ status: 'blocked', reasonCode: 'upstream_unavailable' });

    // 至少失败重试过一次后再让上游起来。
    await vi.waitFor(() => expect(stderr).toMatch(/无法连接上游（fetch failed: ECONNREFUSED），[\d.]+ 秒后重试（第 1 次）/), {
      timeout: 5_000,
    });
    const upstream = await startHttpUpstream(upstreamPort);
    servers.push(upstream);
    await vi.waitFor(async () => expect(await status('/readyz')).toBe(200), { timeout: 12_000, interval: 100 });
    expect(stderr).toMatch(/上游已连接（第 \d+ 次尝试）/);
    expect(upstream.calls).toEqual([]);
    expect(child.exitCode).toBeNull();
    await agent.close();

    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/启动失败/);
  });
});
