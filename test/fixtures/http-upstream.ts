// 测试用 HTTP 上游：无状态 Streamable HTTP（enableJsonResponse）MCP 服务器，只有一个工具 echo。
// 记录每次 tools/call 的参数、params._meta 与 Authorization 头，以及 tools/list 的次数。只用于测试。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface UpstreamCall {
  name: string;
  arguments: unknown;
  meta: unknown;
  authorization: string | null;
}

export interface HttpUpstream {
  url: URL;
  calls: UpstreamCall[];
  /** 收到的 tools/list 次数。 */
  readonly listCount: number;
  close(): Promise<void>;
}

const ECHO = {
  name: 'echo',
  description: '原样返回参数',
  inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
};

/** 每个请求新建 Server 与 transport（无状态模式的用法）；GET / DELETE 一律 405。port 缺省为随机空闲端口。 */
export async function startHttpUpstream(port = 0): Promise<HttpUpstream> {
  const calls: UpstreamCall[] = [];
  let listCount = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') {
      res.writeHead(req.method === 'POST' ? 404 : 405).end();
      return;
    }
    const authorization = req.headers.authorization ?? null;
    const server = new Server({ name: 'http-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => {
      listCount++;
      return { tools: [ECHO] };
    });
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      calls.push({ name: request.params.name, arguments: request.params.arguments, meta: request.params._meta, authorization });
      return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments ?? {}) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
  const bound = (http.address() as AddressInfo).port;
  return {
    url: new URL(`http://127.0.0.1:${bound}/mcp`),
    calls,
    get listCount() {
      return listCount;
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** 取一个当前空闲的本地端口（先监听再关闭），用于「上游稍后才在该端口启动」的场景。 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
