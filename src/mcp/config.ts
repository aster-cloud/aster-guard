// aster-guard-mcp 的命令行配置：解析 argv 与环境变量，用 zod 校验后得到 ProxyConfig（ADR 0040 §6）。
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { GuardPrincipal } from '../types.js';

/** 缺省的 API key 环境变量名。API key 只从环境变量读取，不接受命令行传入（argv 对同机其他进程可见）。 */
export const DEFAULT_API_KEY_ENV = 'ASTER_GUARD_API_KEY';

/** 缺省的人工审批等待秒数（§6）。 */
const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

export const USAGE = `用法：aster-guard-mcp --base-url <url> --policy <module>/<function> --principal-id <id> [选项]

stdio MCP 服务器。指定 --upstream 时包裹该上游 MCP 服务器：原样转发 tools/list，
每一次 tools/call 先经 Aster Action Guard 裁决，ALLOW 才转发，DENY 返回工具错误，
PENDING 等待人工审批后再按结论处理（ADR 0040 §6）。不指定 --upstream 时只提供
guard_check / guard_status / guard_list_approvals / guard_approve / guard_reject 五个治理工具。

必填：
  --base-url <url>              aster-api 根地址，如 https://api.aster-lang.cloud
  --policy <module>/<function>  裁决所用的策略，如 guard.customer/decide
  --principal-id <id>           发起主体 id，如 agent-42

选项：
  --upstream "<cmd> [args…]"    上游 MCP 服务器的启动命令，按 shell 规则切分（支持引号与反斜杠转义）
  --api-key-env <name>          存放 API key 的环境变量名，缺省 ${DEFAULT_API_KEY_ENV}；
                                API key 只从环境变量读取，且不会传给上游进程
  --principal-type <type>       主体类型，缺省 agent
  --principal-roles <a,b>       主体角色，逗号分隔
  --approval-timeout <seconds>  等待人工审批的最长秒数，缺省 ${DEFAULT_APPROVAL_TIMEOUT_SECONDS}；
                                MCP 宿主的请求 / 工具调用超时须不小于该值，否则 PENDING 调用会被宿主取消
  --resource-from <argName>     取该工具参数的值作为 resource.id（resource.type 为 arg）
  --agent-model <model>         写入 action.agent.model 的模型名
  -h, --help                    显示本帮助

stdout 是 MCP 通道，日志一律写到 stderr。
`;

/** 配置错误：参数缺失或非法、API key 环境变量未设置。message 末尾附用法提示。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`${message}\n运行 aster-guard-mcp --help 查看用法。`);
    this.name = 'ConfigError';
  }
}

/** 解析后的代理配置。 */
export interface ProxyConfig {
  /** 上游 MCP 服务器的启动命令；缺省表示治理工具模式。 */
  upstream?: { command: string; args: string[] };
  baseUrl: string;
  /** API key 所在的环境变量名（构造上游环境时要剔除它）。 */
  apiKeyEnv: string;
  apiKey: string;
  policyModule: string;
  policyFunction: string;
  principal: GuardPrincipal;
  approvalTimeoutMs: number;
  resourceFromArg?: string;
  agentModel?: string;
}

const OPTIONS = {
  upstream: { type: 'string' },
  'base-url': { type: 'string' },
  'api-key-env': { type: 'string' },
  policy: { type: 'string' },
  'principal-id': { type: 'string' },
  'principal-type': { type: 'string' },
  'principal-roles': { type: 'string' },
  'approval-timeout': { type: 'string' },
  'resource-from': { type: 'string' },
  'agent-model': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** 必填的非空字符串参数；parseArgs 只产出字符串，类型错误只可能是「未提供」。 */
function requiredText(flag: string) {
  return z.string({ error: `缺少必填参数 --${flag}` }).trim().min(1, `--${flag} 不能为空`);
}

function optionalText(flag: string) {
  return z.string().trim().min(1, `--${flag} 不能为空`).optional();
}

const CliSchema = z.object({
  upstream: z.string().optional(),
  'base-url': z.url({
    protocol: /^https?$/,
    error: (issue) => (issue.input === undefined ? '缺少必填参数 --base-url' : '--base-url 须为 http(s) URL'),
  }),
  'api-key-env': optionalText('api-key-env'),
  policy: requiredText('policy').regex(/^[^/\s]+\/[^/\s]+$/, '--policy 须为 <module>/<function>，如 guard.customer/decide'),
  'principal-id': requiredText('principal-id'),
  'principal-type': optionalText('principal-type'),
  'principal-roles': z.string().optional(),
  'approval-timeout': z
    .string()
    .regex(/^\d+(\.\d+)?$/, '--approval-timeout 须为非负秒数')
    .optional(),
  'resource-from': optionalText('resource-from'),
  'agent-model': optionalText('agent-model'),
});

/** argv 中是否请求帮助。宽松解析：即使其他参数缺失或非法也能识别 --help / -h。 */
export function wantsHelp(argv: readonly string[]): boolean {
  const { values } = parseArgs({ args: [...argv], options: OPTIONS, strict: false, allowPositionals: true });
  return values.help === true;
}

/**
 * 把 argv（不含 node 与脚本路径）与环境变量解析为 ProxyConfig；任何问题都抛 ConfigError。
 * 帮助请求先用 {@link wantsHelp} 判断。
 */
export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ProxyConfig {
  const parsed = CliSchema.safeParse(readOptions(argv));
  if (!parsed.success) {
    throw new ConfigError(['参数有误：', ...parsed.error.issues.map((issue) => `  - ${issue.message}`)].join('\n'));
  }
  const options = parsed.data;
  const apiKeyEnv = options['api-key-env'] ?? DEFAULT_API_KEY_ENV;
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new ConfigError(`环境变量 ${apiKeyEnv} 未设置 API key`);
  }
  const [policyModule, policyFunction] = options.policy.split('/');
  const roles = options['principal-roles']
    ?.split(',')
    .map((role) => role.trim())
    .filter((role) => role !== '');
  return {
    ...(options.upstream === undefined ? {} : { upstream: parseUpstream(options.upstream) }),
    baseUrl: options['base-url'],
    apiKeyEnv,
    apiKey,
    policyModule,
    policyFunction,
    principal: {
      id: options['principal-id'],
      type: options['principal-type'] ?? 'agent',
      ...(roles?.length ? { roles } : {}),
    },
    approvalTimeoutMs: Math.round(Number(options['approval-timeout'] ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS) * 1000),
    ...(options['resource-from'] === undefined ? {} : { resourceFromArg: options['resource-from'] }),
    ...(options['agent-model'] === undefined ? {} : { agentModel: options['agent-model'] }),
  };
}

/** 严格解析：未知参数、多余的位置参数、缺值的参数都转为 ConfigError。 */
function readOptions(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
}

function parseUpstream(commandLine: string): { command: string; args: string[] } {
  const [command, ...args] = splitShellWords(commandLine);
  if (command === undefined || command === '') {
    throw new ConfigError('--upstream 不能为空');
  }
  return { command, args };
}

/**
 * 一个词片：裸字符 | '单引号' | "双引号" | 反斜杠转义 | 落单的引号（未闭合），后接空白时词结束。
 * 移植自 Ruby Shellwords.split；不做变量展开、通配与命令替换。
 * 与 Ruby 不同，JS 正则的可选分组不接受空匹配，(\s|$)? 匹配不到串尾，因此最后一个词在循环结束后收尾。
 */
const WORD_PIECE = /\s*(?:([^\s\\'"]+)|'([^']*)'|"((?:[^"\\]|\\.)*)"|(\\.?)|(\S))(\s)?/sy;

/** 按 POSIX shell 的引号规则切分命令行；引号未闭合抛 ConfigError。 */
export function splitShellWords(line: string): string[] {
  const words: string[] = [];
  // undefined 表示当前没有进行中的词；'' 是合法的词（来自 '' 或 ""）。
  let word: string | undefined;
  WORD_PIECE.lastIndex = 0;
  for (let m = WORD_PIECE.exec(line); m !== null; m = WORD_PIECE.exec(line)) {
    const [, bare, single, double, escaped, unmatched, separator] = m;
    if (unmatched !== undefined) {
      throw new ConfigError(`--upstream 的引号未闭合：${line}`);
    }
    // 双引号内反斜杠只转义 $ ` " \ 与换行；引号外反斜杠转义任意字符。
    word = (word ?? '') + (bare ?? single ?? double?.replace(/\\([$`"\\\n])/g, '$1') ?? escaped.replace(/\\(.)/s, '$1'));
    if (separator !== undefined) {
      words.push(word);
      word = undefined;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * 上游子进程的环境：透传本进程环境（上游常需自己的 token 等变量），但剔除 guard 的 API key——
 * 被守护的上游不应持有守门的凭据。
 */
export function upstreamEnv(env: NodeJS.ProcessEnv, apiKeyEnv: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[0] !== apiKeyEnv && entry[1] !== undefined),
  );
}
