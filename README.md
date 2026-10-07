# @aster-cloud/aster-guard

AI 行动守门（Action Guard）的客户端与 MCP 代理。

AI Agent 在执行有副作用的动作之前（删除客户记录、转账、发邮件……），先向 aster-api 提交这个**提议动作**，由租户已部署的 Aster 策略规则裁决：放行、拒绝、需要人工审批或升级复核。每一次裁决都会在 aster-api 的审计链上留下收据。

本包提供两样东西：

- **`GuardClient`**：调用 aster-api `/api/v1/guard/*` 的 TypeScript SDK。
- **`aster-guard-mcp`**：stdio MCP 代理。包在任意上游 MCP 服务器外面，对每一次 `tools/call` 先过 guard，再决定是否转发。

设计依据见 aster-api 仓库 `docs/adr/0040-action-guard.md`（ADR 0040：Action Guard，本包对应 §6），随子项目 2 合并后可见。

> **当前状态：0.1.0，尚未发布。** `GuardClient` 与 `aster-guard-mcp` 均已实现。

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
| `approve(id, { comment?, businessRole? })` | `POST /api/v1/guard/approvals/{id}/approve`；`businessRole` 作为 `X-User-Business-Role` 头发送 |
| `reject(id, { comment, businessRole? })` | `POST /api/v1/guard/approvals/{id}/reject`；`comment` 必填，缺失时客户端直接返回 `comment_required` |

`effectiveOutcome` 是调用方唯一需要看的字段：`ALLOW` 才可执行；`DENY` 不执行；`PENDING` 继续轮询。

`check` / `get` / `waitFor` 从不抛异常。客户端无法确认结论时返回 `decisionId: ''`、`effectiveOutcome: 'DENY'` 的决策，`reasonCode` 为：`http_<status>`（非 2xx）、`idempotency_mismatch`（422）、`client_error`（网络错误、响应体不合契约）、`client_timeout`（单次请求超时，默认 12 秒，为服务端 10 秒评估超时留出余量，`timeoutMs` 可配；带 `waitSeconds` 时自动延长）。审批操作不是 guard 结论，失败时返回 `{ ok: false, status, error, message }`，`error` 为服务端错误码（如 `segregation_of_duties`）；未收到 HTTP 响应时 `status` 为 0。

## aster-guard-mcp

stdio MCP 服务器（ADR 0040 §6）。指定 `--upstream` 时包裹该上游 MCP 服务器：原样转发 `tools/list`，并拦截每一次 `tools/call`：

1. 构造 Action：`action.name` 为工具名，`context` 为工具参数，`principal` 来自配置；指定 `--resource-from <argName>` 时，取该参数的值作为 `resource: { type: 'arg', id }`；`--agent-model` 写入 `agent.model`。
2. 以新的 UUID 作幂等键调用 `GuardClient.check`（每次调用一个新键，不从 JSON-RPC 请求 id 派生）。
3. 只有服务端确认的 `ALLOW` 才转发给上游，上游结果原样返回；`DENY` 返回工具错误 `Blocked by Aster Guard: <reason> (decision <id>)`，guard 不可达时 decision 为 `n/a`；`PENDING` 则等待审批，最长 `--approval-timeout` 秒（默认 300），再按最终结论转发或拒绝。等待期间下游取消请求的，代理随即停止轮询，审批随后通过也不再转发。
4. 上游没有的工具名返回 MCP 协议错误，不发起裁决。

> **宿主超时须覆盖审批等待。** MCP 宿主（客户端）给这次请求 / 工具调用设的超时必须不小于 `--approval-timeout`（MCP TypeScript SDK 的缺省请求超时只有 60 秒），否则就调低 `--approval-timeout`。不然 PENDING 的调用会先被宿主取消，审批即使通过也不会转发给上游。

不指定上游时，只提供五个治理工具，供人机协作场景使用。结果是 JSON 文本，`DENY` 或 `ok: false` 时标记 `isError`：

| 工具 | 对应方法 | 参数 |
|---|---|---|
| `guard_check` | `check` | `action: { name }`、`resource?`、`context?`、`waitSeconds?`（主体与模型来自配置，参数不能改写） |
| `guard_status` | `get` | `decisionId` |
| `guard_list_approvals` | `listApprovals` | `status?`、`page?`、`size?` |
| `guard_approve` | `approve` | `approvalId`、`comment?`、`businessRole?` |
| `guard_reject` | `reject` | `approvalId`、`comment`（必填）、`businessRole?` |

命令行参数（完整说明见 `aster-guard-mcp --help`）：

| 参数 | 说明 |
|---|---|
| `--base-url <url>` | 必填，aster-api 根地址 |
| `--policy <module>/<function>` | 必填，裁决所用的策略，如 `guard.customer/decide` |
| `--principal-id <id>` | 必填，发起主体 id |
| `--upstream "<cmd> [args…]"` | 上游 MCP 服务器的启动命令，按 shell 规则切分（支持引号）；省略则为治理工具模式 |
| `--api-key-env <name>` | 存放 API key 的环境变量名，默认 `ASTER_GUARD_API_KEY`；API key 只从环境变量读取 |
| `--principal-type <type>` | 默认 `agent` |
| `--principal-roles <a,b>` | 逗号分隔 |
| `--approval-timeout <seconds>` | 默认 300；宿主的请求 / 工具调用超时须不小于它（见上文） |
| `--resource-from <argName>` | 以该工具参数的值作为 `resource.id` |
| `--agent-model <model>` | 写入 `action.agent.model` |

上游子进程继承代理的环境变量，但不包含 API key 所在的那个变量。stdout 是 MCP 通道，日志一律写 stderr。退出码：`0` 正常结束（含 `--help`），`1` 上游无法启动或意外断开，`2` 参数错误。

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
| `ASTER_GUARD_APPROVER_ROLE` | 审批方业务角色，默认 `Data Protection Officer`，作为 `businessRole`（`X-User-Business-Role` 头）发送 |

每次运行使用全新的 `principal.id`（`e2e-<时间戳>`）和新的幂等键，不会重放旧决策。

### 每一步断言什么

| 步骤 | 动作 | 期望 |
|---|---|---|
| 1 | 请求方 `check` `read_customer_record` | `effectiveOutcome` 为 `ALLOW` |
| 2 | 请求方 `check` `delete_customer_record` | `effectiveOutcome` 为 `PENDING`，且带 `approval.id` |
| 3 | 审批方 `approve(approvalId, { comment: 'e2e', businessRole })` | 返回 `ok: true` |
| 4 | 请求方 `get(decisionId)` | `effectiveOutcome` 变为 `ALLOW` |

每步输出一行 `✓` 或 `✗`。任一断言失败时，脚本打印完整的决策（或审批结果）JSON 并以退出码 1 结束；缺少 `ASTER_GUARD_API_KEY` 或 `ASTER_GUARD_POLICY` 格式不对时，用法写到 stderr，退出码 2。

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
pnpm run lint        # eslint src test
pnpm test            # 先 build，再 vitest run（含 dist 入口测试）
pnpm run build       # tsc → dist/
```

提交流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE)
