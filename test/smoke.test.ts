import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('包入口（源码）', () => {
  it('VERSION 与 package.json 的 version 一致', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
