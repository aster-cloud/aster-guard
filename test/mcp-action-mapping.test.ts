import { describe, expect, it } from 'vitest';
import { hashAction, jcsSha256, JcsError } from '../src/hash/jcs.js';
import { buildToolAction, canonicalArgs, envelopeOf, resourceIdText } from '../src/mcp/action-mapping.js';

// 「同一对象」不变式与 digestArgs（ADR 0054 §3.2）。

const principal = { id: 'agent-42', type: 'agent' };
const MAPPING = { resourceFrom: 'to', digestArgs: ['body'] };

function act(args: Record<string, unknown>, mapping = MAPPING) {
  return buildToolAction({ toolName: 'send_email', args: canonicalArgs(args), mapping, principal });
}

describe('canonicalArgs / buildToolAction', () => {
  it('sameReferenceWithoutDigest', () => {
    const args = canonicalArgs({ b: 1, a: { d: null, c: [2, 1] } });
    const action = buildToolAction({ toolName: 't', args, principal });
    expect(action.context).toBe(args);
  });

  it('nullsPreservedAndKeysSorted', () => {
    const args = canonicalArgs({ z: null, a: { y: null, b: 1 } });
    expect(JSON.stringify(args)).toBe('{"a":{"b":1,"y":null},"z":null}');
    expect(() => canonicalArgs({ n: Number.NaN })).toThrow(JcsError);
  });

  it('digestReplacesOnlyPresentKeys：§3.2 表 6 行两两不等', () => {
    const rows = [
      act({ to: 'a@x', body: 'hi', cc: null }),
      act({ to: 'a@x', body: 'hi' }),
      act({ to: 'a@x', body: 'hi', cc: '' }),
      act({ to: 'a@x', body: 'hi!', cc: null }),
      act({ to: 'a@x', body: null }),
      act({ to: 'a@x' }),
    ];
    expect(rows[0].context).toEqual({ body: { $sha256: jcsSha256('hi') }, cc: null, to: 'a@x' });
    expect(rows[4].context).toEqual({ body: { $sha256: jcsSha256(null) }, to: 'a@x' });
    expect(rows[5].context).toEqual({ to: 'a@x' });
    expect(new Set(rows.map(hashAction)).size).toBe(6);
  });

  it('digest 时 context 是副本，转发参数保留原值', () => {
    const args = canonicalArgs({ to: 'a@x', body: 'hi' });
    const action = buildToolAction({ toolName: 'send_email', args, mapping: MAPPING, principal });
    expect(action.context).not.toBe(args);
    expect(args.body).toBe('hi');
  });

  it('principalArgIsJustContext', () => {
    const action = act({ to: 'a@x', principal: { id: 'root' } });
    expect(action.principal).toEqual(principal);
    expect((action.context as Record<string, unknown>).principal).toEqual({ id: 'root' });
  });

  it('resourceFromPerTool 与 actionName；null / 缺失不带 resource', () => {
    expect(act({ to: 'a@x' }).resource).toEqual({ type: 'arg', id: 'a@x' });
    expect(act({ to: null }).resource).toBeUndefined();
    expect('resource' in act({})).toBe(false);
    expect(buildToolAction({ toolName: 't', args: {}, mapping: { actionName: 'n' }, principal }).action).toEqual({ name: 'n' });
    expect(buildToolAction({ toolName: 't', args: { id: 7 }, defaultResourceFrom: 'id', principal }).resource).toEqual({
      type: 'arg',
      id: '7',
    });
    expect(resourceIdText('x'.repeat(256))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resourceIdText({ a: 1 })).toBe('{"a":1}');
  });

  it('envelopeOf 去掉 context，其余与 action 相同', () => {
    const action = act({ to: 'a@x' });
    const envelope = envelopeOf(action);
    expect('context' in envelope).toBe(false);
    expect(hashAction({ ...envelope, context: action.context })).toBe(hashAction(action));
  });
});
