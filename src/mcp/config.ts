// aster-guard-mcp 的命令行配置：解析 argv 与环境变量，用 zod 校验后得到 ProxyConfig（ADR 0040 §6）。
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { GuardPrincipal } from '../types.js';
import type { ActionMapping } from './action-mapping.js';
import type { Isolation } from './proxy.js';
import { hasControlChar, MAX_ROLES, MAX_TEXT_LENGTH } from './action-limits.js';

/** 缺省的 API key 环境变量名。API key 只从环境变量读取，不接受命令行传入（argv 对同机其他进程可见）。 */
const DEFAULT_API_KEY_ENV = 'ASTER_GUARD_API_KEY';

/** 缺省的人工审批等待秒数（§6）。 */
const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

/** 缺省的上游请求超时秒数。 */
const DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 600;

/** 上游超时秒数的上限：换算成毫秒后须在 setTimeout 的 32 位范围内（约 24.8 天）。 */
const MAX_UPSTREAM_TIMEOUT_SECONDS = 2_147_483;

export const USAGE = `用法：aster-guard-mcp --base-url <url> --policy <module>/<function> --principal-id <id> [选项]

stdio MCP 服务器。指定 --upstream 或 --upstream-url 时包裹该上游 MCP 服务器：原样转发 tools/list，
每一次 tools/call 先经 Aster Action Guard 裁决，ALLOW 才转发，DENY 返回工具错误，
PENDING 等待人工审批后再按结论处理（ADR 0040 §6）。不指定上游时只提供
guard_check / guard_status / guard_list_approvals / guard_approve / guard_reject 五个治理工具。

必填：
  --base-url <url>              aster-api 根地址，如 https://api.aster-lang.cloud
  --policy <module>/<function>  裁决所用的策略，如 guard.customer/decide
  --principal-id <id>           发起主体 id，如 agent-42（stdio 服务模式必填；监听模式不接受）

选项：
  --upstream "<cmd> [args…]"    上游 MCP 服务器的启动命令，按 shell 规则切分（支持引号与反斜杠转义）
  --upstream-url <url>          上游为 Streamable HTTP MCP 服务器（http(s) URL，如 http://tool:8080/mcp）；
                                与 --upstream 二选一
  --upstream-auth-env <name>    连接 --upstream-url 时以该环境变量的值作 Authorization: Bearer；
                                须与 API key 变量不同，值不会写进日志或错误信息
  --api-key-env <name>          存放 API key 的环境变量名，缺省 ${DEFAULT_API_KEY_ENV}；
                                API key 只从环境变量读取，且不会传给上游进程
  --principal-type <type>       主体类型，缺省 agent
  --principal-roles <a,b>       主体角色，逗号分隔，至多 ${MAX_ROLES} 项
  --approval-timeout <seconds>  等待人工审批的最长秒数，缺省 ${DEFAULT_APPROVAL_TIMEOUT_SECONDS}；
                                MCP 宿主的请求 / 工具调用超时须不小于该值，否则 PENDING 调用会被宿主取消
  --upstream-timeout <seconds>  放行后等待上游工具返回的最长秒数（正整数），缺省 ${DEFAULT_UPSTREAM_TIMEOUT_SECONDS}；
                                上游每报告一次 progress 重新计时，超时后下游收到 RequestTimeout 错误
  --resource-from <argName>     取该工具参数的值作为 resource.id（resource.type 为 arg）；
                                超过 ${MAX_TEXT_LENGTH} 字符或含控制字符时改用 sha256:<hex>
  --agent-model <model>         写入 action.agent.model 的模型名

执行点（有上游时；ADR 0054 §2–§3，R66）：
  --tenant-id <id>              API key 所属租户（必填）：执行收据的 payload.tenantId 须与之相等
  --isolation <list>            原始工具端点的隔离方式（必填，逗号分隔，取值 network、auth；配置自述，
                                由部署层绕过测试验证，ADR 0054 §12 D1）：
                                network = 上游只接受来自代理的连接（stdio 子进程天然满足；HTTP 上游由
                                          部署层网络策略保证，代理本身不做任何事）；
                                auth    = 转发时在 params._meta["io.aster/guard-consume"] 附 consume 票据，
                                          上游工具用 @aster-cloud/aster-guard/tool 的 verifyConsumeTicket 核对；
                                network,auth = 两层同时声明：网络策略挡直连，即使网络层失效，
                                          工具侧票据核对仍拒绝无票据 / 伪造票据的调用
  --tools <a,b>                 工具白名单：只有列出的上游工具出现在 tools/list 且可调用（覆盖配置文件 tools）；
                                未配置则全部暴露并在启动时告警
  --config <file.json>          配置文件 { "tools": [...], "actions": { "<tool>": { "resourceFrom", "digestArgs", "actionName" } } }；
                                未知键报错；actions 里的工具须在白名单内
  --executor-id <id>            对账用执行方标识，缺省 aster-guard-mcp@<hostname>（≤ 255 字符、无控制字符）
  -h, --help                    显示本帮助

Streamable HTTP 监听模式（ADR 0054 §3.1、§12 D4；须有上游）：
  --listen <host>:<port>        以无状态 Streamable HTTP 在该地址提供服务：POST /mcp（Bearer 鉴权），
                                GET /healthz（进程存活）、GET /readyz（最近 30 秒内上游 tools/list 成功过）；
                                --upstream-url 连不上或断开时不退出：后台退避重连（0.5 秒起、封顶 30 秒），
                                未就绪期间 readyz 为 503，tools/call 不裁决、以 upstream_unavailable 拒绝
  --agents-file <file.json>     Agent 登记 { "agents": [{ "id", "tokenSha256", "principalId"?, "principalRoles"? }] }；
                                只存 token 的 sha256（64 位小写十六进制）；每个 Agent 以自己的 principal 裁决，
                                因此监听模式不接受 --principal-id / --principal-type / --principal-roles

--principal-id / --principal-type / --agent-model 与每个角色须为 1–${MAX_TEXT_LENGTH} 字符且不含控制字符
（aster-api 对 Action 文本字段的限制），否则以参数错误退出。

stdout 是 MCP 通道，日志一律写到 stderr。
`;

/** 配置错误：参数缺失或非法、API key 环境变量未设置。message 末尾附用法提示。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`${message}\n运行 aster-guard-mcp --help 查看用法。`);
    this.name = 'ConfigError';
  }
}

/** 上游 MCP 服务器：stdio 子进程（命令 + 参数）或 Streamable HTTP（URL + 可选的 Bearer 变量名）。 */
export type UpstreamSpec =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'http'; url: URL; authEnv?: string };

/** 解析后的代理配置。 */
export interface ProxyConfig {
  /** 上游 MCP 服务器：stdio 子进程或 Streamable HTTP；缺省表示治理工具模式。 */
  upstream?: UpstreamSpec;
  baseUrl: string;
  /** API key 所在的环境变量名（构造上游环境时要剔除它）。 */
  apiKeyEnv: string;
  apiKey: string;
  policyModule: string;
  policyFunction: string;
  /** stdio 服务模式的主体；监听模式缺省（每个 Agent 的 principal 取自 --agents-file）。 */
  principal?: GuardPrincipal;
  /** 监听模式：以无状态 Streamable HTTP 在该地址提供服务。 */
  listen?: { host: string; port: number };
  /** 监听模式：Agent 登记文件路径（ADR 0054 §12 D4）。 */
  agentsFile?: string;
  approvalTimeoutMs: number;
  upstreamTimeoutMs: number;
  resourceFromArg?: string;
  agentModel?: string;
  /** 有上游时必填：收据租户核对。 */
  tenantId?: string;
  /** 对账用执行方标识（ADR 0054 §5）。 */
  executorId: string;
  /** 有上游时必填：隔离方式自述（去重、按字母序）。 */
  isolation?: readonly Isolation[];
  /** 工具白名单；缺省全部暴露。 */
  tools?: string[];
  /** 按工具的 action 映射。 */
  actions: Record<string, ActionMapping>;
}

const OPTIONS = {
  upstream: { type: 'string' },
  'upstream-url': { type: 'string' },
  'upstream-auth-env': { type: 'string' },
  listen: { type: 'string' },
  'agents-file': { type: 'string' },
  'base-url': { type: 'string' },
  'api-key-env': { type: 'string' },
  policy: { type: 'string' },
  'principal-id': { type: 'string' },
  'principal-type': { type: 'string' },
  'principal-roles': { type: 'string' },
  'approval-timeout': { type: 'string' },
  'upstream-timeout': { type: 'string' },
  'resource-from': { type: 'string' },
  'agent-model': { type: 'string' },
  'tenant-id': { type: 'string' },
  'executor-id': { type: 'string' },
  isolation: { type: 'string' },
  tools: { type: 'string' },
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** 必填的非空字符串参数；parseArgs 只产出字符串，类型错误只可能是「未提供」。 */
function requiredText(flag: string) {
  return z.string({ error: `缺少必填参数 --${flag}` }).trim().min(1, `--${flag} 不能为空`);
}

function optionalText(flag: string) {
  return z.string().trim().min(1, `--${flag} 不能为空`).optional();
}

/**
 * 写入 Action 文本字段的值：≤ 255 字符且不含控制字符（服务端 GuardActionMapper 的限制）。
 * 在启动时拒绝，而不是让每一次 check 都变成 DENY http_400。
 */
function actionText(schema: z.ZodString, label: string) {
  return schema
    .max(MAX_TEXT_LENGTH, `${label} 不能超过 ${MAX_TEXT_LENGTH} 个字符`)
    .refine((value) => !hasControlChar(value), `${label} 不能含控制字符`);
}

/** 逗号分隔的角色表：去掉各项首尾空白与空项，至多 16 项，每项按 Action 文本字段校验。 */
const rolesList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role !== ''),
  )
  .pipe(
    z
      .array(actionText(z.string(), '--principal-roles 的每一项'))
      .max(MAX_ROLES, `--principal-roles 不能超过 ${MAX_ROLES} 项`),
  );

/** 逗号分隔的隔离方式：去空白与空项，至少一项，去重后按字母序。 */
const isolationList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  )
  .pipe(
    z
      .array(z.enum(['network', 'auth'], { error: '--isolation 的每一项须为 network 或 auth' }))
      .min(1, '--isolation 不能为空（network、auth 或 network,auth）'),
  )
  .transform((items) => [...new Set(items)].sort() as Isolation[]);

const CliSchema = z.object({
  upstream: z.string().optional(),
  'upstream-url': z
    .url({ protocol: /^https?$/, error: '--upstream-url 须为 http(s) URL' })
    .optional(),
  'upstream-auth-env': optionalText('upstream-auth-env'),
  listen: optionalText('listen'),
  'agents-file': optionalText('agents-file'),
  'base-url': z.url({
    protocol: /^https?$/,
    error: (issue) => (issue.input === undefined ? '缺少必填参数 --base-url' : '--base-url 须为 http(s) URL'),
  }),
  'api-key-env': optionalText('api-key-env'),
  policy: requiredText('policy').regex(/^[^/\s]+\/[^/\s]+$/, '--policy 须为 <module>/<function>，如 guard.customer/decide'),
  'principal-id': actionText(z.string().trim().min(1, '--principal-id 不能为空'), '--principal-id').optional(),
  'principal-type': actionText(z.string().trim().min(1, '--principal-type 不能为空'), '--principal-type').optional(),
  'principal-roles': rolesList.optional(),
  'approval-timeout': z
    .string()
    .regex(/^\d+(\.\d+)?$/, '--approval-timeout 须为非负秒数')
    .optional(),
  'upstream-timeout': z
    .string()
    .regex(/^\d+$/, '--upstream-timeout 须为正整数秒')
    .transform(Number)
    .pipe(
      z
        .number()
        .min(1, '--upstream-timeout 须为正整数秒')
        .max(MAX_UPSTREAM_TIMEOUT_SECONDS, `--upstream-timeout 不能超过 ${MAX_UPSTREAM_TIMEOUT_SECONDS} 秒`),
    )
    .optional(),
  'resource-from': optionalText('resource-from'),
  'agent-model': actionText(z.string().trim().min(1, '--agent-model 不能为空'), '--agent-model').optional(),
  'tenant-id': actionText(z.string().trim().min(1, '--tenant-id 不能为空'), '--tenant-id').optional(),
  'executor-id': z
    .string()
    .trim()
    .min(1, '--executor-id 不能为空')
    .max(255, '--executor-id 不能超过 255 个字符')
    .refine((value) => !hasControlChar(value), '--executor-id 不能含控制字符')
    .optional(),
  isolation: isolationList.optional(),
  tools: z
    .string()
    .transform((value) => value.split(',').map((t) => t.trim()).filter((t) => t !== ''))
    .pipe(z.array(z.string()).min(1, '--tools 不能为空'))
    .optional(),
  config: optionalText('config'),
});

/** 配置文件：严格模式，未知键报错。 */
const MappingSchema = z
  .object({
    resourceFrom: z.string().min(1).optional(),
    digestArgs: z
      .array(z.string().min(1, 'digestArgs 的每一项须为非空字符串'))
      .transform((keys) => [...new Set(keys)])
      .pipe(z.array(z.string()).min(1, 'digestArgs 不能为空'))
      .optional(),
    actionName: actionText(z.string().trim().min(1, 'actionName 不能为空'), 'actionName').optional(),
  })
  .strict();
const ConfigFileSchema = z
  .object({
    tools: z.array(z.string().min(1)).min(1).optional(),
    actions: z.record(z.string(), MappingSchema).optional(),
  })
  .strict();

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
  const raw = readOptions(argv);
  const parsed = CliSchema.safeParse(raw);
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  // stdio 服务模式 --principal-id 必填（监听模式取自 --agents-file），与其它缺失的必填参数一并列出。
  if (raw.listen === undefined && raw['principal-id'] === undefined) issues.push('缺少必填参数 --principal-id');
  if (!parsed.success || issues.length > 0) {
    throw new ConfigError(['参数有误：', ...issues.map((message) => `  - ${message}`)].join('\n'));
  }
  const options = parsed.data;
  const apiKeyEnv = options['api-key-env'] ?? DEFAULT_API_KEY_ENV;
  const apiKey = env[apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new ConfigError(`环境变量 ${apiKeyEnv} 未设置 API key`);
  }
  const [policyModule, policyFunction] = options.policy.split('/');
  const upstream = upstreamSpec(options, env, apiKeyEnv);
  const execution = executionConfig(options, upstream !== undefined);
  return {
    ...(upstream === undefined ? {} : { upstream }),
    baseUrl: options['base-url'],
    apiKeyEnv,
    apiKey,
    policyModule,
    policyFunction,
    ...servingConfig(options, upstream !== undefined),
    approvalTimeoutMs: Math.round(Number(options['approval-timeout'] ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS) * 1000),
    upstreamTimeoutMs: (options['upstream-timeout'] ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS) * 1000,
    ...(options['resource-from'] === undefined ? {} : { resourceFromArg: options['resource-from'] }),
    ...(options['agent-model'] === undefined ? {} : { agentModel: options['agent-model'] }),
    ...execution,
  };
}

type CliOptions = z.infer<typeof CliSchema>;

/**
 * 服务方式：缺省 stdio，principal 来自 --principal-*（--principal-id 必填）；--listen 为监听模式，
 * 须有上游与 --agents-file，且不接受 --principal-*——每个 Agent 的 principal 取自登记文件。
 */
function servingConfig(options: CliOptions, hasUpstream: boolean): Pick<ProxyConfig, 'principal' | 'listen' | 'agentsFile'> {
  const { listen, 'agents-file': agentsFile } = options;
  if (listen === undefined) {
    if (agentsFile !== undefined) throw new ConfigError('--agents-file 只用于监听模式（需同时指定 --listen）');
    const roles = options['principal-roles'];
    return {
      principal: {
        // parseCliArgs 已保证非监听模式有 --principal-id。
        id: options['principal-id'] as string,
        type: options['principal-type'] ?? 'agent',
        ...(roles?.length ? { roles } : {}),
      },
    };
  }
  if (!hasUpstream) throw new ConfigError('监听模式需要上游（--upstream 或 --upstream-url）');
  if (agentsFile === undefined) throw new ConfigError('监听模式缺少必填参数 --agents-file');
  const misplaced = (['principal-id', 'principal-type', 'principal-roles'] as const).filter((k) => options[k] !== undefined);
  if (misplaced.length > 0) {
    throw new ConfigError(`${misplaced.map((k) => `--${k}`).join(' / ')} 不能用于监听模式：监听模式的 principal 取自 --agents-file`);
  }
  return { listen: parseListen(listen), agentsFile };
}

/** `<host>:<port>` 或 `[<ipv6>]:<port>`，端口 1–65535。 */
function parseListen(value: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value);
  const port = m ? Number(m[3]) : NaN;
  if (!m || !(port >= 1 && port <= 65535)) {
    throw new ConfigError(`--listen 须为 <host>:<port>（端口 1–65535），如 0.0.0.0:8080：${value}`);
  }
  return { host: m[1] ?? m[2], port };
}

/**
 * 上游：--upstream（stdio）与 --upstream-url（HTTP）二选一；--upstream-auth-env 只配 --upstream-url，
 * 不能与 API key 变量同名（否则 Guard 凭据会发给被守护的工具），变量须已设置且非空。错误信息只写变量名。
 */
function upstreamSpec(options: CliOptions, env: NodeJS.ProcessEnv, apiKeyEnv: string): UpstreamSpec | undefined {
  const url = options['upstream-url'];
  const authEnv = options['upstream-auth-env'];
  if (options.upstream !== undefined && url !== undefined) {
    throw new ConfigError('--upstream 与 --upstream-url 不能同时指定');
  }
  if (authEnv !== undefined && url === undefined) {
    throw new ConfigError('--upstream-auth-env 只用于 --upstream-url');
  }
  if (url === undefined) {
    return options.upstream === undefined ? undefined : parseUpstream(options.upstream);
  }
  if (authEnv === undefined) return { kind: 'http', url: new URL(url) };
  if (authEnv === apiKeyEnv) {
    throw new ConfigError(`--upstream-auth-env 不能与 API key 变量（${apiKeyEnv}）相同：Guard 凭据不得发给上游`);
  }
  if (!env[authEnv]?.trim()) {
    throw new ConfigError(`环境变量 ${authEnv}（--upstream-auth-env）未设置或为空`);
  }
  return { kind: 'http', url: new URL(url), authEnv };
}

/** 执行点相关配置：只在有上游时允许；有上游时 --tenant-id 与 --isolation 必填。 */
function executionConfig(
  options: CliOptions,
  hasUpstream: boolean,
): Pick<ProxyConfig, 'tenantId' | 'executorId' | 'isolation' | 'tools' | 'actions'> {
  const executorId = options['executor-id'] ?? `aster-guard-mcp@${hostname()}`;
  if (!hasUpstream) {
    const misplaced = (['tenant-id', 'isolation', 'tools', 'config'] as const).filter((k) => options[k] !== undefined);
    if (misplaced.length > 0) {
      throw new ConfigError(`${misplaced.map((k) => `--${k}`).join(' / ')} 只用于代理模式（需同时指定 --upstream 或 --upstream-url）`);
    }
    return { executorId, actions: {} };
  }
  if (options['tenant-id'] === undefined) throw new ConfigError('代理模式缺少必填参数 --tenant-id');
  if (options.isolation === undefined) throw new ConfigError('代理模式缺少必填参数 --isolation（network、auth 或 network,auth）');
  const file = options.config === undefined ? {} : readConfigFile(options.config);
  const tools = options.tools ?? file.tools;
  const actions = file.actions ?? {};
  const outside = Object.keys(actions).filter((tool) => tools !== undefined && !tools.includes(tool));
  if (outside.length > 0) {
    throw new ConfigError(`actions 中的工具不在白名单内：${outside.join(', ')}`);
  }
  return { tenantId: options['tenant-id'], executorId, isolation: options.isolation, ...(tools ? { tools } : {}), actions };
}

function readConfigFile(path: string): z.infer<typeof ConfigFileSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`无法读取配置文件 ${path}：${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      [`配置文件 ${path} 有误：`, ...parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(根)'}：${i.message}`)].join('\n'),
    );
  }
  return parsed.data;
}

/** 严格解析：未知参数、多余的位置参数、缺值的参数都转为 ConfigError。 */
function readOptions(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
}

function parseUpstream(commandLine: string): UpstreamSpec {
  const [command, ...args] = splitShellWords(commandLine);
  if (command === undefined || command === '') {
    throw new ConfigError('--upstream 不能为空');
  }
  return { kind: 'stdio', command, args };
}

/**
 * 一个词片：裸字符 | '单引号' | "双引号" | 反斜杠转义 | 落单的引号（未闭合），后接空白时词结束。
 * 移植自 Ruby Shellwords.split；不做变量展开、通配与命令替换。
 * 与 Ruby 不同，JS 正则的可选分组不接受空匹配，(\s|$)? 匹配不到串尾，因此最后一个词在循环结束后收尾。
 */
const WORD_PIECE = /\s*(?:([^\s\\'"]+)|'([^']*)'|"((?:[^"\\]|\\.)*)"|(\\.?)|(\S))(\s)?/sy;

/** 按 POSIX shell 的引号规则切分命令行；引号未闭合抛 ConfigError。 */
function splitShellWords(line: string): string[] {
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
