// ESLint 9 flat config：src 与 test 的 TS 用 typescript-eslint recommended；
// 仓库内的 Node 脚本与测试夹具（.mjs）用 @eslint/js recommended，并声明 Node 全局变量。
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
