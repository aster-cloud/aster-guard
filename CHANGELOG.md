# 变更记录

## 0.2.0（未发布）

首个发布版本（0.1.0 从未发布）。实现 aster-api ADR 0054（执行点）与 R66 修订。

- `GuardClient.run`：按固定顺序「哈希 → 决策 → 验签 → consume → 执行 → 回写」运行受守卫动作；没有跳过验签 / consume 的选项。
- 执行收据离线验签与 JWKS 缓存（ADR 0040 §12 D6），并核对收据 `policyVersionId` 与同一响应的策略版本（#517）。
- `jcs-sha256/v1` 规范化与 `hashAction`，共享向量与 aster-api 逐字节一致。
- 低层 `keys / verifyReceipt / consume / reportResult`；`reportSideEffects`（#465，工具侧上报用）。
- `aster-guard-mcp`：工具白名单、按工具 action 映射（`resourceFrom / digestArgs / actionName`）、`--tenant-id / --isolation / --executor-id / --config`；DENY / PENDING / 阻断返回结构化载荷（`_meta.asterGuard`）。
- 新子路径 `@aster-cloud/aster-guard/tool`：`auth` 隔离的工具侧 consume 票据核对与原子 `AttemptLedger`。
- 行为变化：`null` 参数不再剔除；ALLOW 须收据验签 + consume 才转发；代理模式 `--tenant-id`、`--isolation` 必填。
- 绕过夹具套件 `test/bypass/`（ADR 0054 §7）。
