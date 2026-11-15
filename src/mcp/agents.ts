// Streamable HTTP 监听模式的 Agent 登记与 Bearer 鉴权（ADR 0054 §3.1、§12 D4）。
// 登记文件只存 token 的 sha256，代理不持有任何明文 Agent token；每个 Agent 的 principal 取自登记而不是请求。
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { hasControlChar, MAX_ROLES, MAX_TEXT_LENGTH } from './action-limits.js';
import { ConfigError } from './config.js';

export interface AgentEntry {
  /** Agent 标识；缺省 principalId 时即为 principal.id。 */
  id: string;
  /** Bearer token 的 sha256，64 位小写十六进制。 */
  tokenSha256: string;
  principalId?: string;
  principalRoles?: string[];
}

/** 写入 Action 文本字段的值：1–255 字符且不含控制字符（与 CLI 的 --principal-* 同一限制）。 */
const actionText = z
  .string()
  .min(1, '不能为空')
  .max(MAX_TEXT_LENGTH, `不能超过 ${MAX_TEXT_LENGTH} 个字符`)
  .refine((value) => !hasControlChar(value), '不能含控制字符');

const AgentSchema = z
  .object({
    id: actionText,
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/, 'tokenSha256 须为 64 位小写十六进制'),
    principalId: actionText.optional(),
    principalRoles: z.array(actionText).max(MAX_ROLES, `principalRoles 不能超过 ${MAX_ROLES} 项`).optional(),
  })
  .strict();

const AgentsFileSchema = z
  .object({ agents: z.array(AgentSchema).min(1, 'agents 不能为空') })
  .strict()
  .superRefine(({ agents }, ctx) => {
    for (const key of ['id', 'tokenSha256'] as const) {
      const seen = new Set<string>();
      agents.forEach((agent, i) => {
        if (seen.has(agent[key])) ctx.addIssue({ code: 'custom', path: ['agents', i, key], message: `${key} 重复` });
        seen.add(agent[key]);
      });
    }
  });

/** 读取并严格校验登记文件；任何问题抛 ConfigError（错误信息不含文件内容）。 */
export function loadAgents(path: string): AgentEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`无法读取 agents 登记文件 ${path}：${e instanceof SyntaxError ? 'JSON 无效' : e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = AgentsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      [`agents 登记文件 ${path} 有误：`, ...parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(根)'}：${i.message}`)].join('\n'),
    );
  }
  return parsed.data.agents;
}

const BEARER = /^Bearer +(\S+)$/i;

/**
 * 按 `Authorization: Bearer <token>` 找登记项。对 token 做 sha256 后与每一项定长比较，遍历全部项不提前返回，
 * 耗时与哪一项匹配无关。缺头、非 Bearer、未登记均为 undefined。
 */
export function authenticate(header: string | undefined, agents: readonly AgentEntry[]): AgentEntry | undefined {
  const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
  if (!token) return undefined;
  const digest = createHash('sha256').update(token, 'utf8').digest();
  let match: AgentEntry | undefined;
  for (const agent of agents) {
    if (timingSafeEqual(digest, Buffer.from(agent.tokenSha256, 'hex')) && match === undefined) match = agent;
  }
  return match;
}
