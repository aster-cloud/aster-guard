import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalize, hashAction, JcsError, jcsSha256, parseStrictJson } from '../src/hash/jcs.js';

// jcs-sha256/v1 与 aster-api 逐字节对齐（ADR 0054 §4）：共享向量 + TS 侧独有的拒绝规则。

const VECTORS_PATH = new URL('./fixtures/jcs-sha256-v1-vectors.json', import.meta.url);
const VECTORS = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Array<{
  name: string;
  input: string;
  canonical?: string;
  sha256?: string;
  error?: string;
}>;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof JcsError ? e.code : `non-jcs:${String(e)}`;
  }
}

describe('jcs-sha256/v1', () => {
  it('everyVectorMatchesAsterApi：48 条共享向量', () => {
    expect(VECTORS).toHaveLength(48);
    for (const v of VECTORS) {
      if (v.error) {
        expect(codeOf(() => jcsSha256(parseStrictJson(v.input))), v.name).toBe(v.error);
      } else {
        const value = parseStrictJson(v.input);
        expect(canonicalize(value), v.name).toBe(v.canonical);
        expect(jcsSha256(value), v.name).toBe(v.sha256);
      }
    }
  });

  it('vectorFileIsByteIdenticalToAsterApi', () => {
    const digest = createHash('sha256').update(readFileSync(VECTORS_PATH)).digest('hex');
    expect(digest, '向量文件与 aster-api src/test/resources/guard/jcs-sha256-v1-vectors.json 不一致：两仓必须同改并升 /v2').toBe(
      'cfef20a2761165d09b1af4cbdbc74e65cf7778d9d26a90c1226acb90f52c998e',
    );
  });

  it('rejectsValuesJsonStringifyWouldRewrite', () => {
    expect(codeOf(() => canonicalize({ n: Number.NaN }))).toBe('unsafe_integer');
    expect(codeOf(() => canonicalize({ n: Number.POSITIVE_INFINITY }))).toBe('unsafe_integer');
    expect(codeOf(() => canonicalize({ a: undefined }))).toBe('invalid_value');
    expect(codeOf(() => canonicalize([undefined]))).toBe('invalid_value');
    expect(codeOf(() => canonicalize({ f: () => 1 }))).toBe('invalid_value');
    expect(codeOf(() => canonicalize({ b: 1n }))).toBe('invalid_value');
    expect(codeOf(() => canonicalize({ s: Symbol('x') }))).toBe('invalid_value');
    expect(codeOf(() => canonicalize({ d: new Date(0) }))).toBe('invalid_value');
    expect(codeOf(() => canonicalize({ big: 2 ** 53 }))).toBe('unsafe_integer');
    expect(codeOf(() => canonicalize({ s: '\uD800' }))).toBe('invalid_string');
    expect(canonicalize({ z: -0 })).toBe('{"z":0}');
    expect(canonicalize({ c: '\u001f' })).toBe('{"c":"\\u001f"}');
  });

  it('numberTokenRulesMatchServer：小数按 double，整数超过 2^53−1 拒绝', () => {
    expect(canonicalize(parseStrictJson('{"n":9007199254740991.4}'))).toBe('{"n":9007199254740991}');
    expect(codeOf(() => canonicalize(parseStrictJson('{"n":9007199254740993}')))).toBe('unsafe_integer');
  });

  it('parseStrictJson 拒绝任一层重复键', () => {
    expect(codeOf(() => parseStrictJson('{"a":{"b":1,"b":2}}'))).toBe('duplicate_key');
    expect(() => parseStrictJson('{"a":1} x')).toThrow(SyntaxError);
  });

  it('nullMissingAndEmptyStringHashDiffer（ADR 0054 §3.2 cc 三例）', () => {
    const base = { principal: { id: 'p' }, action: { name: 'send_email' } };
    const h = [
      hashAction({ ...base, context: { to: 'a@x', cc: null } }),
      hashAction({ ...base, context: { to: 'a@x' } }),
      hashAction({ ...base, context: { to: 'a@x', cc: '' } }),
    ];
    expect(new Set(h).size).toBe(3);
  });
});
