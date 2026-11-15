# 变更记录

## 未发布

- 执行收据核对签名覆盖的策略地址（aster-api ADR 0040 §13 R68，#517）：`verifyExecutionReceipt` 的期望值新增 `policy: { module, function }`，`GuardClient.run`、`verifyReceipt` 与 `aster-guard-mcp`（`--policy <module>/<function>`）取自身配置；收据 `payload.policyModule / policyFunction` 缺失或不符 → `blocked receipt_invalid`（`detail: policy_mismatch`），不 consume、不执行、不转发。R66 的 `policyVersionId` 核对保留。地址键在签名内，改写即 `bad_signature`。
- **服务端版本耦合**：执行方要求 aster-api 已上线 R68（aster-api#539）；缺地址键的收据（R68 之前的 aster-api）一律拒绝（fail-closed）。aster-api 回滚到 R68 之前时，执行方须钉回 npm 上已发布的 0.2.0（不含本项核对），代理镜像钉回本项合入前的 digest。升级顺序：先 aster-api，等至少 5 分钟（收据 TTL），再升执行方。工具侧 `verifyConsumeTicket` 不变（仍核对回读的策略地址），不受此耦合影响。
- 绕过套件新增 #8（换策略模块另取 ALLOW 收据，对应 aster-api `B8PolicySwitchBypassTest`）：mock 版始终启用，本地版需 `ASTER_GUARD_LENIENT_POLICY`。
- `aster-guard-mcp` 监听模式（`--listen` + `--upstream-url`）：上游启动时不可达不再退出，后台以封顶指数退避（0.5 秒起、30 秒封顶、带抖动）重连；运行中断开同样重连、不重启进程。未就绪时 `/readyz` 为 `503`，`tools/call` 在裁决之前即以 `{ asterGuard: { status: "blocked", reasonCode: "upstream_unavailable" } }` 拒绝，不请求决策、不转发。stdio 子进程上游行为不变。

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
