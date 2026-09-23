// Pushes compiled rules into DNR. The ONLY place (with service-worker) that
// touches chrome.declarativeNetRequest. v1 does the simple, race-free thing:
// remove every dynamic rule we own and add the freshly compiled set atomically.

import type { StorageSchema } from './types';
import { compileRuleSets, type CompileResult, type DnrRule } from './compiler';
import { checkLimits, type LimitReport } from './limits';

export interface ApplyResult {
  applied: boolean;
  compile: CompileResult;
  limits: LimitReport;
  ruleCount: number;
  error?: string;
}

/**
 * Drop any regex rule Chrome cannot compile (bad RE2 syntax, unsupported
 * features). Rejecting the whole update over one bad pattern would take every
 * other rule down with it, so we skip the offender and record a warning.
 * Mutates `compiled.warnings` and returns the survivors.
 */
async function filterSupportedRegexRules(compiled: CompileResult): Promise<DnrRule[]> {
  const kept: DnrRule[] = [];
  for (const rule of compiled.rules) {
    const regex = rule.condition.regexFilter;
    if (regex === undefined) {
      kept.push(rule);
      continue;
    }
    const support = await chrome.declarativeNetRequest.isRegexSupported({ regex });
    if (support.isSupported) {
      kept.push(rule);
    } else {
      compiled.warnings.push({
        message: `Regex filter "${regex.slice(0, 40)}…" is not supported (${
          support.reason ?? 'unknown reason'
        }) and was skipped.`,
      });
    }
  }
  return kept;
}

/** Reconcile persistent global rules and ephemeral tab-bound rules. */
export async function applySchema(
  schema: StorageSchema,
  tabAssignments: Readonly<Record<string, number>> = {},
): Promise<ApplyResult> {
  const sets = compileRuleSets(schema, tabAssignments);
  const compiled: CompileResult = {
    rules: [...sets.dynamic.rules, ...sets.session.rules],
    warnings: [...sets.dynamic.warnings, ...sets.session.warnings],
  };
  // Conservatively budget both rulesets together; each browser has its own
  // separate dynamic/session cap and this avoids surprising cross-browser limits.
  const limits = checkLimits(compiled.rules);

  if (!limits.ok) {
    // Fail closed: never leave the previous (now-superseded) rules live while
    // refusing the new set — that would silently diverge storage from DNR.
    await clearAllRules();
    return {
      applied: false,
      compile: compiled,
      limits,
      ruleCount: compiled.rules.length,
      error: limits.violations.map((v) => v.message).join(' '),
    };
  }

  try {
    const dynamic = await filterSupportedRegexRules(sets.dynamic);
    const session = await filterSupportedRegexRules(sets.session);
    compiled.warnings = [...sets.dynamic.warnings, ...sets.session.warnings];
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingSession = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      // Our DnrRule is structurally compatible with chrome's Rule type.
      addRules: dynamic as unknown as chrome.declarativeNetRequest.Rule[],
    });
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existingSession.map((r) => r.id),
      addRules: session as unknown as chrome.declarativeNetRequest.Rule[],
    });
    return {
      applied: true,
      compile: compiled,
      limits,
      ruleCount: dynamic.length + session.length,
    };
  } catch (e) {
    // A rejected update may leave a rule from either ruleset live. Clear both
    // rather than silently applying a superseded scope.
    await clearAllRules();
    return {
      applied: false,
      compile: compiled,
      limits,
      ruleCount: compiled.rules.length,
      error:
        e instanceof Error
          ? `Could not apply rules: ${e.message}`
          : 'Could not apply rules to the network layer.',
    };
  }
}

/** Remove every rule we own from both dynamic and session rulesets. */
export async function clearAllRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const existingSession = await chrome.declarativeNetRequest.getSessionRules();
  if (existing.length > 0)
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
    });
  if (existingSession.length > 0)
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existingSession.map((r) => r.id),
    });
}
