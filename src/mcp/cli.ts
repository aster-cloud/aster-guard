#!/usr/bin/env node
// aster-guard-mcp 可执行入口（ADR 0040 §6）。stdout 是 MCP 通道，所有日志一律写 stderr。
// 退出码：0 正常结束（含 --help）；1 上游无法连接或意外断开（监听模式的 HTTP 上游除外：后台重连，不退出）；2 参数错误。
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GuardClient } from '../client.js';
import { VERSION } from '../index.js';
import type { GuardPrincipal } from '../types.js';
import { loadAgents, type AgentEntry } from './agents.js';
import { ConfigError, parseCliArgs, USAGE, wantsHelp, type ProxyConfig } from './config.js';
import { agentPrincipal, startHttpProxy } from './http-server.js';
import { createGuardProxyServer, type GuardProxy, type GuardProxyOptions, type UpstreamClient } from './proxy.js';
import { connectUpstream, describeUpstream } from './upstream.js';
import { superviseUpstream } from './upstream-supervisor.js';

const NAME = 'aster-guard-mcp';

/**
 * 关闭的兜底时限。正常情况下关闭连接后事件循环自然清空；若仍有句柄未释放
 * （如正在等待审批的轮询计时器），到时强制退出。计时器 unref，不会单独拖住进程。
 */
const SHUTDOWN_GRACE_MS = 5_000;

function log(message: string): void {
  process.stderr.write(`${NAME}: ${message}\n`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    process.stdout.write(USAGE);
    return;
  }
  let config: ProxyConfig;
  let agents: AgentEntry[] | undefined;
  try {
    config = parseCliArgs(argv, process.env);
    agents = config.agentsFile === undefined ? undefined : loadAgents(config.agentsFile);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${NAME}: ${e.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  // 监听模式 + HTTP 上游：不在启动时等上游。立即开始服务（/healthz 200、/readyz 503），后台退避重连；
  // 未就绪期间 tools/call 在裁决之前即被拒（upstream_unavailable）。stdio 子进程上游的启动失败多为配置错误，仍按原样退出。
  if (config.listen && agents && config.upstream?.kind === 'http') {
    const spec = config.upstream;
    const upstream = superviseUpstream({
      connect: () => connectUpstream(spec, process.env, config.apiKeyEnv),
      log: (message) => log(`${describeUpstream(spec)}：${message}`),
    });
    await serveHttp(config, config.listen, agents, upstream);
    return;
  }
  let upstream: Client | undefined;
  if (config.upstream) {
    try {
      upstream = await connectUpstream(config.upstream, process.env, config.apiKeyEnv);
    } catch (e) {
      log(`无法连接上游 MCP 服务器（${describeUpstream(config.upstream)}）：${errorMessage(e)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (config.listen && agents && upstream) {
    upstream.onerror = (e) => log(`上游 MCP 错误：${e.message}`);
    await serveHttp(config, config.listen, agents, upstream);
  } else {
    await serve(config, upstream);
  }
}

/** 两种服务方式共用的代理选项；principal 由调用方给出（stdio 取配置，监听模式取 Agent 登记）。 */
function proxyOptions(config: ProxyConfig, principal: GuardPrincipal): Omit<GuardProxyOptions, 'upstream'> {
  const { baseUrl, apiKey, policyModule, policyFunction, tenantId } = config;
  return {
    client: new GuardClient({ baseUrl, apiKey, policyModule, policyFunction, principal, tenantId }),
    executorId: config.executorId,
    isolation: config.isolation,
    tools: config.tools,
    actions: config.actions,
    principal,
    approvalTimeoutMs: config.approvalTimeoutMs,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    resourceFromArg: config.resourceFromArg,
    agentModel: config.agentModel,
  };
}

function warnIfNoAllowList(config: ProxyConfig): void {
  if (config.upstream && config.tools === undefined) {
    log('警告：未配置工具白名单（--tools 或配置文件 tools），全部上游工具都会暴露给模型');
  }
}

/**
 * 监听模式：无状态 Streamable HTTP（ADR 0054 §12 D4）。每个 Agent 的 GuardClient 在启动时构造一次。
 * SIGTERM / SIGINT：停止接受新连接，等在途请求结束（至多 SHUTDOWN_GRACE_MS）后关闭上游并以 0 退出。
 */
async function serveHttp(
  config: ProxyConfig,
  listen: NonNullable<ProxyConfig['listen']>,
  agents: readonly AgentEntry[],
  upstream: UpstreamClient,
): Promise<void> {
  warnIfNoAllowList(config);
  let http;
  try {
    http = await startHttpProxy({
      listen,
      agents,
      upstream,
      makeProxyOptions: (agent) => proxyOptions(config, agentPrincipal(agent)),
    });
  } catch (e) {
    await upstream.close().catch(() => undefined);
    throw e;
  }
  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    process.exitCode = code;
    setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
    http
      .close()
      .then(() => upstream.close())
      .catch((e: unknown) => log(`关闭时出错：${errorMessage(e)}`));
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  log(
    `${VERSION} 监听模式已启动：${http.url.origin}/mcp，上游：${config.upstream ? describeUpstream(config.upstream) : ''}，` +
      `已登记 ${agents.length} 个 Agent`,
  );
}

/**
 * 在 stdio 上提供代理服务。对下游的连接建立失败时，先关闭代理（含已启动的上游子进程）再抛出，
 * 由入口以 1 退出——否则上游子进程要等到本进程退出、管道关闭后才结束。连接成功后才接好生命周期。
 */
async function serve(config: ProxyConfig, upstream: Client | undefined): Promise<void> {
  // 非监听模式下 parseCliArgs 保证 principal 存在。
  const principal = config.principal as GuardPrincipal;
  warnIfNoAllowList(config);
  const proxy = createGuardProxyServer({ ...proxyOptions(config, principal), upstream });

  try {
    await proxy.server.connect(new StdioServerTransport());
  } catch (e) {
    await proxy.close().catch((closeError: unknown) => log(`关闭时出错：${errorMessage(closeError)}`));
    throw e;
  }
  watchLifecycle(proxy, upstream);
  log(
    config.upstream
      ? `${VERSION} 代理模式已启动，上游：${describeUpstream(config.upstream)}`
      : `${VERSION} 治理工具模式已启动（未指定上游）`,
  );
}

/** 生命周期：下游断开或收到信号 → 关闭上游后以 0 退出；上游意外断开 → 以 1 退出。 */
function watchLifecycle(proxy: GuardProxy, upstream: Client | undefined): void {
  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    process.exitCode = code;
    setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();
    proxy.close().catch((e: unknown) => log(`关闭时出错：${errorMessage(e)}`));
  };

  proxy.server.onclose = () => shutdown(0);
  proxy.server.onerror = (e) => log(`MCP 服务器错误：${e.message}`);
  if (upstream) {
    upstream.onclose = () => {
      if (closing) return;
      log('上游 MCP 服务器已断开');
      shutdown(1);
    };
    upstream.onerror = (e) => log(`上游 MCP 错误：${e.message}`);
  }
  // StdioServerTransport 不监听 stdin 结束；不处理的话，上游子进程的管道会让本进程在下游断开后继续挂着。
  process.stdin.once('end', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
}

main(process.argv.slice(2)).catch((e: unknown) => {
  log(`启动失败：${errorMessage(e)}`);
  process.exitCode = 1;
});
