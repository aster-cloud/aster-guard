// 无上游时的五个治理工具：一一对应 GuardClient 方法，供人机协作场景（ADR 0040 §6）。
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GuardClient } from '../client.js';
import type { GuardDecision, GuardPrincipal } from '../types.js';

/** 治理工具用到的 GuardClient 方法。 */
type GovernanceClient = Pick<GuardClient, 'check' | 'get' | 'listApprovals' | 'approve' | 'reject'>;

/** 治理工具的运行依赖：主体与模型来自代理配置，工具参数不能改写（Agent 不得自报身份）。 */
interface GovernanceContext {
  client: GovernanceClient;
  principal: GuardPrincipal;
  agentModel?: string;
}

/** 工具执行结果：result 原样序列化为 JSON 文本，failed 为真时标记 isError。 */
interface Outcome {
  result: unknown;
  failed: boolean;
}

interface ToolSpec {
  description: string;
  input: z.ZodObject;
  /** args 已通过 input 校验。 */
  run(args: unknown, context: GovernanceContext): Promise<Outcome>;
}

/** 把输入 schema 与处理函数绑在一起；处理函数拿到的是校验后的类型化参数。 */
function defineTool<S extends z.ZodObject>(
  description: string,
  input: S,
  run: (args: z.output<S>, context: GovernanceContext) => Promise<Outcome>,
): ToolSpec {
  return { description, input, run: (args, context) => run(args as z.output<S>, context) };
}

const nonEmpty = (what: string) => z.string().min(1).describe(what);
const businessRole = z
  .string()
  .optional()
  .describe(
    "Approver's business role, matched exactly against the rule's required role (sent as the X-User-Business-Role header, so Latin-1 characters only)",
  );

const TOOLS = {
  guard_check: defineTool(
    'Ask Aster Action Guard whether a proposed action may run. Returns the decision as JSON: effectiveOutcome ALLOW (proceed), DENY (do not proceed) or PENDING (human approval required; poll with guard_status). The principal is fixed by the proxy configuration.',
    z.object({
      action: z.object({ name: nonEmpty('Action name, e.g. delete_customer_record') }),
      resource: z
        .object({ type: z.string().optional(), id: z.string().optional() })
        .optional()
        .describe('Target resource, e.g. { "type": "customer", "id": "C-1001" }'),
      context: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Facts the policy decides on, e.g. { "amount": 250000, "currency": "NZD" }'),
      waitSeconds: z
        .number()
        .min(0)
        .max(30)
        .optional()
        .describe('Seconds the server may wait for a final decision when approval is required (0-30)'),
    }),
    async ({ waitSeconds, ...action }, { client, principal, agentModel }) =>
      decisionOutcome(
        await client.check(
          { ...action, principal, agent: agentModel ? { model: agentModel } : undefined },
          { waitSeconds },
        ),
      ),
  ),
  guard_status: defineTool(
    'Read the current state of a guard decision (e.g. after PENDING) as JSON.',
    z.object({ decisionId: nonEmpty('Decision id returned by guard_check') }),
    async ({ decisionId }, { client }) => decisionOutcome(await client.get(decisionId)),
  ),
  guard_list_approvals: defineTool(
    'List approval requests of the tenant as JSON, filtered by status and paginated.',
    z.object({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']).optional().describe('Defaults to PENDING'),
      page: z.number().int().min(0).optional().describe('Zero-based page, defaults to 0'),
      size: z.number().int().min(1).max(200).optional().describe('Page size 1-200, defaults to 20'),
    }),
    async ({ status, page, size }, { client }) => apiOutcome(await client.listApprovals(status, page, size)),
  ),
  guard_approve: defineTool(
    'Approve a pending approval request; the decision becomes ALLOW. The caller must not be the requester (four-eyes rule).',
    z.object({ approvalId: nonEmpty('Approval id'), comment: z.string().optional(), businessRole }),
    async ({ approvalId, comment, businessRole }, { client }) =>
      apiOutcome(await client.approve(approvalId, { comment, businessRole })),
  ),
  guard_reject: defineTool(
    'Reject a pending approval request; the decision becomes DENY. A comment explaining the rejection is required.',
    z.object({ approvalId: nonEmpty('Approval id'), comment: nonEmpty('Why the action is rejected'), businessRole }),
    async ({ approvalId, comment, businessRole }, { client }) =>
      apiOutcome(await client.reject(approvalId, { comment, businessRole })),
  ),
} satisfies Record<string, ToolSpec>;

/** tools/list 的五个工具；inputSchema 由 zod schema 生成（与 SDK McpServer 相同口径：draft-7、按输入侧）。 */
export const GOVERNANCE_TOOLS: Tool[] = Object.entries(TOOLS).map(([name, spec]) => ({
  name,
  description: spec.description,
  inputSchema: z.toJSONSchema(spec.input, { target: 'draft-7', io: 'input' }) as Tool['inputSchema'],
}));

/**
 * 执行一个治理工具。未知工具是协议错误（抛 McpError）；参数不合 schema 与 guard 的否定结论
 * 都是工具错误（isError），让模型能读到原因并自行纠正。
 */
export async function callGovernanceTool(
  name: string,
  args: Record<string, unknown> | undefined,
  context: GovernanceContext,
): Promise<CallToolResult> {
  const spec: ToolSpec | undefined = Object.hasOwn(TOOLS, name) ? TOOLS[name as keyof typeof TOOLS] : undefined;
  if (!spec) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  }
  const parsed = spec.input.safeParse(args ?? {});
  if (!parsed.success) {
    return textResult(`Invalid arguments for ${name}:\n${z.prettifyError(parsed.error)}`, true);
  }
  const { result, failed } = await spec.run(parsed.data, context);
  return textResult(JSON.stringify(result, null, 2), failed);
}

function decisionOutcome(decision: GuardDecision): Outcome {
  return { result: decision, failed: decision.effectiveOutcome === 'DENY' };
}

function apiOutcome(result: { ok: boolean }): Outcome {
  return { result, failed: !result.ok };
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}
