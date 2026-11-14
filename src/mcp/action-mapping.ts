// 工具调用 → Guard Action 的映射与「同一对象」不变式（ADR 0054 §3.2）。
// 规范化只排序键、保留 null、不删键、不改类型；送去 Guard 的 action.context 与转发给上游的 arguments 是同一个对象，
// digestArgs 是唯一例外：Guard 看到的副本里该键以 { $sha256 } 代入，转发的仍是原值。
import { createHash } from 'node:crypto';
import { canonicalize, jcsSha256 } from '../hash/jcs.js';
import type { GuardAction, GuardPrincipal } from '../types.js';
import { isActionText } from './action-limits.js';

/** 按工具的映射（配置文件 `actions.<toolName>`）。 */
export interface ActionMapping {
  /** 取该顶层参数作 resource.id（resource.type 为 arg）。 */
  resourceFrom?: string;
  /** 这些顶层参数在 context 中以 `{ $sha256 }` 代入。 */
  digestArgs?: string[];
  /** 覆盖 action.name（缺省为工具名）。 */
  actionName?: string;
}

/**
 * 递归按键排序（UTF-16 码元序）、保留 null 的深拷贝；JCS 无法表示的值（NaN、undefined、函数、bigint、非纯对象等）
 * 抛 JcsError。返回的对象既是哈希输入，也是转发给上游的参数。
 */
export function canonicalArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = args ?? {};
  // 先整体校验：与 hashAction 同一套规则，失败即在发 /decisions 之前拒绝。
  canonicalize(source);
  return sortDeep(source) as Record<string, unknown>;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      Object.defineProperty(out, key, { value: sortDeep(record[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/** 构造 Action：无 digestArgs 时 `context === args`（同一引用）；参数里的 principal 只是普通 context 键。 */
export function buildToolAction(input: {
  toolName: string;
  args: Record<string, unknown>;
  mapping?: ActionMapping;
  defaultResourceFrom?: string;
  principal: GuardPrincipal;
  agentModel?: string;
}): GuardAction {
  const { toolName, args, mapping, defaultResourceFrom, principal, agentModel } = input;
  const resourceFrom = mapping?.resourceFrom ?? defaultResourceFrom;
  const resourceValue = resourceFrom === undefined ? undefined : args[resourceFrom];
  const action: GuardAction = {
    principal,
    action: { name: mapping?.actionName ?? toolName },
    context: digested(args, mapping?.digestArgs),
  };
  if (resourceValue !== undefined && resourceValue !== null) {
    action.resource = { type: 'arg', id: resourceIdText(resourceValue) };
  }
  if (agentModel) action.agent = { model: agentModel };
  return action;
}

/** digestArgs 中**存在**的键替换为其 JCS 值的摘要（值为 null 时摘要输入是字面量 null）；缺失的键不生成。 */
function digested(args: Record<string, unknown>, digestArgs: string[] | undefined): Record<string, unknown> {
  const present = (digestArgs ?? []).filter((key) => Object.hasOwn(args, key));
  if (present.length === 0) return args;
  const copy: Record<string, unknown> = { ...args };
  for (const key of present) copy[key] = { $sha256: jcsSha256(args[key]) };
  return copy;
}

/** 票据 envelope：被哈希的 action 去掉 context（ADR 0054 §11 D2）。 */
export function envelopeOf(action: GuardAction): Omit<GuardAction, 'context'> {
  const { context: _context, ...envelope } = action;
  void _context;
  return envelope;
}

/**
 * resource.id 的文本：字符串、数字、布尔按 String()；对象与数组用 JSON，避免不同资源都变成 "[object Object]"。
 * 超出服务端文本字段限制（> 255 字符或含控制字符）时改用 `sha256:<hex>`，同一资源得到同一 id。
 */
export function resourceIdText(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return isActionText(text) ? text : `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
