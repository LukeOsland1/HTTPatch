import { describe, it, expect } from 'vitest';
import { sanitizeForFirefox } from '../firefox/sanitize';
import type { CompileWarning, DnrRule } from '../src/core/compiler';
import type { ResourceType } from '../src/core/types';

function rule(resourceTypes: ResourceType[]): DnrRule {
  return {
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'X-Test', operation: 'set', value: 'v' }],
    },
    condition: { resourceTypes },
  };
}

describe('sanitizeForFirefox', () => {
  it('strips Chrome-only resource types (webtransport/webbundle) that Firefox rejects', () => {
    const warnings: CompileWarning[] = [];
    const out = sanitizeForFirefox(
      [rule(['main_frame', 'webtransport', 'xmlhttprequest', 'webbundle'])],
      warnings,
    );
    expect(out).toHaveLength(1);
    expect(out[0].condition.resourceTypes).toEqual(['main_frame', 'xmlhttprequest']);
    expect(warnings).toEqual([]);
  });

  it('leaves rules with only supported types untouched (same reference)', () => {
    const warnings: CompileWarning[] = [];
    const r = rule(['main_frame', 'script', 'xmlhttprequest']);
    const out = sanitizeForFirefox([r], warnings);
    expect(out[0]).toBe(r); // no clone when nothing is stripped
    expect(warnings).toEqual([]);
  });

  it('skips (with a warning) a rule left with no supported types', () => {
    const warnings: CompileWarning[] = [];
    const out = sanitizeForFirefox([rule(['webtransport', 'webbundle'])], warnings);
    expect(out).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/does not support/i);
  });
});
