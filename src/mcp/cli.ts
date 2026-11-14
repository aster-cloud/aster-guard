#!/usr/bin/env node
// aster-guard-mcp 可执行入口（ADR 0040 §6）。stdout 是 MCP 通道，所有日志一律写 stderr。
// 退出码：0 正常结束（含 --help）；1 上游无法连接或意外断开；2 参数错误。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GuardClient } from '../client.js';
import { VERSION } from '../index.js';
import { ConfigError, parseCliArgs, upstreamEnv, USAGE, wantsHelp, type ProxyConfig } from './config.js';
import { createGuardProxyServer, type GuardProxy } from './proxy.js';

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
  try {
    config = parseCliArgs(argv, process.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${NAME}: ${e.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  let upstream: Client | undefined;
  if (config.upstream) {
    try {
      upstream = await connectUpstream(config.upstream, config.apiKeyEnv);
    } catch (e) {
      log(`无法连接上游 MCP 服务器（${config.upstream.command}）：${errorMessage(e)}`);
      process.exitCode = 1;
      return;
    }
  }
  await serve(config, upstream);
}

/** 启动上游子进程并完成 MCP 初始化；失败时 SDK 会关闭 transport（结束子进程）后抛出。 */
async function connectUpstream(
  { command, args }: NonNullable<ProxyConfig['upstream']>,
  apiKeyEnv: string,
): Promise<Client> {
  const client = new Client({ name: NAME, version: VERSION });
  // 上游的 stderr 继承本进程 stderr；stdout 由 transport 接管为 MCP 通道。
  await client.connect(new StdioClientTransport({ command, args, env: upstreamEnv(process.env, apiKeyEnv) }));
  return client;
}

/**
 * 在 stdio 上提供代理服务。对下游的连接建立失败时，先关闭代理（含已启动的上游子进程）再抛出，
 * 由入口以 1 退出——否则上游子进程要等到本进程退出、管道关闭后才结束。连接成功后才接好生命周期。
 */
async function serve(config: ProxyConfig, upstream: Client | undefined): Promise<void> {
  const { baseUrl, apiKey, policyModule, policyFunction, principal } = config;
  const { approvalTimeoutMs, upstreamTimeoutMs, resourceFromArg, agentModel } = config;
  const { tenantId, executorId, isolation, tools, actions } = config;
  if (upstream && tools === undefined) {
    log('警告：未配置工具白名单（--tools 或配置文件 tools），全部上游工具都会暴露给模型');
  }
  const proxy = createGuardProxyServer({
    client: new GuardClient({ baseUrl, apiKey, policyModule, policyFunction, principal, tenantId }),
    executorId,
    isolation,
    tools,
    actions,
    upstream,
    principal,
    approvalTimeoutMs,
    upstreamTimeoutMs,
    resourceFromArg,
    agentModel,
  });

  try {
    await proxy.server.connect(new StdioServerTransport());
  } catch (e) {
    await proxy.close().catch((closeError: unknown) => log(`关闭时出错：${errorMessage(closeError)}`));
    throw e;
  }
  watchLifecycle(proxy, upstream);
  log(
    upstream
      ? `${VERSION} 代理模式已启动，上游：${config.upstream?.command}`
      : `${VERSION} 治理工具模式已启动（未指定 --upstream）`,
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
