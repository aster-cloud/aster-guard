// jcs-sha256/v1（ADR 0040 §12 D2，ADR 0054 §4）：RFC 8785 JCS 规范化后取 SHA-256。
// 与 aster-api JcsCanonicalizer 逐字节一致，共享向量 test/fixtures/jcs-sha256-v1-vectors.json 守住这一点。
// 拒绝而不是改写：JSON.stringify 会把 NaN 写成 null、丢掉 undefined 键——若不在发送前拒绝，服务端哈希的是另一个文档，
// consume 必 409（永远执行不了）。
import { createHash } from 'node:crypto';
import type { GuardAction } from '../types.js';

/** 规范化失败的原因：前三种与 aster-api 共享向量一致，`invalid_value` 为 TS 侧独有（JS 值无法表示为 JSON）。 */
export type JcsErrorCode = 'unsafe_integer' | 'invalid_string' | 'duplicate_key' | 'invalid_value';

export class JcsError extends Error {
  readonly code: JcsErrorCode;

  constructor(code: JcsErrorCode, message: string) {
    super(message);
    this.name = 'JcsError';
    this.code = code;
  }
}

/** 返回 JCS 文本；值无法规范化时抛 {@link JcsError}。 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value);
    case 'string':
      return canonicalString(value);
    case 'object':
      return Array.isArray(value) ? `[${value.map(canonicalize).join(',')}]` : canonicalObject(value);
    default:
      throw new JcsError('invalid_value', `无法规范化的值类型：${typeof value}`);
  }
}

/** jcs-sha256/v1：UTF-8 编码的 JCS 文本的 SHA-256，小写 hex。 */
export function jcsSha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** Guard Action 的哈希（= jcsSha256(action)）；与 `POST /decisions` 请求体里的 action 是同一个对象。 */
export function hashAction(action: GuardAction): string {
  return jcsSha256(action);
}

/** 数字：非有限数与 |x| > 2^53−1 一律 `unsafe_integer`（大数须以字符串发送）；`-0` 输出 `0`。 */
function canonicalNumber(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new JcsError('unsafe_integer', `数字超出 jcs-sha256/v1 可表示范围：${n}`);
  }
  // ECMAScript Number::toString 即 RFC 8785 §3.2.2.3 的输出形态；String(-0) 为 "0"。
  return String(n);
}

/** 字符串：孤立代理项拒绝；转义规则与 JSON.stringify 相同（RFC 8785 §3.2.2.2）。 */
function canonicalString(s: string): string {
  if (!s.isWellFormed()) {
    throw new JcsError('invalid_string', '字符串含孤立代理项');
  }
  return JSON.stringify(s);
}

/** 纯对象（原型为 Object.prototype 或 null）：键按 UTF-16 码元序；值为 undefined 拒绝（JSON.stringify 会丢键）。 */
function canonicalObject(value: object): string {
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new JcsError('invalid_value', `不是纯对象：${Object.prototype.toString.call(value)}`);
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => {
      const member = record[key];
      if (member === undefined) {
        throw new JcsError('invalid_value', `键 ${key} 的值为 undefined`);
      }
      return `${canonicalString(key)}:${canonicalize(member)}`;
    });
  return `{${members.join(',')}}`;
}

/**
 * `JSON.parse` 语义的严格解析：任一层对象出现重复键抛 `duplicate_key`。仅供共享向量测试与工具侧票据解析，
 * 不在热路径上使用。数字 token 交给 `Number()`（小数按 double，与服务端同口径），字符串 token 交给 `JSON.parse` 解码。
 */
export function parseStrictJson(text: string): unknown {
  const parser = new StrictParser(text);
  const value = parser.value();
  parser.end();
  return value;
}

class StrictParser {
  private i = 0;

  constructor(private readonly text: string) {}

  value(): unknown {
    this.ws();
    const c = this.text[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (c === 't') return this.literal('true', true);
    if (c === 'f') return this.literal('false', false);
    if (c === 'n') return this.literal('null', null);
    return this.number();
  }

  end(): void {
    this.ws();
    if (this.i !== this.text.length) throw new SyntaxError(`JSON 末尾有多余内容（位置 ${this.i}）`);
  }

  private object(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.i++;
    this.ws();
    if (this.text[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const key = this.string();
      if (seen.has(key)) throw new JcsError('duplicate_key', `重复键：${key}`);
      seen.add(key);
      this.expect(':');
      Object.defineProperty(out, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
      this.ws();
      if (this.text[this.i] === ',') {
        this.i++;
        continue;
      }
      this.expect('}');
      return out;
    }
  }

  private array(): unknown[] {
    const out: unknown[] = [];
    this.i++;
    this.ws();
    if (this.text[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      if (this.text[this.i] === ',') {
        this.i++;
        continue;
      }
      this.expect(']');
      return out;
    }
  }

  private string(): string {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(this.text.slice(this.i));
    if (!m) throw new SyntaxError(`非法字符串（位置 ${this.i}）`);
    this.i += m[0].length;
    return JSON.parse(m[0]) as string;
  }

  private number(): number {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.i));
    if (!m) throw new SyntaxError(`非法 JSON 值（位置 ${this.i}）`);
    this.i += m[0].length;
    return Number(m[0]);
  }

  private literal<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.i)) throw new SyntaxError(`非法 JSON 值（位置 ${this.i}）`);
    this.i += word.length;
    return value;
  }

  private expect(c: string): void {
    this.ws();
    if (this.text[this.i] !== c) throw new SyntaxError(`期望 ${c}（位置 ${this.i}）`);
    this.i++;
  }

  private ws(): void {
    while (this.i < this.text.length && ' \t\n\r'.includes(this.text[this.i])) this.i++;
  }
}
