import { defineConfig } from 'vitest/config';

// 测试位于 test/ 与 examples/*/test/（在 tsconfig 的 rootDir 之外），由 vitest 直接编译 TS。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
  },
});
