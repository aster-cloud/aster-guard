// 包入口：GuardClient 与公开类型（ADR 0040 §6）。
export { GuardClient } from './client.js';
export { canonicalize, hashAction, jcsSha256, JcsError, parseStrictJson } from './hash/jcs.js';
export type { JcsErrorCode } from './hash/jcs.js';
export type * from './types.js';

export const VERSION = '0.2.0';
