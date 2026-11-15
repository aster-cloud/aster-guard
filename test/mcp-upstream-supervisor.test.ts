import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  superviseUpstream,
  UpstreamUnavailableError,
  type SupervisedUpstream,
  type UpstreamConnection,
} from '../src/mcp/upstream-supervisor.js';

// 监听模式 HTTP 上游的重连监督（不经 Guard）：启动时上游不可达不退出、后台按封顶指数退避 + 抖动重连；
// 运行中连接级失败即判定断开并重连；未就绪时 listTools / callTool 立即抛 UpstreamUnavailableError、不触达任何连接。

const TOOLS: Tool[] = [{ name: 'echo', inputSchema: { type: 'object' } }];
const FAST = { initialMs: 2, maxMs: 8 };

/** 可编排的假上游连接：listTools / callTool 的行为由 behaviour 决定，记录调用与关闭。 */
function fakeConnection(id: number) {
  const conn = {
    id,
    closed: false,
    calls: 0,
    lists: 0,
    listBehaviour: (): Promise<{ tools: Tool[] }> => Promise.resolve({ tools: TOOLS }),
    callBehaviour: (): Promise<unknown> => Promise.resolve({ content: [{ type: 'text', text: `from ${id}` }] }),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    listTools: () => {
      conn.lists++;
      return conn.listBehaviour();
    },
    callTool: () => {
      conn.calls++;
      return conn.callBehaviour();
    },
    close: async () => {
      if (conn.closed) return;
      conn.closed = true;
      conn.onclose?.();
    },
  };
  return conn;
}
type FakeConnection = ReturnType<typeof fakeConnection>;

/** connect 前 failures 次失败（fetch failed），之后每次返回一个新的假连接。 */
function connector(failures = 0) {
  const made: FakeConnection[] = [];
  let attempts = 0;
  const connect = vi.fn(async (): Promise<UpstreamConnection> => {
    attempts++;
    if (attempts <= failures) throw new TypeError('fetch failed');
    const conn = fakeConnection(made.length);
    made.push(conn);
    return conn as unknown as UpstreamConnection;
  });
  return { connect, made, setFailures: (n: number) => (failures = attempts + n) };
}

const open: SupervisedUpstream[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

function supervise(connect: () => Promise<UpstreamConnection>, log = vi.fn<(m: string) => void>()) {
  const upstream = superviseUpstream({ connect, backoff: FAST, verifyTimeoutMs: 100, log });
  open.push(upstream);
  return { upstream, log };
}

describe('backoffDelay', () => {
  it('从 initialMs 起翻倍、封顶 maxMs；抖动只在 [上限/2, 上限] 内', () => {
    const backoff = { initialMs: 500, maxMs: 30_000 };
    const ceilings = Array.from({ length: 10 }, (_, attempt) => backoffDelay(attempt, backoff, () => 1));
    expect(ceilings).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000]);
    expect(backoffDelay(0, backoff, () => 0)).toBe(250);
    expect(backoffDelay(9, backoff, () => 0)).toBe(15_000);
  });

  it('任意重试次数与随机数都不超过 maxMs（含溢出的大次数）', () => {
    const backoff = { initialMs: 500, maxMs: 30_000 };
    for (const attempt of [0, 5, 6, 50, 1023, 1024, 10_000, Number.MAX_SAFE_INTEGER]) {
      for (const r of [0, 0.5, 0.999999]) {
        const d = backoffDelay(attempt, backoff, () => r);
        expect(d).toBeGreaterThanOrEqual(250);
        expect(d).toBeLessThanOrEqual(30_000);
      }
    }
  });
});

describe('superviseUpstream', () => {
  it('启动时上游不可达：未就绪期间立即拒绝且不触达连接，重试成功后就绪', async () => {
    const { connect, made } = connector(3);
    const { upstream, log } = supervise(connect);

    expect(upstream.ready()).toBe(false);
    await expect(upstream.callTool({ name: 'echo', arguments: {} })).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await expect(upstream.listTools()).rejects.toBeInstanceOf(UpstreamUnavailableError);

    await vi.waitFor(() => expect(upstream.ready()).toBe(true));
    expect(connect).toHaveBeenCalledTimes(4);
    expect(made).toHaveLength(1);
    expect(made[0].calls).toBe(0);
    // 就绪前用 tools/list 验证过一次。
    expect(made[0].lists).toBe(1);

    const result = await upstream.callTool({ name: 'echo', arguments: {} });
    expect(result).toEqual({ content: [{ type: 'text', text: 'from 0' }] });
    const lines = log.mock.calls.map(([m]) => m);
    expect(lines.filter((m) => /无法连接上游/.test(m))).toHaveLength(3);
    expect(lines.some((m) => /上游已连接/.test(m))).toBe(true);
  });

  it('连接成功但 tools/list 验证失败：关闭该连接、继续重试', async () => {
    const made: FakeConnection[] = [];
    const connect = vi.fn(async () => {
      const conn = fakeConnection(made.length);
      if (made.length === 0) conn.listBehaviour = () => Promise.reject(new StreamableHTTPError(503, 'unavailable'));
      made.push(conn);
      return conn as unknown as UpstreamConnection;
    });
    const { upstream } = supervise(connect);

    await vi.waitFor(() => expect(upstream.ready()).toBe(true));
    expect(made).toHaveLength(2);
    expect(made[0].closed).toBe(true);
    expect(made[1].closed).toBe(false);
  });

  it('运行中连接级失败（fetch failed）→ 立即不就绪，按退避重连到新连接', async () => {
    const { connect, made } = connector();
    const { upstream, log } = supervise(connect);
    await vi.waitFor(() => expect(upstream.ready()).toBe(true));

    made[0].callBehaviour = () => Promise.reject(new TypeError('fetch failed'));
    await expect(upstream.callTool({ name: 'echo', arguments: {} })).rejects.toThrow('fetch failed');
    expect(upstream.ready()).toBe(false);
    await expect(upstream.callTool({ name: 'echo', arguments: {} })).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(made[0].calls).toBe(1);

    await vi.waitFor(() => expect(upstream.ready()).toBe(true));
    expect(made).toHaveLength(2);
    // 旧连接没有在途请求，断开后即关闭。
    expect(made[0].closed).toBe(true);
    expect(await upstream.callTool({ name: 'echo', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'from 1' }] });
    expect(log.mock.calls.some(([m]) => /上游连接中断/.test(m))).toBe(true);
  });

  it('断开期间上游仍不可达：持续退避重试，恢复后就绪', async () => {
    const { connect, made, setFailures } = connector();
    const { upstream } = supervise(connect);
    await vi.waitFor(() => expect(upstream.ready()).toBe(true));

    setFailures(4);
    made[0].listBehaviour = () => Promise.reject(new StreamableHTTPError(502, 'bad gateway'));
    await expect(upstream.listTools()).rejects.toThrow('bad gateway');
    expect(upstream.ready()).toBe(false);

    await vi.waitFor(() => expect(upstream.ready()).toBe(true));
    expect(connect).toHaveBeenCalledTimes(1 + 4 + 1);
  });

  it('连接被关闭（onclose）→ 不就绪并重连', async () => {
    const { connect, made } = connector();
    const { upstream } = supervise(connect);
    await vi.waitFor(() => expect(upstream.ready()).toBe(true));

    await made[0].close();
    expect(upstream.ready()).toBe(false);
    await vi.waitFor(() => expect(upstream.ready()).toBe(true));
    expect(made).toHaveLength(2);
  });

  it('上游的 MCP 协议错误、超时与下游取消不算断开', async () => {
    const { connect, made } = connector();
    const { upstream } = supervise(connect);
    await vi.waitFor(() => expect(upstream.ready()).toBe(true));

    for (const error of [
      new McpError(ErrorCode.InvalidParams, 'Unknown tool'),
      new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
      new DOMException('This operation was aborted', 'AbortError'),
    ]) {
      made[0].callBehaviour = () => Promise.reject(error);
      await expect(upstream.callTool({ name: 'echo', arguments: {} })).rejects.toBe(error);
      expect(upstream.ready()).toBe(true);
    }
    expect(connect).toHaveBeenCalledTimes(1);
    expect(made[0].closed).toBe(false);
  });

  it('在途请求不被断开打断：旧连接在最后一个在途请求结束后才关闭', async () => {
    const { connect, made } = connector();
    const { upstream } = supervise(connect);
    await vi.waitFor(() => expect(upstream.ready()).toBe(true));

    let finishSlow!: (v: unknown) => void;
    made[0].callBehaviour = () => new Promise((resolve) => (finishSlow = resolve));
    const slow = upstream.callTool({ name: 'echo', arguments: {} });
    made[0].listBehaviour = () => Promise.reject(new TypeError('fetch failed'));
    await expect(upstream.listTools()).rejects.toThrow('fetch failed');

    await vi.waitFor(() => expect(upstream.ready()).toBe(true));
    expect(made[0].closed).toBe(false);
    finishSlow({ content: [] });
    await expect(slow).resolves.toEqual({ content: [] });
    expect(made[0].closed).toBe(true);
  });

  it('close() 停止重试并关闭当前连接；之后一律不可用', async () => {
    const { connect } = connector(Number.MAX_SAFE_INTEGER);
    const { upstream } = supervise(connect);
    await vi.waitFor(() => expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2));
    await upstream.close();
    const attempts = connect.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(connect).toHaveBeenCalledTimes(attempts);
    expect(upstream.ready()).toBe(false);
    await expect(upstream.callTool({ name: 'echo', arguments: {} })).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it('close() 时连接 / 验证仍在途：之后才成功的连接被直接关闭，不会就绪', async () => {
    const conn = fakeConnection(0);
    let finishVerify!: () => void;
    conn.listBehaviour = () => new Promise((resolve) => (finishVerify = () => resolve({ tools: TOOLS })));
    const connect = vi.fn(async () => conn as unknown as UpstreamConnection);
    const { upstream } = supervise(connect);
    await vi.waitFor(() => expect(conn.lists).toBe(1));

    await upstream.close();
    finishVerify();
    await vi.waitFor(() => expect(conn.closed).toBe(true));
    expect(upstream.ready()).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('close() 关闭已就绪的连接', async () => {
    const { connect, made } = connector();
    const { upstream } = supervise(connect);
    await vi.waitFor(() => expect(upstream.ready()).toBe(true));
    await upstream.close();
    expect(made[0].closed).toBe(true);
    expect(upstream.ready()).toBe(false);
  });

  it('重试间隔不超过封顶值（退避真实生效）', async () => {
    const waits: number[] = [];
    const { connect } = connector(Number.MAX_SAFE_INTEGER);
    const upstream = superviseUpstream({
      connect,
      backoff: { initialMs: 500, maxMs: 30_000 },
      random: () => 1,
      log: () => undefined,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 12) await new Promise(() => undefined);
      },
    });
    open.push(upstream);
    await vi.waitFor(() => expect(waits).toHaveLength(12));
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
  });

  it('日志不刷屏：每次失败恰一行并给出下次间隔，退避封顶后即至多每 30 秒一行', async () => {
    const lines: string[] = [];
    const waits: number[] = [];
    const { connect } = connector(Number.MAX_SAFE_INTEGER);
    const upstream = superviseUpstream({
      connect,
      backoff: { initialMs: 500, maxMs: 30_000 },
      random: () => 1,
      log: (m) => lines.push(m),
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 20) await new Promise(() => undefined);
      },
    });
    open.push(upstream);
    await vi.waitFor(() => expect(waits).toHaveLength(20));
    // 每次失败恰一行，且行内给出下次重试的间隔。
    expect(lines).toHaveLength(20);
    expect(lines[0]).toMatch(/无法连接上游.*fetch failed.*0\.5 秒后重试（第 1 次）/);
    expect(lines[19]).toMatch(/30 秒后重试（第 20 次）/);
  });
});
