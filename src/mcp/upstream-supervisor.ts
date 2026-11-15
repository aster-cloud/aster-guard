// 监听模式下 HTTP 上游的连接监督：启动时连不上不退出，后台按封顶指数退避 + 抖动重连；运行中连接级失败
// 即判定断开、同样退避重连，进程不重启。未就绪时 listTools / callTool 立即抛 UpstreamUnavailableError，
// 不触达任何连接——代理据 ready() 在裁决之前就拒绝 tools/call（proxy.ts），所以重试只影响「连上游」，
// 从不影响 Guard 的「决策 → 验签 → consume → 转发 → 回写」顺序（ADR 0054 §2）。
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamClient } from './proxy.js';

/** 缺省退避：首次失败后 0.5 秒，每次翻倍，封顶 30 秒。 */
export const DEFAULT_BACKOFF: Backoff = { initialMs: 500, maxMs: 30_000 };

/** 就绪前验证连接的 tools/list 超时。 */
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000;

export interface Backoff {
  initialMs: number;
  maxMs: number;
}

/** 被监督的一条上游连接（connectUpstream 返回的 Client 满足它）。 */
export type UpstreamConnection = UpstreamClient & Partial<Pick<Client, 'onclose' | 'onerror'>>;

export interface SupervisedUpstreamOptions {
  /** 建立并初始化一条新连接；每次重试调用一次。 */
  connect: () => Promise<UpstreamConnection>;
  backoff?: Backoff;
  /** 就绪前 tools/list 验证的超时毫秒数，缺省 10000。 */
  verifyTimeoutMs?: number;
  /** 日志（stderr）。 */
  log: (message: string) => void;
  /** 仅测试：抖动用的随机数，缺省 Math.random。 */
  random?: () => number;
  /** 仅测试：等待；缺省为可被 close() 打断的计时器。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface SupervisedUpstream extends Required<UpstreamClient> {
  /** 是否持有一条经 tools/list 验证过、且之后未发现断开的连接。 */
  ready(): boolean;
}

/** 上游未就绪（启动后尚未连上，或断开后尚未重连成功）。 */
export class UpstreamUnavailableError extends McpError {
  constructor() {
    super(ErrorCode.InternalError, '上游 MCP 服务器暂不可用（upstream_unavailable），正在重连');
    this.name = 'UpstreamUnavailableError';
  }
}

/**
 * 第 attempt 次（从 0 起）失败后的等待：上限 = min(maxMs, initialMs·2^attempt)，实际取 [上限/2, 上限] 内均匀随机
 * （equal jitter：多副本不会同步重连，也不会退化成立即重试）。
 */
export function backoffDelay(attempt: number, backoff: Backoff, random: () => number = Math.random): number {
  const ceiling = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(attempt, 64));
  return ceiling / 2 + (random() * ceiling) / 2;
}

/**
 * 连接级失败：请求没有得到上游的 MCP 应答（fetch 失败 / 非 2xx / 连接已关闭）。上游的 JSON-RPC 错误、
 * 请求超时与下游取消都不算——上游仍在应答，换连接无济于事。
 */
function isConnectivityError(e: unknown): boolean {
  if (e instanceof McpError) return e.code === ErrorCode.ConnectionClosed;
  return e instanceof StreamableHTTPError || e instanceof TypeError;
}

/** 错误说明；undici 的 `fetch failed` 附上底层原因码（ECONNREFUSED / ENOTFOUND / ETIMEDOUT 等）便于排查。 */
function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${e.message}: ${code}` : e.message;
}

/** 一条连接与其在途请求数；断开后（retired）等在途请求结束再关闭，不打断已转发的调用。 */
interface Link {
  conn: UpstreamConnection;
  inflight: number;
  retired: boolean;
}

/** 新建监督器并立即在后台开始第一次连接。 */
export function superviseUpstream(options: SupervisedUpstreamOptions): SupervisedUpstream {
  return new Supervisor(options);
}

class Supervisor implements SupervisedUpstream {
  private current: Link | undefined;
  private reconnecting: Promise<void> | undefined;
  private closed = false;
  private wake: (() => void) | undefined;
  private readonly backoff: Backoff;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SupervisedUpstreamOptions) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => this.interruptibleSleep(ms));
    this.reconnect();
  }

  ready(): boolean {
    return this.current !== undefined;
  }

  listTools: UpstreamClient['listTools'] = (...args) => this.use((conn) => conn.listTools(...args));

  callTool: UpstreamClient['callTool'] = (...args) => this.use((conn) => conn.callTool(...args));

  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    const link = this.current;
    this.current = undefined;
    // 不等在途的重连：它在 closed 之后拿到的连接会被 adopt() 直接关闭。
    if (link) await link.conn.close().catch(() => undefined);
  }

  /** 用当前连接执行一次请求；没有连接即 UpstreamUnavailableError，连接级失败则判定断开。 */
  private async use<T>(op: (conn: UpstreamConnection) => Promise<T>): Promise<T> {
    const link = this.current;
    if (!link) throw new UpstreamUnavailableError();
    link.inflight++;
    try {
      return await op(link.conn);
    } catch (e) {
      if (isConnectivityError(e)) this.lost(link, errorMessage(e));
      throw e;
    } finally {
      link.inflight--;
      if (link.retired && link.inflight === 0) void link.conn.close().catch(() => undefined);
    }
  }

  /** 判定该连接已断开：摘掉、退役并开始重连。对已退役的旧连接重复调用无效。 */
  private lost(link: Link, why: string): void {
    if (this.current !== link) return;
    this.current = undefined;
    link.retired = true;
    if (link.inflight === 0) void link.conn.close().catch(() => undefined);
    if (this.closed) return;
    this.options.log(`上游连接中断（${why}），开始重连`);
    this.reconnect(true);
  }

  /**
   * 至多一个重连循环；成功即采用新连接。启动时立即尝试；断开后先等第一档退避再尝试——
   * 否则「验证通过、调用即失败」的上游会让代理以请求速率反复重连。
   */
  private reconnect(afterDrop = false): void {
    this.reconnecting ??= this.loop(afterDrop).finally(() => (this.reconnecting = undefined));
  }

  private async loop(afterDrop: boolean): Promise<void> {
    if (afterDrop) await this.sleep(backoffDelay(0, this.backoff, this.random));
    for (let attempt = afterDrop ? 1 : 0; !this.closed; attempt++) {
      const conn = await this.attempt(attempt);
      if (conn) return this.adopt(conn, attempt);
    }
  }

  /** 一次连接 + tools/list 验证；失败时关闭半成品连接、记一行日志并退避，返回 undefined。 */
  private async attempt(attempt: number): Promise<UpstreamConnection | undefined> {
    let conn: UpstreamConnection | undefined;
    try {
      conn = await this.options.connect();
      await conn.listTools(undefined, { timeout: this.options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS });
      return conn;
    } catch (e) {
      await conn?.close().catch(() => undefined);
      if (this.closed) return undefined;
      const delay = backoffDelay(attempt, this.backoff, this.random);
      this.options.log(`无法连接上游（${errorMessage(e)}），${formatSeconds(delay)} 秒后重试（第 ${attempt + 1} 次）`);
      await this.sleep(delay);
      return undefined;
    }
  }

  private adopt(conn: UpstreamConnection, attempt: number): void {
    if (this.closed) {
      void conn.close().catch(() => undefined);
      return;
    }
    const link: Link = { conn, inflight: 0, retired: false };
    this.current = link;
    // 传输层自行关闭（如 SDK 内部出错）同样视为断开；连接级错误已在 use() 里按请求判定，onerror 不再重复记录。
    conn.onclose = () => this.lost(link, '连接已关闭');
    conn.onerror = () => undefined;
    this.options.log(attempt === 0 ? '上游已连接' : `上游已连接（第 ${attempt + 1} 次尝试）`);
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

function formatSeconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}
