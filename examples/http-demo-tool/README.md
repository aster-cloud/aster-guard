# 演示 HTTP 工具（aster-guard-demo-tool）

aster-api ADR 0054 §12 D6 的受保护工具：部署在 k3s `aster-tools` 命名空间，只经 `aster-guard-mcp`（`--isolation network,auth`）调用，
供部署层绕过探针（wontlost-ltd/aster-api#466）验证「网络策略」与「工具侧 consume 票据」两层隔离各自独立成立。不发布到 npm。

## 接口

| 路径 | 行为 |
|---|---|
| `POST /mcp` | 无状态 Streamable HTTP（`enableJsonResponse`）。请求体只解析一次：数组（批量）→ `400 {"error":"batch_not_supported"}`；`method` **恰为** `tools/call` 且 `TICKET_CHECK=on` 时，用同一个已解析对象的 `params._meta / params.arguments / params.name` 调 `verifyConsumeTicket`，拒绝 → `401 {"error":"ticket_rejected","reason":<TicketRejection>}`，不交给 MCP；其它方法（`initialize`、`tools/list` 等）不需要票据。请求体上限 1 MiB |
| `GET /healthz` | `{"status":"ok","ticketCheck":"on"\|"off"}` |
| `GET /effects[?marker=<m>]` | 副作用日志 `{ count, unticketed, last: [{ tool, marker, decisionId, attemptId, at }] }`；`last` 保留最近 20 条，给出 `marker` 时只含该标记的条目 |

工具：`demo_echo { message }`（策略期望 ALLOW）返回 `{ echoed, decisionId, attemptId }`；`demo_delete { id }`（策略期望 DENY，经代理时不会到达工具）返回 `{ deleted, decisionId, attemptId }`。两者每次执行都向副作用日志追加一条（`marker` 为 `message` / `id`，截断到 64 字符）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口，缺省 `8080` |
| `ASTER_API_BASE_URL` | aster-api 根地址（集群内 `http://aster-api.aster-cloud.svc.cluster.local`） |
| `ASTER_GUARD_TOOL_API_KEY` | 工具**自己的** Guard key：必须是与代理**同租户**的 **MEMBER** key（回读 `GET /api/v1/guard/decisions/{id}` 要求 MEMBER），且与代理的 key 不同（ADR 0054 §3.3） |
| `ASTER_GUARD_TENANT_ID` | 该租户 id |
| `ASTER_GUARD_POLICY` | 期望的策略地址 `<module>/<function>`（ADR 0054 §11 D12），回读决策的策略须与之相等 |
| `TICKET_CHECK` | `on`（缺省）\| `off`。`on` 时上面四个变量缺一即以退出码 2 启动失败 |

## 部署约束

- **单副本 + `strategy: Recreate`**：attemptId 的认领账本在进程内（`MemoryAttemptLedger`，ADR 0054 §11 D11）。多副本会让同一票据在每个副本各放行一次；滚动更新时新旧进程并存同理。进程重启后，ttl（5 分钟）内同一票据还能再被放行一次——这是演示工具接受的残余风险，真实工具应使用共享持久账本（如数据库唯一键）。
- **`TICKET_CHECK=off` 只用于红队副本**（k3s `scripts/guard-bypass/redteam-window.sh` 生成的临时命名空间）。关闭时启动即在 stderr 打 `INSECURE: …`，之后每 60 秒重复一次，`/healthz` 报告 `"ticketCheck":"off"`；生产清单不得出现该值（k3s `manifests.test.sh` 断言，探针对线上 Deployment 与 `/healthz` 再核对一次）。

## 开发

```bash
pnpm vitest run examples/http-demo-tool   # 测试（根目录执行）
pnpm run build && pnpm -r build           # 构建根包与本示例（-r 不含根包；dist/server.js 为容器入口）
```
