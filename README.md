# @aster-cloud/aster-guard

AI 行动守门（Action Guard）的客户端与 MCP 代理。

AI Agent 在执行有副作用的动作之前（删除客户记录、转账、发邮件……），先向 aster-api 提交这个**提议动作**，由租户已部署的 Aster 策略规则裁决：放行、拒绝、需要人工审批或升级复核。每一次裁决都会在 aster-api 的审计链上留下收据。

本包提供两样东西：

- **`GuardClient`**：调用 aster-api `/api/v1/guard/*` 的 TypeScript SDK。
- **`aster-guard-mcp`**：MCP 代理（stdio，或 `--listen` 时为 Streamable HTTP 服务）。包在任意上游 MCP 服务器（stdio 子进程或 HTTP）外面，对每一次 `tools/call` 先过 guard，再决定是否转发。

设计依据见 aster-api 仓库 `docs/adr/0040-action-guard.md`（ADR 0040：Action Guard，本包对应 §6），随子项目 2 合并后可见。

> **当前状态：0.3.0（HTTP 上游 / 监听模式与 R68 策略地址核对，要求 aster-api 已上线 ADR 0040 §13 R68，见「服务端版本要求与回滚」）。** 0.2.0 已发布（执行点，aster-api ADR 0054 / R66）；0.1.0 从未发布。0.2.0 起 Guard 是**执行点**而不是建议：只有本次决策的执行收据验签通过且 consume 成功，动作才会执行。行为变化见文末「0.3.0 行为变化」与「0.2.0 行为变化」。

## 安装

要求 Node.js ≥ 24，纯 ESM 包。

```bash
pnpm add @aster-cloud/aster-guard
# 或
npm install @aster-cloud/aster-guard
```

## 鉴权

所有 `/api/v1/guard/*` 请求都使用 aster-api 的 API key：

```
Authorization: Bearer ak_…
```

API key 同时决定租户、计量与配额。审批的「四眼」规则也会比对提交决策所用的 API key：提交某个动作的 key 不能批准同一动作（见 ADR 0040 §4.2）。

## GuardClient

### 推荐入口：`run`（ADR 0054 §2.1）

```ts
const guard = new GuardClient({ baseUrl, apiKey, policyModule: 'guard.customer', policyFunction: 'decide',
  principal: { id: 'agent-42', type: 'agent' }, tenantId: 'team-1' /* API key 所属租户，核对收据用 */ });

const outcome = await guard.run(
  { action: { name: 'delete_customer_record' }, resource: { type: 'customer', id: 'C-1001' }, context: { amount: 250000 } },
  async (grant) => deleteCustomerRecord('C-1001'), // 只有 consume 200 之后才会被调用
  { executorId: 'billing-worker@pod-3', approvalTimeoutMs: 300_000 },
);
// outcome.kind: 'executed' | 'blocked' | 'pending' | 'failed'
```

`run` 的顺序固定，任一步失败即返回、回调不被调用：`hashAction(action)`（jcs-sha256/v1，与请求体是同一个对象）→ `POST /decisions`（PENDING 则等待审批）→ 执行收据验签（JWKS 缓存 300 s；`payload.tenantId / decisionId / outcome / 时间窗 / actionHash`；签名覆盖的 `payload.policyModule / policyFunction` 必须**存在**且等于本客户端配置的 `policyModule / policyFunction`（aster-api ADR 0040 §13 R68）；`payload.policyVersionId` 必须等于同一响应的 `policyVersion.id`（ADR 0054 §11 D12）。收据的 `actionHash` 不含策略地址，同租户换一个宽松模块会得到同一 actionHash 的 ALLOW，所以地址缺失或不符一律 `receipt_invalid`（`policy_mismatch`），见下文「服务端版本要求与回滚」）→ consume（consume 时按当前对象**重算**哈希，决策后被改动的动作得到 409 `action_mismatch`）→ 回调 → 结果回写。没有任何跳过验签或 consume 的选项；只有本次请求的决策 consume 成功才是授权，别处读到的 ALLOW 或收据都不是（§11.4）。

- `executorId` 缺省 `aster-guard-sdk@<hostname>`（#465 对账的执行方标签）；须 ≤ 255 字符、无控制字符。
- consume 响应丢失（超时 / 断网 / 5xx）：不执行，尽力回写 `aborted / consume_response_lost`，返回 `blocked client_timeout|client_error`。
- 回调抛错：回写 `failed` 后以 `failed` 返回原错误；`classify` 可把返回值归为 `failed`（如工具业务错误）。回写失败不影响结局。
- 值必须可按 jcs-sha256/v1 表示：`NaN`、`Infinity`、`undefined`（顶层可选键除外）、`bigint`、`Date` 等非纯对象、|x| > 2^53−1 的数在发送前即 `blocked client_error`（大数请用字符串）。
- 低层方法 `check / verifyReceipt / consume / reportResult / keys / hashAction` 公开，供代理与测试使用。
- `reportSideEffects(effects)`（#465）给**工具侧 / 业务系统**上报实际落地的副作用；代理与 `run` 是执行方，不上报。

### 低层：`check`

用法（ADR 0040 §6）：

```ts
import { GuardClient } from '@aster-cloud/aster-guard';

const guard = new GuardClient({
  baseUrl: 'https://api.aster-lang.cloud',
  apiKey: process.env.ASTER_API_KEY!, // ak_…
  policyModule: 'guard.customer',
  policyFunction: 'decide',
  principal: { id: 'agent-42', type: 'agent', roles: ['ops-bot'] },
});

const decision = await guard.check({
  action: { name: 'delete_customer_record' },
  resource: { type: 'customer', id: 'C-1001' },
  context: { amount: 250000, currency: 'NZD' },
});

switch (decision.effectiveOutcome) {
  case 'ALLOW':
    await deleteCustomerRecord('C-1001');
    break;
  case 'PENDING': {
    // 等人工审批；超时或被拒绝都按 DENY 处理
    const final = await guard.waitFor(decision.decisionId, { timeoutMs: 300_000, intervalMs: 2_000 });
    if (final.effectiveOutcome === 'ALLOW') await deleteCustomerRecord('C-1001');
    break;
  }
  case 'DENY':
    throw new Error(`动作被拒绝：${decision.reason ?? decision.reasonCode}`);
}
```

方法：

| 方法 | 说明 |
|---|---|
| `check(action, { idempotencyKey?, waitSeconds? })` | `POST /api/v1/guard/decisions`，返回 `GuardDecision`；`action.principal` 缺省取配置；未给 `idempotencyKey` 时每次调用生成新的 UUID |
| `get(decisionId)` | `GET /api/v1/guard/decisions/{id}`，读取当前状态 |
| `waitFor(decisionId, { timeoutMs = 300000, intervalMs = 2000, signal? })` | 轮询直到服务端给出非 PENDING 结论；瞬时失败（网络、超时、5xx、429）继续轮询，其他失败立即返回 DENY；到时返回 DENY `wait_timeout`；`signal` 中止后返回 DENY `wait_aborted`。三者都保留 decisionId |
| `listApprovals(status = 'PENDING', page = 0, size = 20)` | `GET /api/v1/guard/approvals`，返回 `{ ok: true, items, page, size }` 或 `{ ok: false, … }` |
| `getApprovalInput(id)` | `GET /api/v1/guard/approvals/{id}/input`：审批输入的打码视图（无副作用），返回 `{ ok: true, input }` 或 `{ ok: false, … }`，见下文「审批输入」 |
| `revealApprovalInput(id)` | `POST /api/v1/guard/approvals/{id}/input/reveal`：解除 `@pii` 原值（持所需业务角色者，按人记入审计链） |
| `approve(id, { comment?, businessRole?, inputSnapshotHash? })` | `POST /api/v1/guard/approvals/{id}/approve`；`businessRole` 作为 `X-User-Business-Role` 头发送。HTTP 头只能携带 Latin-1 字符，非 Latin-1 的角色名（如中文）会在发出前被拒绝，得到 `{ ok: false, status: 0, error: 'client_error' }` |
| `reject(id, { comment, businessRole?, inputSnapshotHash? })` | `POST /api/v1/guard/approvals/{id}/reject`；`comment` 必填，缺失时客户端直接返回 `comment_required`；`businessRole` 同 `approve`（仅限 Latin-1 字符） |

### 审批输入（aster-api ADR 0042 §12）

审批人可以在审批前查看决策输入的脱敏视图：

- `input` 中 `@pii` 字段为 `{ "$pii": { "level": "L2", "category": "email" } }`，策略未声明的子树为 `{ "$pii": { "level": "unknown" } }`（键名也不展示，任何人都不能解除）。
- `revealApprovalInput` 只对 `PENDING` 且持有所需业务角色的审批人开放（ESCALATE 不可解除），只还原已声明的 `@pii` 字段；每人每审批首次解除写一条 `ACTION_GUARD_INPUT_REVEAL` 审计事件。失败码：403 `reveal_not_permitted`、409 `input_not_available` / `approval_not_pending`、503 `receipt_unavailable`（此时不返回原值）。两个端点对非法 id 与跨租户一律 404 `approval_not_found`。请求体为空对象 `{}`。
- 批准 / 拒绝时把所见视图的 `inputSnapshotHash` 一并提交，服务端记下 `inputSnapshotMatched` / `inputRevealed`；视图已变化返回 409 `input_snapshot_mismatch`，刷新后重试。
- `status` 不是 `available`（`unavailable` / `purged` / `integrity_failed` / `too_large`）时没有 `input` 与哈希，照常审批、不带哈希。旧 aster-api 没有该端点（404）时同样按「不可用」处理。

```ts
const view = await guard.getApprovalInput(approvalId);
const hash = view.ok && view.input.status === 'available' ? view.input.inputSnapshotHash : undefined;
const r = await guard.approve(approvalId, { comment: '已核对', inputSnapshotHash: hash });
```

`effectiveOutcome` 是调用方唯一需要看的字段：`ALLOW` 才可执行；`DENY` 不执行；`PENDING` 继续轮询。

`check` / `get` / `waitFor` 对 guard 结果从不抛异常；`waitFor` 的非法选项（如负的 `timeoutMs`）属于编程错误，抛 `TypeError`。客户端无法确认结论时返回 `decisionId: ''`、`effectiveOutcome: 'DENY'` 的决策，`reasonCode` 为：`http_<status>`（非 2xx）、`idempotency_mismatch`（422）、`client_error`（网络错误、响应体不合契约）、`client_timeout`（单次请求超时，默认 12 秒，为服务端 10 秒评估超时留出余量，`timeoutMs` 可配；带 `waitSeconds` 时自动延长）。审批操作不是 guard 结论，失败时返回 `{ ok: false, status, error, message }`，`error` 为服务端错误码（如 `segregation_of_duties`）；未收到 HTTP 响应时 `status` 为 0。

## aster-guard-mcp

stdio MCP 服务器（ADR 0040 §6；`--listen` 时为 Streamable HTTP，见下节）。指定 `--upstream` 或 `--upstream-url` 时包裹该上游 MCP 服务器：原样转发 `tools/list`，并拦截每一次 `tools/call`：

1. 工具须在白名单内（`--tools` / 配置文件 `tools`；未配置则全部暴露并在启动时告警）；参数先**规范化**：递归按键排序、`null` 原样保留、不删键不改类型。规范化后的对象既是 `action.context` 也是转发给上游的 `arguments`（同一对象）；按工具映射 `digestArgs` 列出的键在 `context` 中以 `{ "$sha256": … }` 代入（转发原值）。
2. `GuardClient.run` 按固定顺序执行：决策（新 UUID 幂等键；PENDING 等到 `--approval-timeout`）→ 收据验签 → consume → 转发 → 回写（`executed` / `failed`，`resultHash` 为 `content` 的 jcs-sha256/v1）。
3. 返回：ALLOW 时为上游原值并附 `_meta.asterGuard = { decisionId, attemptId }`；规则 DENY、等待超时仍 PENDING、验签 / consume / 网络失败分别返回 `isError: true` 与结构化载荷 `{ asterGuard: { status: 'denied' | 'pending' | 'blocked', … } }`——载荷**总在** `_meta`，上游工具未声明 `outputSchema` 时另放 `structuredContent`（MCP SDK 会按 `outputSchema` 校验错误结果）；`content[0].text` 保留 `Blocked by Aster Guard: <why> (decision <id>)`。这些字段是**非授权信息**：再次调用同名工具是新决策，旧审批随后通过也不会让任何调用转发。下游在 consume 之后、转发之前取消的，不转发并回写 `aborted`。
4. 转发后最长等待上游 `--upstream-timeout` 秒（默认 600），上游每报告一次 progress 重新计时；超时则下游收到 MCP 协议错误（`RequestTimeout`），不是工具结果。上游此时可能仍在执行，重试前先确认副作用是否已发生。
5. 上游没有的工具名返回 MCP 协议错误，不发起裁决。

> **宿主超时须覆盖审批等待。** MCP 宿主（客户端）给这次请求 / 工具调用设的超时必须不小于 `--approval-timeout`（MCP TypeScript SDK 的缺省请求超时只有 60 秒），否则就调低 `--approval-timeout`。不然 PENDING 的调用会先被宿主取消，审批即使通过也不会转发给上游。

### 转发范围

代理只代理 tools，不是全透明的 MCP 代理：

- `tools/list` 原样转发（含 `cursor` / `nextCursor`、`annotations`、`_meta`）；`tools/call` 先裁决、放行后再转发。
- 上游的 `notifications/progress` 只在下游这次 `tools/call` 带了 `_meta.progressToken` 时，以下游的原 token 转发；没带则丢弃（但仍会重置上游超时计时）。
- 不转发 resources、prompts 及其他能力，也不转发上游的 `notifications/tools/list_changed`（代理未声明 `tools.listChanged`）；上游工具集变化后，下游需重新 `tools/list`。

### 治理工具模式

不指定上游时，只提供五个治理工具，供人机协作场景使用。结果是 JSON 文本，`DENY` 或 `ok: false` 时标记 `isError`：

| 工具 | 对应方法 | 参数 |
|---|---|---|
| `guard_check` | `check` | `action: { name }`、`resource?`、`context?`、`waitSeconds?`（主体与模型来自配置，参数不能改写） |
| `guard_status` | `get` | `decisionId` |
| `guard_list_approvals` | `listApprovals` | `status?`、`page?`、`size?` |
| `guard_approve` | `approve` | `approvalId`、`comment?`、`businessRole?`（仅限 Latin-1 字符，见上文 `approve`） |
| `guard_reject` | `reject` | `approvalId`、`comment`（必填）、`businessRole?`（同上） |

### 命令行参数

完整说明见 `aster-guard-mcp --help`。

| 参数 | 说明 |
|---|---|
| `--base-url <url>` | 必填，aster-api 根地址 |
| `--policy <module>/<function>` | 必填，裁决所用的策略，如 `guard.customer/decide` |
| `--principal-id <id>` | 必填，发起主体 id |
| `--upstream "<cmd> [args…]"` | 上游 MCP 服务器的启动命令，按 shell 规则切分（支持引号）；与 `--upstream-url` 都省略则为治理工具模式 |
| `--upstream-url <url>` | 上游为 Streamable HTTP MCP 服务器（`http(s)`，如 `http://demo-tool:8080/mcp`）；与 `--upstream` 二选一 |
| `--upstream-auth-env <name>` | 只配 `--upstream-url`：以该环境变量的值作 `Authorization: Bearer` 发给上游；不能与 API key 变量同名，未设置或为空即参数错误；值不写进日志与错误信息 |
| `--api-key-env <name>` | 存放 API key 的环境变量名，默认 `ASTER_GUARD_API_KEY`；API key 只从环境变量读取 |
| `--principal-type <type>` | 默认 `agent` |
| `--principal-roles <a,b>` | 逗号分隔，至多 16 项 |
| `--approval-timeout <seconds>` | 默认 300；宿主的请求 / 工具调用超时须不小于它（见上文） |
| `--upstream-timeout <seconds>` | 正整数，默认 600；放行后等待上游工具返回的最长秒数，上游报告 progress 时重新计时 |
| `--resource-from <argName>` | 以该工具参数的值作为 `resource.id`；过长或含控制字符时改用 `sha256:<hex>` |
| `--agent-model <model>` | 写入 `action.agent.model` |
| `--tenant-id <id>` | 代理模式必填：API key 所属租户，收据 `payload.tenantId` 须与之相等 |
| `--isolation <list>` | 代理模式必填，逗号分隔、去重（配置自述，由部署层绕过测试验证；ADR 0054 §12 D1）：`network` = 上游只接受代理的连接（stdio 子进程天然满足；HTTP 上游由部署层网络策略保证，代理本身不做任何事）；`auth` = 转发时在 `params._meta["io.aster/guard-consume"]` 附 consume 票据，工具侧用 `@aster-cloud/aster-guard/tool` 核对；`network,auth` = 两层同时声明，任一层单独失效时另一层仍挡住直连。0.2.0 的单值写法照常可用 |
| `--tools <a,b>` | 工具白名单（覆盖配置文件 `tools`） |
| `--config <file.json>` | `{ "tools": [...], "actions": { "<tool>": { "resourceFrom", "digestArgs", "actionName" } } }`，未知键报错，`actions` 中的工具须在白名单内 |
| `--executor-id <id>` | 对账用执行方标识，默认 `aster-guard-mcp@<hostname>` |

`--principal-id`、`--principal-type`、`--agent-model` 与每个角色须为 1–255 字符且不含控制字符，否则以参数错误退出（见下文「服务端 Action 限制」）。

上游子进程继承代理的环境变量，但不包含 API key 所在的那个变量。stdout 是 MCP 通道，日志一律写 stderr。退出码：`0` 正常结束（含 `--help`），`1` 上游无法启动、意外断开或对下游的 stdio 通道建立失败（此时先关闭上游子进程），`2` 参数错误。监听模式的 HTTP 上游例外：连不上或断开都不退出，见下节「上游重连」。

要在宿主侧程序里嵌入代理（自行提供 transport 与已连接的上游 `Client`），可从子路径导入：`import { createGuardProxyServer } from '@aster-cloud/aster-guard/mcp'`，选项与 CLI 参数一一对应（`approvalTimeoutMs`、`upstreamTimeoutMs`、`resourceFromArg`、`agentModel`）。

### Streamable HTTP 模式（ADR 0054 §3.1、§12 D4）

`--listen <host>:<port>` 让代理以**无状态** Streamable HTTP 提供服务，适合把代理部署成独立服务、模型与原始工具分处不同网络位置（如 k3s 的 `aster-agents → aster-guard → aster-tools`）：

```bash
ASTER_GUARD_API_KEY=… aster-guard-mcp --listen 0.0.0.0:8080 \
  --upstream-url http://demo-tool.aster-tools.svc.cluster.local:8080/mcp --isolation network,auth \
  --base-url http://aster-api.aster-cloud.svc.cluster.local --policy guard.demo/decide --tenant-id <团队> \
  --tools demo_echo,demo_delete --agents-file /etc/aster-guard/agents.json
```

| 路径 | 行为 |
|---|---|
| `POST /mcp` | `Authorization: Bearer <token>` 必须匹配登记项，否则 `401 {"error":"unauthorized"}` + `WWW-Authenticate: Bearer`（不建 MCP 服务器、不访问 Guard）；请求体超过 1 MiB → `413`；非 JSON → `400`。通过后为这一个请求新建代理 MCP 服务器与 transport（`enableJsonResponse`），响应结束即关闭 |
| `GET` / `DELETE /mcp` | `405`（无状态：没有会话与服务端推送流） |
| `GET /healthz` | `200 ok`（进程存活，用作 liveness） |
| `GET /readyz` | 最近 30 秒内上游 `tools/list`（3 秒超时）成功过即 `200`，否则 `503`；结论缓存 10 秒，并发请求共享一次探测（用作 readiness）。HTTP 上游未连上或已判定断开时直接 `503`、不探测（见「上游重连」） |

- **Agent 登记**（`--agents-file`）：`{ "agents": [{ "id": "…", "tokenSha256": "<64 位小写十六进制>", "principalId"?: "…", "principalRoles"?: ["…"] }] }`。只存 token 的 sha256，`id` 与 `tokenSha256` 各自唯一，未知键报错。鉴权对每一项做定长比较、不提前返回。每个 Agent 以自己的主体 `{ id: principalId ?? id, type: "agent", roles? }` 裁决，所以监听模式不接受 `--principal-id / --principal-type / --principal-roles`。
- 上游连接与工具名缓存跨请求共享：连续的 `tools/call` 不会每次都向上游刷新 `tools/list`。
- `SIGTERM` / `SIGINT`：停止接受新连接，等在途请求结束（至多 5 秒）后关闭上游，以 `0` 退出。
- 嵌入：`import { startHttpProxy, loadAgents } from '@aster-cloud/aster-guard/mcp'`。

#### 上游重连（`--upstream-url`）

监听模式下 HTTP 上游在启动时连不上**不退出**：代理立即开始服务（`/healthz` `200`、`/readyz` `503`），在后台重试「建立连接 + `tools/list` 验证」，验证通过才算就绪。运行中某次请求遇到连接级失败（`fetch` 失败、上游返回非 2xx、连接被关闭）即判定断开，`/readyz` 立刻转 `503` 并以同样的退避重连，进程不重启。上游的 MCP 协议错误、请求超时与下游取消不算断开。

- **退避**：首次失败后约 0.5 秒，每次翻倍，封顶 30 秒；实际等待取 [上限/2, 上限] 内的随机值（多副本不同步重连）。断开后的第一次重连也先等这一档，不立即重试。缺省值不提供参数修改。
- **日志**：每次失败一行写 stderr，含底层原因码与下次重试间隔（如 `无法连接上游（fetch failed: ECONNREFUSED），0.4 秒后重试（第 1 次）`）；封顶后即至多每 30 秒一行。连上时记 `上游已连接（第 N 次尝试）`，断开时记 `上游连接中断（…），开始重连`。
- **未就绪时的 `tools/call`**：在**裁决之前**即拒绝——不向 Guard 请求决策、不 consume、不转发，返回 `isError: true` 与 `{ asterGuard: { status: "blocked", reasonCode: "upstream_unavailable", reason } }`（载荷位置同上文；工具定义尚未缓存时只放 `_meta`）。代理不排队、不延后执行；重试由调用方决定，重试即新决策。`tools/list` 返回 MCP 错误。
- **就绪后才断开的那一次调用**：若断开发生在裁决与 consume 之后、转发之时，那次调用照常以 `failed` 回写并把错误抛给下游（与「上游超时」同），此后的调用才走上一条。任何情况下都不会不经「决策 → 验签 → consume」就转发。
- stdio 子进程上游（`--upstream`）不重试：子进程起不来多半是命令或配置写错，仍以 `1` 退出；stdio 模式下上游意外退出也仍以 `1` 退出，由宿主决定是否重启。

### 客户端配置

Claude Desktop 配置示例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "guarded-filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@aster-cloud/aster-guard",
        "aster-guard-mcp",
        "--upstream",
        "npx -y @modelcontextprotocol/server-filesystem /tmp",
        "--base-url",
        "http://localhost:8080",
        "--policy",
        "guard.customer/decide",
        "--principal-id",
        "agent-claude",
        "--approval-timeout",
        "300"
      ],
      "env": {
        "ASTER_GUARD_API_KEY": "ak_xxxxxxxx"
      }
    }
  }
}
```

Cursor 配置示例（项目级 `.cursor/mcp.json`，或全局 `~/.cursor/mcp.json`），与 Claude Desktop 同样使用 `mcpServers` 键，内容相同：

```json
{
  "mcpServers": {
    "guarded-filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@aster-cloud/aster-guard",
        "aster-guard-mcp",
        "--upstream",
        "npx -y @modelcontextprotocol/server-filesystem /tmp",
        "--base-url",
        "http://localhost:8080",
        "--policy",
        "guard.customer/decide",
        "--principal-id",
        "agent-claude",
        "--approval-timeout",
        "300"
      ],
      "env": {
        "ASTER_GUARD_API_KEY": "ak_xxxxxxxx"
      }
    }
  }
}
```

> 宿主超时：上面两例的 `--approval-timeout 300`（秒）要求宿主对这个服务器的请求 / 工具调用超时不小于 300 秒，原因见上文「宿主超时须覆盖审批等待」；宿主超时调不了这么长时，把该值改成不超过宿主超时的秒数。
>
> `npx -y -p @aster-cloud/aster-guard aster-guard-mcp` 用 `-p` 指明要安装的包，再写要运行的命令名 `aster-guard-mcp`。不要写成 `npx -y @aster-cloud/aster-guard aster-guard-mcp …`：命令名会被当作多余的位置参数而报错（退出码 2）。全局安装后也可直接把 `command` 写成 `aster-guard-mcp`，`args` 去掉前四项。`--base-url` 换成实际的 aster-api 地址；`ASTER_GUARD_API_KEY` 是请求方的 API key。

### auth 隔离：工具侧核对 consume 票据

上游工具可改时，用 `--isolation auth` 让工具自己拒绝不经代理的调用（ADR 0054 §3.3，R66 D2 / D11 / D12）：

```ts
import { GuardClient } from '@aster-cloud/aster-guard';
import { MemoryAttemptLedger, verifyConsumeTicket } from '@aster-cloud/aster-guard/tool';

const guard = new GuardClient({ baseUrl, apiKey: process.env.TOOL_API_KEY!, policyModule: '-', policyFunction: '-' }); // 工具自己的 key
const ledger = new MemoryAttemptLedger(); // 单副本；多副本必须用共享持久存储实现 AttemptLedger（如数据库唯一键）

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const verdict = await verifyConsumeTicket({
    meta: req.params._meta, args: req.params.arguments, toolName: req.params.name,
    mapping: actions[req.params.name], policy: { module: 'guard.customer', function: 'decide' }, client: guard, ledger,
  });
  if (!verdict.ok) return { isError: true, content: [{ type: 'text', text: `401 ${verdict.reason}` }] }; // 不执行
  // …执行副作用；建议把 verdict.attemptId 与副作用同事务落库，或作业务幂等键
});
```

工具侧不对回读的 `executionReceipt` 做离线验签。工具的信任边界是「用自己的 key 经鉴权向 aster-api 回读决策」：放行所依据的 `actionHash`、`consumedBy`、`result` 都只来自这次回读、本就不在签名内，所以对地址验签虽能把地址绑定到收据，却不改变工具放行的信任根——能伪造回读响应的一方同样能伪造 consume 状态；它还要在工具侧引入 JWKS 拉取，且收据时间窗（5 分钟）可能在 consume 之后、工具核对之前到期。签名覆盖的地址由执行方（SDK `run` / 代理）在 consume **之前**核对；工具侧核对回读的 `policyModule / policyFunction`（R66 D12），二者合起来覆盖 #517。

核对顺序：票据形状 → 用工具自己的 key 回读决策（不可达 / 非 200 → `guard_unavailable`）→ `ALLOW` → 回读的 `policyModule / policyFunction` 等于期望策略（`policy_mismatch`）→ 票据 `envelope` 的动作名与资源等于工具自己的映射、按工具自己的映射对**实际收到的参数**重算哈希（`action_mismatch`）→ `consumedBy.attemptId`（`attempt_mismatch`）→ 时间窗（`ticket_expired`）→ 未写结果（`result_recorded`）→ 原子认领 attemptId（`ticket_replayed`）。这是 **at-most-once 放行**：认领后工具崩溃则动作不执行，须重新申请决策。`MemoryAttemptLedger` 重启后 ttl 窗口内同一票据可再被放行一次——多副本或会重启的工具必须提供共享持久存储实现。

> stdio 模式下宿主若同时配置了原始上游，模型可以绕过代理——这是部署配置问题（ADR 0054 §2），由 `auth` 模式兜底、由 #466 部署层测试证明。

## 绕过套件

`test/bypass/` 是 ADR 0054 §7 的夹具层：`static-no-branch-on-reason`（代码不据 `reason / reasonCode / approvalId / poll / requiredRole` 分支）、#5（伪造 / 篡改 / 过期收据不 consume）与 #8 的 mock 版（换策略模块另取 ALLOW 收据，对应 aster-api `B8PolicySwitchBypassTest`）始终启用；#2 / #2b / #3 / #4 / #1b 与 #8 的本地版需要本地 aster-api（含 R68）：

```bash
ASTER_GUARD_E2E=1 ASTER_GUARD_BASE_URL=http://localhost:8080 ASTER_GUARD_API_KEY=… ASTER_GUARD_TENANT_ID=… \
ASTER_GUARD_POLICY=guard.bypass/decide [ASTER_GUARD_LENIENT_POLICY=guard.lenient/decide] \
[ASTER_GUARD_EXTRA_HEADERS='{"X-Tenant-Id":"…"}'] pnpm exec vitest run test/bypass
```

`ASTER_GUARD_POLICY` 须对 `refund_payment` 给 DENY、其余 ALLOW；`ASTER_GUARD_LENIENT_POLICY`（可选）对一切 ALLOW，用于 #517 换模块用例（#1b 工具侧拒绝、#8 执行方本地 `policy_mismatch` 与改写地址 `bad_signature`）。夹具层只证明代理逻辑，原始工具端点不可达由部署层证明。

## 服务端 Action 限制

aster-api 在裁决前校验 Action（`GuardActionMapper`），不合规的请求整体返回 400 `invalid_action`，不产生决策：

| 字段 | 限制 |
|---|---|
| `principal.id`、`principal.type`、`action.name`、`resource.type`、`resource.id`、`agent.model` | ≤ 255 字符（按 UTF-16 码元计），不含控制字符（U+0000–U+001F、U+007F–U+009F） |
| `principal.roles` | ≤ 16 项，每项同上 |
| `context` | 嵌套深度 ≤ 8，序列化后 ≤ 65536 字节，**不允许 `null` 值**（嵌套对象与数组里的也不行） |

`GuardClient.check` 收到这种 400 时返回 `decisionId: ''`、`reasonCode: 'http_400'`、`reason` 为服务端 message 的 DENY。代理据此拒绝这次工具调用，文本形如：

```text
Blocked by Aster Guard: <服务端 message> (decision n/a)
```

0.2.0 起代理不再改写参数：`null` 原样进入 `context`（aster-api R63 起接受），与转发给上游的参数是同一个规范化对象（见上文）。唯一的派生值是 **资源 id**：`resource.id` 取 `resourceFrom` 参数的值（字符串，或对象 / 数组的 JSON），超过 255 字符或含控制字符时改为 `sha256:<64 位十六进制>`，同一个值总得到同一个 id。

`--principal-id`、`--principal-type`、`--agent-model` 与 `--principal-roles` 各项在启动时按上表校验，违反即以退出码 2 结束，而不是让每一次调用都被拒绝。`context` 的深度与大小代理不做改写：超出时（例如给文件写入工具传入超过 64 KB 的内容）调用会以 `blocked http_400` 被拒绝；大字段请用 `digestArgs`。

## 本地端到端

`scripts/e2e-local.mjs` 对本地 aster-api 走一遍真实流程：放行、挂起待审批、审批、读取最终结论。它只调用本包构建出的公开 SDK，不含任何 mock。脚本在仓库内，不随 npm 包发布，需在仓库根目录先 `pnpm build`。

### 前提

1. **运行中的 aster-api**，默认 `http://localhost:8080`。启动方式见 aster-api 仓库 README 的「本地开发」一节（`podman run … postgres` 起数据库，`./gradlew :quarkus-policy-api:quarkusDev` 起服务），此处不再重复。
2. **已部署的示例策略**（模块 `guard.customer`，函数 `decide`）：

   ```text
   Module guard.customer.

   Define GuardRequest has principal_id, principal_type, principal_roles, action, resource_type, resource_id, context, agent_model.

   @id("CUST-DEL-001")
   @control("GDPR:ART17")
   Rule decide given req as GuardRequest, produce Verdict:
     If req.action equals to "delete_customer_record":
       Return Verdict.require_approval("Data Protection Officer", "customer record deletion").
     Otherwise:
       Return Verdict.allow().
   ```

   `delete_customer_record` 需要「Data Protection Officer」审批，其余动作放行。
3. **两把 API key**：请求方一把；审批方一把。「四眼」规则要求审批人与提交人是不同的已验证身份（用户与 API key 都不同），所以审批步骤必须用第二把 key。
4. **审批方具备已验证的业务角色**：审批方用户须在 aster-cloud 团队成员页被授予 `Data Protection Officer`；`ASTER_GUARD_APPROVER_ROLE` 仅为提示，服务端以 API key 所属成员的已验证角色集合判定（ADR 0042 §2.3）。

aster-api 没有公开的端点用来创建 API key 或部署策略，二者经 aster-cloud（或直接写库）完成。脚本假定它们已经就绪，所有参数都从环境变量读取。

### 运行

```bash
pnpm build
ASTER_GUARD_API_KEY=ak_requester \
ASTER_GUARD_APPROVER_API_KEY=ak_approver \
node scripts/e2e-local.mjs
```

环境变量：

| 变量 | 说明 |
|---|---|
| `ASTER_GUARD_API_KEY` | 必填，请求方 API key |
| `ASTER_GUARD_BASE_URL` | aster-api 根地址，默认 `http://localhost:8080` |
| `ASTER_GUARD_POLICY` | `<module>/<function>`，默认 `guard.customer/decide` |
| `ASTER_GUARD_APPROVER_API_KEY` | 审批方 API key，可选；缺省时跳过审批步骤 |
| `ASTER_GUARD_APPROVER_ROLE` | 审批方业务角色，默认 `Data Protection Officer`，作为 `businessRole`（`X-User-Business-Role` 头）发送，仅作提示，不决定是否放行 |

每次运行使用全新的 `principal.id`（`e2e-<时间戳>`）和新的幂等键，不会重放旧决策。

### 每一步断言什么

| 步骤 | 动作 | 期望 |
|---|---|---|
| 1 | 请求方 `check` `read_customer_record` | `effectiveOutcome` 为 `ALLOW` |
| 2 | 请求方 `check` `delete_customer_record` | `effectiveOutcome` 为 `PENDING`，且带 `approval.id` |
| 3 | 审批方 `approve(approvalId, { comment: 'e2e', businessRole })` | 返回 `ok: true` |
| 4 | 请求方 `get(decisionId)` | `effectiveOutcome` 变为 `ALLOW` |

每步输出一行 `✓` 或 `✗`（步骤 2 的标签写出实际的 `effectiveOutcome`）。任一断言失败时，脚本打印完整的决策（或审批结果）JSON 并以退出码 1 结束；缺少 `ASTER_GUARD_API_KEY` 或 `ASTER_GUARD_POLICY` 格式不对时，用法写到 stderr，退出码 2。环境变量的值会去掉首尾空白，只有空白等同于未设置。

未设置 `ASTER_GUARD_APPROVER_API_KEY` 时，步骤 3、4 不执行，脚本输出 `SKIP: 审批步骤需要第二把 API key (ASTER_GUARD_APPROVER_API_KEY)`，仍以退出码 0 结束（只覆盖了步骤 1、2）。此时步骤 2 产生的待审批记录会留在 aster-api，可用 `guard_list_approvals` / `listApprovals` 查看，或等它过期。

### 接入 MCP 客户端

端到端通过后，可把 `aster-guard-mcp` 接到 Claude Desktop 或 Cursor：配置示例见上文「aster-guard-mcp」一节。被策略要求审批的工具调用会在代理里等待（最长 `--approval-timeout` 秒），由持有第二把 key 的人通过 `listApprovals` / `approve` 批准后才转发给上游。

## fail-closed 语义

守门失效不能等于放行。客户端与代理遵守同一条规则：

- 任何非 200 响应、网络错误或超时，一律解析为 `effectiveOutcome = DENY`。
- 422 `idempotency_mismatch`（同一个幂等键被用在了另一个动作上）按 DENY 处理。
- 服务端的瞬时故障（`evaluation_failed`、`receipt_unavailable`）本身就是 200 + DENY。
- 等待审批超时、审批被拒绝或过期，同样是 DENY。

这些是安全属性，不是可调参数：任何改动都不得把「无法确认」解释为放行。

## 幂等键策略

`POST /api/v1/guard/decisions` 通过 `Idempotency-Key` 头去重。SDK 与代理统一遵守：

- **每一次动作尝试生成一个唯一键**（如 UUID），只在**同一次尝试的网络重试**之间复用。
- **绝不**从 MCP JSON-RPC 的请求 id 派生。该 id 只在单个连接内唯一，重连或换会话后会重复，会让不同动作撞键，触发 422 或错误重放。
- 收到瞬时 DENY（`evaluation_failed`、`receipt_unavailable`）后，若要重试，**必须换新键**：原键已绑定那次 DENY，同键重放只会拿到同一个 DENY。
- 收到 422 `idempotency_mismatch` 说明键生成有缺陷，按 DENY 处理，不要重试。

## 开发

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit，仅覆盖 src
pnpm run lint        # eslint src test scripts（.ts 用 typescript-eslint，.mjs 用 @eslint/js）
pnpm test            # 先 build，再 vitest run（含 dist 入口测试）
pnpm run build       # tsc → dist/
```

提交流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

## 服务端版本要求与回滚

自 0.3.0（R68 地址核对）起，执行方（`GuardClient.run`、`verifyReceipt`、`aster-guard-mcp`）**要求 aster-api 已上线 ADR 0040 §13 R68**（执行收据签名载荷含 `policyModule / policyFunction`，aster-api#539）。缺这两键的收据——R68 之前的 aster-api 签发的，或 R68 上线前已签发、尚在 5 分钟 TTL 内的——一律 `blocked receipt_invalid`（`policy_mismatch`），不 consume、不执行：fail-closed，不会误放行，但全部受守卫动作停摆。

- **升级顺序**：先部署含 R68 的 aster-api，**至少等一个收据 TTL（5 分钟）** 让无地址键的旧收据过期，再升级执行方。0.2.x 执行方在 R68 服务端上照常工作（新增键在签名字节内，0.2.x 不读它们）。
- **回滚耦合**：aster-api 回滚到 R68 之前（或自托管的 aster-api 没有 R68）时，执行方必须同时钉回 npm 上已发布的 `@aster-cloud/aster-guard@0.2.0`（不含本项核对）；`aster-guard-mcp` 代理镜像钉回本项合入 main 之前构建的镜像 digest。否则全部 `policy_mismatch`。
- 工具侧 `verifyConsumeTicket` 不读收据地址键，不受此耦合影响。

## 0.3.0 行为变化

- ALLOW 收据须带签名覆盖的 `policyModule / policyFunction` 且等于自身配置的策略，否则 `blocked receipt_invalid`（`policy_mismatch`）；要求 aster-api 已上线 R68，回滚耦合见上文「服务端版本要求与回滚」。
- 新增 `--upstream-url` / `--upstream-auth-env`（HTTP 上游）、`--listen` / `--agents-file`（Streamable HTTP 监听，`/healthz`、`/readyz`）；`--isolation` 接受 `network,auth` 列表。
- 监听模式下 HTTP 上游不可达不再退出，后台退避重连；未就绪时 `tools/call` 以 `upstream_unavailable` 拒绝。

## 0.2.0 行为变化

- 工具参数里的 `null` 不再剔除：`null`、缺失与 `""` 是三个不同的动作（aster-api R63 起接受 `context` 中的 null）。
- ALLOW 不再直接转发：须执行收据验签通过且 consume 成功；旧 aster-api（无收据）上一律 `blocked receipt_invalid`。
- 代理模式必填 `--tenant-id` 与 `--isolation`；新增 `--tools`、`--config`、`--executor-id`。
- DENY / PENDING / 阻断返回结构化载荷（`_meta.asterGuard`）；PENDING 与 DENY 不再同形。
- 新子路径 `@aster-cloud/aster-guard/tool`（`auth` 隔离的工具侧核对）。
- 未被 consume 的 ALLOW 是治理缺口（ADR 0040 §12 D10）：#465 对账记为 `allow_unconsumed`。

## 许可证

[Apache-2.0](LICENSE)
