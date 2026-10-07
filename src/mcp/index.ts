// 子路径入口 @aster-cloud/aster-guard/mcp：在宿主侧程序里嵌入 aster-guard-mcp 代理（ADR 0040 §6）。
// 只公开代理工厂及其选项 / 返回类型；CLI 解析与治理工具实现属于内部细节。
export { createGuardProxyServer } from './proxy.js';
export type { GuardClientLike, GuardProxy, GuardProxyOptions, UpstreamClient } from './proxy.js';
