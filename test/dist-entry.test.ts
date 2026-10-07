import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 发布物以 dist/ 为准：本测试验证 tsc 产物（NodeNext 下的 ESM）可被直接加载，且 package.json 的 exports 指向它们。
// 依赖先构建后测试，由 package.json 的 test 脚本（pnpm run build && vitest run）保证。

const ROOT = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf-8')) as {
  version: string;
  scripts: Record<string, string>;
  exports: Record<string, Record<string, string>>;
};

/** 以消费方的方式（Node 按包名自引用，经 exports 解析）加载子路径，返回其运行时导出名。 */
function exportedNames(specifier: string): string[] {
  const script = `const m = await import(${JSON.stringify(specifier)}); console.log(JSON.stringify(Object.keys(m)));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(ROOT),
    encoding: 'utf-8',
  });
  return JSON.parse(out) as string[];
}

describe('包入口（dist 产物）', () => {
  it('dist/index.js 可加载，导出的 VERSION 与 package.json 一致', async () => {
    const entry = await import('../dist/index.js');
    expect(entry.VERSION).toBe(pkg.version);
  });

  it('dist/index.js 导出 GuardClient', async () => {
    const entry = await import('../dist/index.js');
    expect(typeof entry.GuardClient).toBe('function');
  });

  it('包名 @aster-cloud/aster-guard 经 exports 解析到 GuardClient 与 VERSION', () => {
    expect(exportedNames('@aster-cloud/aster-guard').sort()).toEqual(['GuardClient', 'VERSION']);
  });

  it('子路径 @aster-cloud/aster-guard/mcp 经 exports 解析，运行时只导出 createGuardProxyServer', () => {
    expect(exportedNames('@aster-cloud/aster-guard/mcp')).toEqual(['createGuardProxyServer']);
  });

  it('发布前先构建：prepublishOnly 运行 build，手动 pnpm publish 不会带上陈旧或缺失的 dist/', () => {
    expect(pkg.scripts.prepublishOnly).toBe('pnpm run build');
  });

  it('exports 的每个条件都指向已构建的文件；./mcp 的类型声明含选项与返回类型', () => {
    expect(Object.keys(pkg.exports)).toEqual(['.', './mcp']);
    for (const conditions of Object.values(pkg.exports)) {
      expect(Object.keys(conditions)[0]).toBe('types');
      for (const target of Object.values(conditions)) {
        expect(existsSync(new URL(target, ROOT)), target).toBe(true);
      }
    }
    const dts = readFileSync(new URL(pkg.exports['./mcp'].types, ROOT), 'utf-8');
    for (const name of ['createGuardProxyServer', 'GuardProxyOptions', 'GuardProxy', 'GuardClientLike', 'UpstreamClient']) {
      expect(dts).toContain(name);
    }
  });
});
