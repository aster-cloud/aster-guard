import { describe, expect, it } from 'vitest';

// 发布物以 dist/ 为准：本测试验证 tsc 产物（NodeNext 下的 ESM）可被直接加载。
// 依赖先构建后测试，由 package.json 的 test 脚本（pnpm run build && vitest run）保证。
describe('包入口（dist 产物）', () => {
  it('dist/index.js 可加载并导出 VERSION', async () => {
    const entry = await import('../dist/index.js');
    expect(entry.VERSION).toBe('0.1.0');
  });
});
