// 包入口：GuardClient 与公开类型（ADR 0040 §6）。
export { GuardClient } from './client.js';
export type * from './types.js';

export const VERSION = '0.1.0';
