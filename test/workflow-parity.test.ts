import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

// 发布守卫（aster-api ADR 0054 §11 D6）：release.yml 的 ci job 与 ci.yml 的 test job 步骤逐条一致——
// aster-lang-ts 的教训是 release 漏了 ci 的步骤，发布时才失败。只忽略 name 与注释。

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** 抽出某个 job 的步骤序列（uses / run / with.repository），按出现顺序。 */
function steps(workflow: string, job: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  expect(start, `job ${job}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    const m = /^\s*-?\s*(uses|run|repository):\s*(.+)$/.exec(line);
    if (m && !line.trim().startsWith('#')) out.push(`${m[1]}: ${m[2].trim()}`);
  }
  return out;
}

describe('release workflow parity', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');

  it('release ci job 的步骤序列 === ci test job', () => {
    expect(steps(release, 'ci')).toEqual(steps(ci, 'test'));
  });

  it('publish job：frozen install + build，组织级 NPM_TOKEN + provenance + id-token', () => {
    const publish = steps(release, 'publish');
    expect(publish).toContain('run: pnpm install --frozen-lockfile');
    expect(publish).toContain('run: pnpm run build');
    expect(release).toMatch(/id-token: write/);
    expect(release).toMatch(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    expect(release).toMatch(/pnpm publish --no-git-checks --provenance --access public/);
    if (steps(ci, 'test').some((s) => s.includes('repository:'))) {
      expect(publish.some((s) => s.includes('repository:'))).toBe(true);
    }
  });

  it('VERSION === package.json.version', () => {
    expect(VERSION).toBe((JSON.parse(read('package.json')) as { version: string }).version);
  });
});
