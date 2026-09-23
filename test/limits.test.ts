import { describe, it, expect } from 'vitest';
import { checkLimits } from '../src/core/limits';
import type { DnrRule } from '../src/core/compiler';
import { MAX_UNSAFE_DYNAMIC_RULES } from '../src/core/constants';

function rule(id: number, regexFilter?: string): DnrRule {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'X', operation: 'set', value: '1' }],
    },
    condition: { resourceTypes: ['xmlhttprequest'], ...(regexFilter ? { regexFilter } : {}) },
  };
}

describe('checkLimits', () => {
  it('passes for a small rule set', () => {
    const report = checkLimits([rule(1), rule(2)]);
    expect(report.ok).toBe(true);
    expect(report.ruleCount).toBe(2);
  });

  it('flags exceeding the unsafe dynamic-rule cap', () => {
    const rules = Array.from({ length: MAX_UNSAFE_DYNAMIC_RULES + 1 }, (_, i) => rule(i + 1));
    const report = checkLimits(rules);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.code === 'too-many-rules')).toBe(true);
  });

  it('flags an oversized regex pattern', () => {
    const big = 'a'.repeat(2049);
    const report = checkLimits([rule(1, big)]);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.code === 'regex-too-long')).toBe(true);
  });
});
