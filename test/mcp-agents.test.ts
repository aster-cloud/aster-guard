import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authenticate, loadAgents } from '../src/mcp/agents.js';
import { ConfigError } from '../src/mcp/config.js';

// Agent 登记文件（只存 token 的 sha256）与 Bearer 鉴权（ADR 0054 §12 D4）。

const sha = (token: string) => createHash('sha256').update(token).digest('hex');

function agentsFile(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aster-guard-agents-')), 'agents.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('loadAgents', () => {
  it('合法登记文件', () => {
    const agents = loadAgents(agentsFile({ agents: [{ id: 'a', tokenSha256: sha('t-a'), principalRoles: ['ops'] }] }));
    expect(agents).toEqual([{ id: 'a', tokenSha256: sha('t-a'), principalRoles: ['ops'] }]);
  });

  it('duplicateTokenHashIsRejected', () => {
    const path = agentsFile({ agents: [{ id: 'a', tokenSha256: sha('t') }, { id: 'b', tokenSha256: sha('t') }] });
    expect(() => loadAgents(path)).toThrow(/tokenSha256 重复/);
    const dupId = agentsFile({ agents: [{ id: 'a', tokenSha256: sha('t1') }, { id: 'a', tokenSha256: sha('t2') }] });
    expect(() => loadAgents(dupId)).toThrow(/id 重复/);
  });

  it('uppercaseHashIsRejected', () => {
    expect(() => loadAgents(agentsFile({ agents: [{ id: 'a', tokenSha256: sha('t').toUpperCase() }] }))).toThrow(/小写十六进制/);
  });

  it('空表、未知键、控制字符、非 JSON 均为 ConfigError', () => {
    expect(() => loadAgents(agentsFile({ agents: [] }))).toThrow(ConfigError);
    expect(() => loadAgents(agentsFile({ agents: [{ id: 'a', tokenSha256: sha('t'), token: 'x' }] }))).toThrow(ConfigError);
    expect(() => loadAgents(agentsFile({ agents: [{ id: 'a\u0007', tokenSha256: sha('t') }] }))).toThrow(/控制字符/);
    expect(() => loadAgents(agentsFile('{not json'))).toThrow(/JSON 无效/);
    expect(() => loadAgents('/nonexistent/agents.json')).toThrow(ConfigError);
  });
});

describe('authenticate', () => {
  const agents = [
    { id: 'a', tokenSha256: sha('token-a') },
    { id: 'b', tokenSha256: sha('token-b'), principalId: 'agent-b' },
  ];

  it('authenticateMatchesOnlyRegisteredToken', () => {
    expect(authenticate('Bearer token-a', agents)?.id).toBe('a');
    expect(authenticate('bearer token-b', agents)?.id).toBe('b');
    expect(authenticate('Bearer token-c', agents)).toBeUndefined();
    expect(authenticate(`Bearer ${sha('token-a')}`, agents)).toBeUndefined();
  });

  it('missingOrNonBearerHeaderIsUndefined', () => {
    expect(authenticate(undefined, agents)).toBeUndefined();
    expect(authenticate('', agents)).toBeUndefined();
    expect(authenticate('Basic token-a', agents)).toBeUndefined();
    expect(authenticate('Bearer ', agents)).toBeUndefined();
    expect(authenticate('Bearer token-a extra', agents)).toBeUndefined();
  });
});
