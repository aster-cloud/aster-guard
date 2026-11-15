// 子路径入口 @aster-cloud/aster-guard/mcp：在宿主侧程序里嵌入 aster-guard-mcp 代理（ADR 0040 §6）。
// 公开代理工厂、Streamable HTTP 服务端（ADR 0054 §12 D4）与 Agent 登记读取；CLI 解析与治理工具实现属于内部细节。
export { createGuardProxyServer } from './proxy.js';
export type { GuardClientLike, GuardProxy, GuardProxyOptions, Isolation, ToolNameCache, UpstreamClient } from './proxy.js';
export { startHttpProxy } from './http-server.js';
export type { HttpProxy, HttpProxyOptions } from './http-server.js';
export { loadAgents } from './agents.js';
export type { AgentEntry } from './agents.js';
