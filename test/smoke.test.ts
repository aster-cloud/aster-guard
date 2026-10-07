import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('包入口', () => {
  it('导出与 package.json 一致的版本号', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
