// 按配置连接上游 MCP 服务器（ADR 0054 §12 D4）：stdio 子进程或 Streamable HTTP，返回已完成初始化的 Client。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VERSION } from '../index.js';
import { upstreamEnv, type UpstreamSpec } from './config.js';

/**
 * stdio：启动子进程，环境剔除 Guard API key（被守护的上游不应持有守门的凭据），上游 stderr 继承本进程。
 * http：authEnv 给出时以其值作 `Authorization: Bearer`；值只进请求头，不进日志。
 * 初始化失败时 SDK 关闭 transport（结束子进程）后抛出。
 */
export async function connectUpstream(spec: UpstreamSpec, env: NodeJS.ProcessEnv, apiKeyEnv: string): Promise<Client> {
  const client = new Client({ name: 'aster-guard-mcp', version: VERSION });
  if (spec.kind === 'stdio') {
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: upstreamEnv(env, apiKeyEnv) }));
    return client;
  }
  const token = spec.authEnv === undefined ? undefined : env[spec.authEnv]?.trim();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(spec.url, { requestInit: { headers } }));
  return client;
}

/** 启动日志里的上游描述：`stdio:<command>` 或 `http:<origin><path>`（不含查询串与凭据）。 */
export function describeUpstream(spec: UpstreamSpec): string {
  return spec.kind === 'stdio' ? `stdio:${spec.command}` : `http:${spec.url.origin}${spec.url.pathname}`;
}
