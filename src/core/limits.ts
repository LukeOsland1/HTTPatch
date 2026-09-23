// Rule-count and regex budgeting. Pure — validates compiled rules before apply.

import type { DnrRule } from './compiler';
import { MAX_REGEX_PATTERN_BYTES, MAX_REGEX_RULES, MAX_UNSAFE_DYNAMIC_RULES } from './constants';

export interface LimitViolation {
  code: 'too-many-rules' | 'too-many-regex' | 'regex-too-long';
  message: string;
}

export interface LimitReport {
  ok: boolean;
  ruleCount: number;
  regexRuleCount: number;
  violations: LimitViolation[];
}

const byteLength = (s: string): number =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;

/** Validate that compiled rules fit within DNR's dynamic-rule budgets. */
export function checkLimits(rules: DnrRule[]): LimitReport {
  const violations: LimitViolation[] = [];
  const regexRules = rules.filter((r) => r.condition.regexFilter !== undefined);

  if (rules.length > MAX_UNSAFE_DYNAMIC_RULES) {
    violations.push({
      code: 'too-many-rules',
      message: `${rules.length} rules exceed the ${MAX_UNSAFE_DYNAMIC_RULES} unsafe dynamic-rule limit. Reduce headers, profiles, or URL filters.`,
    });
  }

  if (regexRules.length > MAX_REGEX_RULES) {
    violations.push({
      code: 'too-many-regex',
      message: `${regexRules.length} regex rules exceed the ${MAX_REGEX_RULES} regex-rule limit.`,
    });
  }

  for (const r of regexRules) {
    const pattern = r.condition.regexFilter!;
    if (byteLength(pattern) > MAX_REGEX_PATTERN_BYTES) {
      violations.push({
        code: 'regex-too-long',
        message: `Regex pattern "${pattern.slice(0, 40)}…" exceeds ${MAX_REGEX_PATTERN_BYTES} bytes.`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    ruleCount: rules.length,
    regexRuleCount: regexRules.length,
    violations,
  };
}
