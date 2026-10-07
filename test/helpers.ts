import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { expect, vi } from 'vitest';
import type { GuardClientLike } from '../src/mcp/index.js';

// 多个测试文件共用的小工具：UUID 形态、mock GuardClient、取工具结果文本、以子进程运行 Node 脚本。

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 代理用到的全部 GuardClient 方法，均为未设定行为的 vi.fn()。 */
export function mockGuard() {
  return {
    check: vi.fn<GuardClientLike['check']>(),
    get: vi.fn<GuardClientLike['get']>(),
    waitFor: vi.fn<GuardClientLike['waitFor']>(),
    listApprovals: vi.fn<GuardClientLike['listApprovals']>(),
    approve: vi.fn<GuardClientLike['approve']>(),
    reject: vi.fn<GuardClientLike['reject']>(),
  };
}

/** 取工具结果中唯一一段文本内容。 */
export function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return content[0].text ?? '';
}

/**
 * 以最小环境（只继承 PATH）运行 Node 脚本直到其 stdio 全部关闭，返回退出码与完整输出。
 * stdin 的关闭时机：'now' 立即；RegExp 在 stderr 匹配后；'never' 保持打开（验证非 stdin 触发的退出）。
 * 超过 killAfterMs 仍未结束则 SIGKILL，让断言失败而不是留下孤儿进程。
 */
export async function runNode(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  { killAfterMs, closeStdin = 'now' }: { killAfterMs: number; closeStdin?: 'now' | 'never' | RegExp },
) {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (closeStdin instanceof RegExp && closeStdin.test(stderr)) child.stdin.end();
  });
  if (closeStdin === 'now') child.stdin.end();
  const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
  try {
    // 等 close 而不是 exit：close 在子进程的 stdio 流全部结束后才触发，输出此时已读完整。
    const [code] = (await once(child, 'close')) as [number | null];
    return { code, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}
