// 测试用上游 MCP 服务器（stdio）：供 mcp-cli.test.ts 以子进程方式驱动 aster-guard-mcp。
// echo 原样返回参数；env_probe 报告本进程能否看到 guard 的 API key 与测试标记变量。
// 设置 ECHO_UPSTREAM_EXIT_AFTER_MS 时，到时主动退出，用于验证代理在上游断开时的处理。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: 'echo', description: 'Echo arguments', inputSchema: { type: 'object' } },
    { name: 'env_probe', description: 'Report environment visibility', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const payload =
    request.params.name === 'env_probe'
      ? { guardKeyVisible: 'ASTER_GUARD_API_KEY' in process.env, marker: process.env.UPSTREAM_MARKER ?? null }
      : (request.params.arguments ?? {});
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
});

await server.connect(new StdioServerTransport());
process.stderr.write(`echo-upstream pid=${process.pid}\n`);

const exitAfterMs = Number(process.env.ECHO_UPSTREAM_EXIT_AFTER_MS);
if (exitAfterMs > 0) setTimeout(() => process.exit(3), exitAfterMs);
