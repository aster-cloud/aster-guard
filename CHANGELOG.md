# 变更记录

## 0.3.0

实现 aster-api ADR 0054 §3.1 / §12 D1 / D4（#466 阶段 C）与 ADR 0040 §13 R68（#517）。**要求 aster-api 已上线 R68**，见下文「服务端版本耦合」。

### 新增

- HTTP 上游：`--upstream-url <url>` 让代理经 Streamable HTTP 连接上游 MCP 服务器（与 `--upstream` 二选一）；`--upstream-auth-env <name>` 以该环境变量的值作 `Authorization: Bearer` 发给上游（不能与 API key 变量同名，值不进日志与错误信息）。
- Streamable HTTP 监听模式：`--listen <host>:<port>` 以无状态 Streamable HTTP 提供服务（`POST /mcp`；`GET` / `DELETE` 为 `405`；请求体上限 1 MiB）；`--agents-file` 登记 Agent（只存 token 的 sha256，定长比较，每个 Agent 以自己的主体裁决，监听模式不接受 `--principal-*`）；`GET /healthz`（存活）与 `GET /readyz`（最近 30 秒内上游 `tools/list` 成功，结论缓存 10 秒）。嵌入入口 `startHttpProxy`、`loadAgents`。
- `--isolation` 接受逗号列表（去重），可声明 `network,auth` 两层；单值写法照常可用。
- 上游重连与退避（#7）：监听模式下 HTTP 上游启动时不可达不再退出，后台以封顶指数退避（0.5 秒起、30 秒封顶、带抖动）重连；运行中断开同样重连、不重启进程。未就绪时 `/readyz` 为 `503`，`tools/call` 在裁决之前即以 `{ asterGuard: { status: "blocked", reasonCode: "upstream_unavailable" } }` 拒绝，不请求决策、不转发。stdio 子进程上游行为不变。
- 演示工具 `examples/http-demo-tool`（不发布）与 `aster-guard-mcp` / 演示工具容器镜像（cosign 签名，合入 main 自动 pin 到 k3s）。

### 行为变化

- 执行收据核对签名覆盖的策略地址（aster-api ADR 0040 §13 R68，#517）：`verifyExecutionReceipt` 的期望值新增 `policy: { module, function }`，`GuardClient.run`、`verifyReceipt` 与 `aster-guard-mcp`（`--policy <module>/<function>`）取自身配置；收据 `payload.policyModule / policyFunction` 缺失或不符 → `blocked receipt_invalid`（`detail: policy_mismatch`），不 consume、不执行、不转发。R66 的 `policyVersionId` 核对保留。地址键在签名内，改写即 `bad_signature`。工具侧 `verifyConsumeTicket` 不变（仍核对回读的策略地址）。
- 绕过套件新增 #8（换策略模块另取 ALLOW 收据，对应 aster-api `B8PolicySwitchBypassTest`）：mock 版始终启用，本地版需 `ASTER_GUARD_LENIENT_POLICY`。

### 服务端版本耦合（回滚）

- 0.3.0 执行方要求 aster-api 已上线 R68（aster-api#539）；缺地址键的收据（R68 之前的 aster-api 签发，或 R68 上线前签发、尚在 TTL 内）一律拒绝（fail-closed，不会误放行，但受守卫动作全部停摆）。
- 升级顺序：先部署含 R68 的 aster-api，等至少 5 分钟（收据 TTL），再升级执行方到 0.3.0。0.2.0 在 R68 服务端上照常工作。
- aster-api 回滚到 R68 之前（或自托管的 aster-api 没有 R68）时，执行方须钉回 `@aster-cloud/aster-guard@0.2.0`，代理镜像钉回 R68 核对合入前的 digest。

## 0.2.0

首个发布版本（0.1.0 从未发布）。实现 aster-api ADR 0054（执行点）与 R66 修订。

- `GuardClient.run`：按固定顺序「哈希 → 决策 → 验签 → consume → 执行 → 回写」运行受守卫动作；没有跳过验签 / consume 的选项。
- 执行收据离线验签与 JWKS 缓存（ADR 0040 §12 D6），并核对收据 `policyVersionId` 与同一响应的策略版本（#517）。
- `jcs-sha256/v1` 规范化与 `hashAction`，共享向量与 aster-api 逐字节一致。
- 低层 `keys / verifyReceipt / consume / reportResult`；`reportSideEffects`（#465，工具侧上报用）。
- `aster-guard-mcp`：工具白名单、按工具 action 映射（`resourceFrom / digestArgs / actionName`）、`--tenant-id / --isolation / --executor-id / --config`；DENY / PENDING / 阻断返回结构化载荷（`_meta.asterGuard`）。
- 新子路径 `@aster-cloud/aster-guard/tool`：`auth` 隔离的工具侧 consume 票据核对与原子 `AttemptLedger`。
- 行为变化：`null` 参数不再剔除；ALLOW 须收据验签 + consume 才转发；代理模式 `--tenant-id`、`--isolation` 必填。
- 绕过夹具套件 `test/bypass/`（ADR 0054 §7）。
