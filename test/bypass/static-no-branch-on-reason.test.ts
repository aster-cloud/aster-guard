import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 绕过套件 #2b 的静态部分（ADR 0054 §2.2、§7）：reason / reasonCode / approvalId / poll / requiredRole 是非授权信息，
// 代理与 SDK 不得据此分支执行。只允许出现在返回构造、类型声明、响应解析与工具侧拒绝原因中。始终启用。

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIELDS = /\b(reason|reasonCode|approvalId|poll|requiredRole)\b/;

/** 允许出现这些字段的文件（构造 / 声明 / 解析处）。 */
const ALLOWED_FILES = new Set([
  'src/types.ts',
  'src/client.ts',
  'src/receipt.ts',
  'src/mcp/guard-result.ts',
  'src/mcp/standalone-tools.ts',
  'src/mcp/proxy.ts',
  'src/tool/consume-ticket.ts',
]);

/** 允许的「按字段值比较」：只有客户端自己产生的等待结局码（不是服务端给模型的说明）。 */
const ALLOWED_COMPARISONS = [
  "decision.reasonCode === 'wait_timeout'",
  "decision.reasonCode === 'wait_aborted'",
  "typeof body.approvalId !== 'string'",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('static-no-branch-on-reason', () => {
  const files = sources(join(ROOT, 'src')).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

  it('这些字段只出现在允许清单的文件中', () => {
    const offenders = files.filter((f) => FIELDS.test(f.text) && !ALLOWED_FILES.has(f.rel)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('没有据这些字段分支的比较（允许清单外）', () => {
    const comparisons = files.flatMap((f) =>
      [...f.text.matchAll(/(typeof\s+)?[\w.]+\.(reason|reasonCode|approvalId|poll|requiredRole)\s*(===|!==|==|!=)\s*'[^']*'/g)].map(
        (m) => m[0],
      ),
    );
    expect(comparisons.filter((c) => !ALLOWED_COMPARISONS.includes(c))).toEqual([]);
    const switches = files.filter((f) => /switch\s*\([^)]*\.(reason|reasonCode|approvalId|poll|requiredRole)\b/.test(f.text));
    expect(switches.map((f) => f.rel)).toEqual([]);
  });

  it('代理只在构造阻断结果时写这些字段', () => {
    const proxy = files.find((f) => f.rel === 'src/mcp/proxy.ts')!.text;
    const lines = proxy.split('\n').filter((l) => FIELDS.test(l));
    expect(lines.every((l) => /clientBlocked|reasonCode: 'client_error'/.test(l))).toBe(true);
  });

  it('仅测试钩子不经 CLI 暴露、不随包入口导出', () => {
    const cli = files.find((f) => f.rel === 'src/mcp/cli.ts')!.text;
    expect(cli).not.toMatch(/__beforeConsume|BEFORE_CONSUME/);
    for (const entry of ['src/index.ts', 'src/mcp/index.ts', 'src/tool/index.ts']) {
      expect(files.find((f) => f.rel === entry)!.text).not.toMatch(/internal\/hooks|BEFORE_CONSUME/);
    }
  });
});
