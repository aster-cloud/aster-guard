# @aster-cloud/aster-guard

AI 行动守门（Action Guard）的客户端与 MCP 代理。

AI Agent 在执行有副作用的动作之前（删除客户记录、转账、发邮件……），先向 aster-api 提交这个**提议动作**，由租户已部署的 Aster 策略规则裁决：放行、拒绝、需要人工审批或升级复核。每一次裁决都会在 aster-api 的审计链上留下收据。

本包提供两样东西：

- **`GuardClient`**：调用 aster-api `/api/v1/guard/*` 的 TypeScript SDK。
- **`aster-guard-mcp`**：stdio MCP 代理。包在任意上游 MCP 服务器外面，对每一次 `tools/call` 先过 guard，再决定是否转发。

设计依据见 aster-api 仓库 `docs/adr/0040-action-guard.md`（ADR 0040：Action Guard，本包对应 §6），随子项目 2 合并后可见。

> **当前状态：脚手架（0.1.0）。** 仓库、工具链与 CI/发布流程已就绪，`src/index.ts` 目前只导出 `VERSION`。下文标注「实现于后续任务」的章节描述的是设计目标，尚不可用。

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

## GuardClient（实现于后续任务）

用法草图，方法名与 ADR 0040 §6 一致：

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
  name: 'delete_customer_record',
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

计划提供的方法：

| 方法 | 说明 |
|---|---|
| `check(action, opts)` | `POST /api/v1/guard/decisions`，返回 `Decision` |
| `get(decisionId)` | `GET /api/v1/guard/decisions/{id}`，读取当前状态 |
| `waitFor(decisionId, { timeoutMs, intervalMs })` | 轮询直到不再 PENDING 或超时 |
| `listApprovals()` | `GET /api/v1/guard/approvals`，列出待审批 |
| `approve(id, comment?)` | `POST /api/v1/guard/approvals/{id}/approve` |
| `reject(id, comment)` | `POST /api/v1/guard/approvals/{id}/reject`，`comment` 必填 |

`effectiveOutcome` 是调用方唯一需要看的字段：`ALLOW` 才可执行；`DENY` 不执行；`PENDING` 继续轮询。

## aster-guard-mcp（实现于后续任务）

stdio MCP 代理。连接一个上游 MCP 服务器，原样转发 `tools/list`，并拦截每一次 `tools/call`：

1. 构造 Action：`action.name` 为工具名，`context` 为工具参数，`resource` 可由 `--resource-from <jsonpath>` 规则抽取，`principal` 来自配置。
2. 调用 `GuardClient.check`。
3. `ALLOW` 转发给上游；`DENY` 返回 MCP 工具错误（含 reason 与 decisionId）；`PENDING` 等待审批，最长 `--approval-timeout`（默认 300 秒），再按最终结果转发或拒绝。

不指定上游时，代理只暴露 `guard_check` / `guard_status` / `guard_list_approvals` / `guard_approve` / `guard_reject` 五个工具，供人机协作场景使用。

Claude Desktop 配置示例（`claude_desktop_config.json`）。参数与环境变量名为设计草图，以实现任务落地后的 `--help` 为准：

```json
{
  "mcpServers": {
    "guarded-filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@aster-cloud/aster-guard",
        "--upstream",
        "npx -y @modelcontextprotocol/server-filesystem /Users/me/work",
        "--approval-timeout",
        "300"
      ],
      "env": {
        "ASTER_GUARD_BASE_URL": "https://api.aster-lang.cloud",
        "ASTER_GUARD_API_KEY": "ak_xxxxxxxx"
      }
    }
  }
}
```

> 包只有一个可执行文件 `aster-guard-mcp`，`npx` 会直接运行它；全局安装后也可把 `command` 写成 `aster-guard-mcp`。`policyModule`、`policyFunction` 与 `principal` 同样由配置提供，不在示例中展开。

## fail-closed 语义（设计约束，随实现任务落地）

守门失效不能等于放行。客户端与代理遵守同一条规则：

- 任何非 200 响应、网络错误或超时，一律解析为 `effectiveOutcome = DENY`。
- 422 `idempotency_mismatch`（同一个幂等键被用在了另一个动作上）按 DENY 处理。
- 服务端的瞬时故障（`evaluation_failed`、`receipt_unavailable`）本身就是 200 + DENY。
- 等待审批超时、审批被拒绝或过期，同样是 DENY。

这些是安全属性，不是可调参数：任何改动都不得把「无法确认」解释为放行。

## 幂等键策略（设计约束，随实现任务落地）

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
