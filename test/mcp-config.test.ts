import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseCliArgs, upstreamEnv, USAGE, wantsHelp } from '../src/mcp/config.js';

// CLI 参数 / 环境变量解析（zod 校验）。API key 只从环境变量读取，绝不出现在 argv 中。

const REQUIRED = [
  '--base-url',
  'https://api.example.com',
  '--policy',
  'guard.customer/decide',
  '--principal-id',
  'agent-42',
];
const ENV = { ASTER_GUARD_API_KEY: 'ak_test' };
/** 代理模式的必填执行点参数（ADR 0054 R66 D8）。 */
const EXEC = ['--tenant-id', 'team-1', '--isolation', 'network'];

describe('parseCliArgs', () => {
  it('完整参数解析为 ProxyConfig', () => {
    const config = parseCliArgs(
      [
        '--upstream',
        "node server.js --flag 'a b'",
        '--base-url',
        'https://api.example.com/',
        '--api-key-env',
        'MY_GUARD_KEY',
        '--policy',
        'guard.customer/decide',
        '--principal-id',
        'agent-42',
        '--principal-type',
        'service',
        '--principal-roles',
        'ops-bot, support,,',
        '--approval-timeout',
        '90',
        '--upstream-timeout',
        '120',
        '--resource-from',
        'customerId',
        '--agent-model',
        'claude-x',
        ...EXEC,
        '--tools',
        'echo, delete_customer',
        '--executor-id',
        'aster-guard-mcp@host-1',
      ],
      { MY_GUARD_KEY: 'ak_custom' },
    );

    expect(config).toEqual({
      upstream: { command: 'node', args: ['server.js', '--flag', 'a b'] },
      baseUrl: 'https://api.example.com/',
      apiKeyEnv: 'MY_GUARD_KEY',
      apiKey: 'ak_custom',
      policyModule: 'guard.customer',
      policyFunction: 'decide',
      principal: { id: 'agent-42', type: 'service', roles: ['ops-bot', 'support'] },
      approvalTimeoutMs: 90_000,
      upstreamTimeoutMs: 120_000,
      resourceFromArg: 'customerId',
      agentModel: 'claude-x',
      tenantId: 'team-1',
      isolation: 'network',
      executorId: 'aster-guard-mcp@host-1',
      tools: ['echo', 'delete_customer'],
      actions: {},
    });
  });

  it('缺省值：无上游、API key 取 ASTER_GUARD_API_KEY、主体类型 agent、审批等待 300 秒、上游超时 600 秒', () => {
    const config = parseCliArgs(REQUIRED, ENV);

    expect(config).toEqual({
      baseUrl: 'https://api.example.com',
      apiKeyEnv: 'ASTER_GUARD_API_KEY',
      apiKey: 'ak_test',
      policyModule: 'guard.customer',
      policyFunction: 'decide',
      principal: { id: 'agent-42', type: 'agent' },
      approvalTimeoutMs: 300_000,
      upstreamTimeoutMs: 600_000,
      executorId: `aster-guard-mcp@${hostname()}`,
      actions: {},
    });
  });

  it('Action 文本限制的边界值可以通过：255 字符的主体 id / 类型 / 模型名、16 个角色', () => {
    const roles = Array.from({ length: 16 }, (_, i) => `role-${i}`);
    const config = parseCliArgs(
      [
        ...REQUIRED,
        '--principal-id',
        'i'.repeat(255),
        '--principal-type',
        't'.repeat(255),
        '--principal-roles',
        roles.join(','),
        '--agent-model',
        'm'.repeat(255),
        '--upstream-timeout',
        '2147483',
      ],
      ENV,
    );
    expect(config.principal).toEqual({ id: 'i'.repeat(255), type: 't'.repeat(255), roles });
    expect(config.agentModel).toBe('m'.repeat(255));
    expect(config.upstreamTimeoutMs).toBe(2_147_483_000);
  });

  it('支持 --flag=value 写法与小数秒', () => {
    const config = parseCliArgs([...REQUIRED, '--approval-timeout=1.5'], ENV);
    expect(config.approvalTimeoutMs).toBe(1_500);
  });

  it('API key 环境变量缺失或为空白 → ConfigError（提示变量名）', () => {
    expect(() => parseCliArgs(REQUIRED, {})).toThrow(ConfigError);
    expect(() => parseCliArgs(REQUIRED, {})).toThrow(/ASTER_GUARD_API_KEY/);
    expect(() => parseCliArgs([...REQUIRED, '--api-key-env', 'OTHER'], ENV)).toThrow(/OTHER/);
    expect(() => parseCliArgs(REQUIRED, { ASTER_GUARD_API_KEY: '  ' })).toThrow(ConfigError);
  });

  it('缺必填参数 → ConfigError，逐项列出并附用法提示', () => {
    let error: unknown;
    try {
      parseCliArgs([], ENV);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toMatch(/--base-url/);
    expect(message).toMatch(/--policy/);
    expect(message).toMatch(/--principal-id/);
    expect(message).toMatch(/--help/);
  });

  it.each([
    ['--policy 缺少 /', ['--policy', 'guard.customer']],
    ['--policy 多个 /', ['--policy', 'a/b/c']],
    ['--base-url 非 http(s)', ['--base-url', 'ftp://x']],
    ['--approval-timeout 非数字', ['--approval-timeout', 'abc']],
    ['--approval-timeout 负数', ['--approval-timeout=-1']],
    ['--approval-timeout 空串', ['--approval-timeout', '']],
    ['--upstream-timeout 为 0', ['--upstream-timeout', '0']],
    ['--upstream-timeout 负数', ['--upstream-timeout=-1']],
    ['--upstream-timeout 小数', ['--upstream-timeout', '1.5']],
    ['--upstream-timeout 非数字', ['--upstream-timeout', 'abc']],
    ['--upstream-timeout 超过计时器上限', ['--upstream-timeout', '2147484']],
    ['--principal-id 超过 255 字符', ['--principal-id', 'i'.repeat(256)]],
    ['--principal-id 含控制字符', ['--principal-id', 'agent\u000742']],
    ['--principal-type 超过 255 字符', ['--principal-type', 't'.repeat(256)]],
    ['--agent-model 超过 255 字符', ['--agent-model', 'm'.repeat(256)]],
    ['--agent-model 含控制字符', ['--agent-model', 'claude\u0085x']],
    ['--principal-roles 超过 16 项', ['--principal-roles', Array.from({ length: 17 }, (_, i) => `r${i}`).join(',')]],
    ['--principal-roles 某项超过 255 字符', ['--principal-roles', `ops,${'r'.repeat(256)}`]],
    ['--principal-roles 某项含控制字符', ['--principal-roles', 'ops,sup\u0001port']],
    ['--upstream 为空', ['--upstream', '   ']],
    ['--upstream 引号未闭合', ['--upstream', "node 'server.js"]],
    ['未知参数', ['--bogus', 'x']],
    ['多余的位置参数', ['stray']],
  ])('%s → ConfigError', (_label, extra) => {
    expect(() => parseCliArgs([...REQUIRED, ...extra], ENV)).toThrow(ConfigError);
  });
});

describe('wantsHelp', () => {
  it('识别 --help 与 -h，即使其他参数缺失或非法', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['--bogus', '--help'])).toBe(true);
    expect(wantsHelp(REQUIRED)).toBe(false);
    expect(wantsHelp([])).toBe(false);
  });

  it('用法说明涵盖全部参数', () => {
    for (const flag of [
      '--upstream',
      '--base-url',
      '--api-key-env',
      '--policy',
      '--principal-id',
      '--principal-type',
      '--principal-roles',
      '--approval-timeout',
      '--upstream-timeout',
      '--resource-from',
      '--agent-model',
      '--help',
    ]) {
      expect(USAGE).toContain(flag);
    }
  });
});

describe('--upstream 按 shell 规则切分', () => {
  it.each([
    ["node server.js --flag 'a b'", ['node', 'server.js', '--flag', 'a b']],
    ['  npx   -y  pkg  ', ['npx', '-y', 'pkg']],
    ['cmd "a b" c', ['cmd', 'a b', 'c']],
    ['cmd "say \\"hi\\"" \'it\'"s"', ['cmd', 'say "hi"', 'its']],
    ['cmd a\\ b', ['cmd', 'a b']],
    ["cmd '' \"\"", ['cmd', '', '']],
    ["cmd '\\n'", ['cmd', '\\n']],
  ])('%j', (input, [command, ...args]) => {
    expect(parseCliArgs([...REQUIRED, ...EXEC, '--upstream', input], ENV).upstream).toEqual({ command, args });
  });

  it.each([
    ['双引号未闭合', 'cmd "abc'],
    ['单引号未闭合', "cmd 'abc"],
    ['空命令', ''],
  ])('%s → ConfigError', (_label, input) => {
    expect(() => parseCliArgs([...REQUIRED, ...EXEC, '--upstream', input], ENV)).toThrow(ConfigError);
  });
});

describe('upstreamEnv', () => {
  it('透传环境变量，但剔除 guard 的 API key 与未定义项', () => {
    expect(
      upstreamEnv({ PATH: '/bin', GITHUB_TOKEN: 'gh', ASTER_GUARD_API_KEY: 'ak', EMPTY: undefined }, 'ASTER_GUARD_API_KEY'),
    ).toEqual({ PATH: '/bin', GITHUB_TOKEN: 'gh' });
  });
});

describe('执行点配置（ADR 0054 §3.1–3.3）', () => {
  const PROXY = [...REQUIRED, '--upstream', 'node server.js'];

  it('configRequiresTenantAndIsolationWithUpstream', () => {
    expect(() => parseCliArgs(PROXY, ENV)).toThrow(/--tenant-id/);
    expect(() => parseCliArgs([...PROXY, '--tenant-id', 't'], ENV)).toThrow(/--isolation/);
    expect(() => parseCliArgs([...PROXY, '--tenant-id', 't', '--isolation', 'vpn'], ENV)).toThrow(/network 或 auth/);
    expect(parseCliArgs([...PROXY, ...EXEC], ENV)).toMatchObject({ tenantId: 'team-1', isolation: 'network' });
  });

  it('执行点参数只用于代理模式', () => {
    expect(() => parseCliArgs([...REQUIRED, '--tenant-id', 't'], ENV)).toThrow(/只用于代理模式/);
    expect(() => parseCliArgs([...REQUIRED, '--tools', 'a'], ENV)).toThrow(/只用于代理模式/);
  });

  it('executorIdDefaultsToHostname 与校验', () => {
    expect(parseCliArgs([...PROXY, ...EXEC], ENV).executorId).toBe(`aster-guard-mcp@${hostname()}`);
    expect(() => parseCliArgs([...PROXY, ...EXEC, '--executor-id', 'x'.repeat(256)], ENV)).toThrow(ConfigError);
  });

  function configFile(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'aster-guard-config-'));
    const path = join(dir, 'guard.json');
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it('配置文件：tools 与 actions；--tools 覆盖文件 tools', () => {
    const path = configFile({ tools: ['send_email'], actions: { send_email: { resourceFrom: 'to', digestArgs: ['body', 'body'] } } });
    const config = parseCliArgs([...PROXY, ...EXEC, '--config', path], ENV);
    expect(config.tools).toEqual(['send_email']);
    expect(config.actions).toEqual({ send_email: { resourceFrom: 'to', digestArgs: ['body'] } });
    expect(() => parseCliArgs([...PROXY, ...EXEC, '--config', path, '--tools', 'other'], ENV)).toThrow(/不在白名单内/);
  });

  it('unknownConfigKeyRejected', () => {
    expect(() => parseCliArgs([...PROXY, ...EXEC, '--config', configFile({ tools: ['a'], skipGuard: ['a'] })], ENV)).toThrow(ConfigError);
    expect(() =>
      parseCliArgs([...PROXY, ...EXEC, '--config', configFile({ actions: { a: { excludeArgs: ['x'] } } })], ENV),
    ).toThrow(ConfigError);
  });

  it('mappingForToolOutsideAllowListRejected', () => {
    const path = configFile({ tools: ['a'], actions: { b: { actionName: 'b' } } });
    expect(() => parseCliArgs([...PROXY, ...EXEC, '--config', path], ENV)).toThrow(/不在白名单内/);
  });
});
