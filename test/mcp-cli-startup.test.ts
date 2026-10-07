import { afterEach, describe, expect, it, vi } from 'vitest';

// cli.ts 的启动失败路径：上游已连上，但对下游的 stdio 通道建立失败。真实进程里无法从外部触发这种失败，
// 因此在进程内运行 cli.ts，用 vi.mock 把两端的 stdio transport 换成可控实现（上游为内存假服务器）。

const fakes = vi.hoisted(() => ({ upstreamClosed: vi.fn() }));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  return {
    StdioClientTransport: vi.fn(function () {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const upstream = new Server({ name: 'fake-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
      upstream.onclose = fakes.upstreamClosed;
      void upstream.connect(serverSide);
      return clientSide;
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(function () {
    return {
      start: async () => {
        throw new Error('stdio unavailable');
      },
      close: async () => undefined,
      send: async () => undefined,
    };
  }),
}));

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('aster-guard-mcp CLI：启动失败', () => {
  it('对下游的 stdio 连接失败 → 先关闭已启动的上游，再以退出码 1 结束', async () => {
    vi.stubEnv('ASTER_GUARD_API_KEY', 'ak_startup');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const argv = process.argv;
    process.argv = [
      argv[0],
      'aster-guard-mcp',
      '--base-url',
      'http://127.0.0.1:9',
      '--policy',
      'guard.test/decide',
      '--principal-id',
      'agent-startup',
      '--upstream',
      'fake-upstream',
    ];
    try {
      await import('../src/mcp/cli.js');
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
    } finally {
      process.argv = argv;
    }

    expect(fakes.upstreamClosed).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('启动失败：stdio unavailable');
  });
});
