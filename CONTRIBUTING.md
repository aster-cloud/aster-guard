# 贡献指南 · Contributing to aster-guard

感谢你有意为 Aster Action Guard 的 TypeScript 客户端与 MCP 代理贡献力量！Thanks for contributing.

## 开始之前 · Before You Start

- 阅读 [README](README.md) 了解本仓职责。
- 遵守 [行为准则](CODE_OF_CONDUCT.md)。
- 安全问题请走 [SECURITY.md](SECURITY.md)（**不要**开公开 issue）。

## 本地验证 · Local Verification

```bash
pnpm install
pnpm run typecheck   # 类型检查（仅 src）
pnpm run lint        # ESLint（src + test）
pnpm test            # 先 build，再 vitest run（含 dist 入口测试）
pnpm run build       # tsc 构建到 dist/
```

改动**必须**在本地跑通上述四项后再提 PR。涉及 guard HTTP 契约（`/api/v1/guard/*`）的改动，
须与 aster-api 的 ADR 0040 保持一致；fail-closed 语义（任何非 200 / 网络错误 / 超时均按 DENY）
不得放宽。

## 提交流程 · Pull Request Flow

1. 从 `main` 切分支（`fix/…`、`feat/…`、`docs/…`）。
2. 小步提交；提交信息用祈使语气说明「做了什么 + 为什么」。
3. PR 描述附本地验证结果；等 CI 全绿后再请求合并。

## 许可证 · License

贡献即表示你同意你的贡献按本仓 [LICENSE](LICENSE)（Apache-2.0）授权。
By contributing, you agree your contributions are licensed under Apache-2.0.
