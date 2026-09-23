// Firefox variant of src/core/apply.ts. Same reconcile-everything strategy, but
// against the promise-based `browser.declarativeNetRequest` (via
// webextension-polyfill). Firefox supports the DNR `modifyHeaders` action from
// v128, which is why the Firefox manifest sets strict_min_version 128.0.
//
// If a future Firefox DNR gap surfaces (e.g. an unsupported header op), the
// fallback lives HERE — a Firefox-only webRequest path — so the Chrome build is
// never touched.

import browser from 'webextension-polyfill';
import type { StorageSchema } from '@/core/types';
import { compileRuleSets, type CompileResult, type DnrRule } from '@/core/compiler';
import { checkLimits, type LimitReport } from '@/core/limits';
import { sanitizeForFirefox } from './sanitize';

export interface ApplyResult {
  applied: boolean;
  compile: CompileResult;
  limits: LimitReport;
  ruleCount: number;
  error?: string;
}

type UpdateRuleOptions = Parameters<typeof browser.declarativeNetRequest.updateDynamicRules>[0];
type AddRules = NonNullable<UpdateRuleOptions['addRules']>;

/**
 * Drop any regex rule Firefox cannot compile (bad RE2 syntax, unsupported
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
    const support = await browser.declarativeNetRequest.isRegexSupported({ regex });
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
    const dynamic = sanitizeForFirefox(
      await filterSupportedRegexRules(sets.dynamic),
      sets.dynamic.warnings,
    );
    const session = sanitizeForFirefox(
      await filterSupportedRegexRules(sets.session),
      sets.session.warnings,
    );
    compiled.warnings = [...sets.dynamic.warnings, ...sets.session.warnings];
    const existing = await browser.declarativeNetRequest.getDynamicRules();
    const existingSession = await browser.declarativeNetRequest.getSessionRules();
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      // Our DnrRule is structurally compatible with the DNR Rule type.
      addRules: dynamic as unknown as AddRules,
    });
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existingSession.map((r) => r.id),
      addRules: session as unknown as AddRules,
    });
    return {
      applied: true,
      compile: compiled,
      limits,
      ruleCount: dynamic.length + session.length,
    };
  } catch (e) {
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

/** Remove every global and tab-bound rule we own. */
export async function clearAllRules(): Promise<void> {
  const existing = await browser.declarativeNetRequest.getDynamicRules();
  const existingSession = await browser.declarativeNetRequest.getSessionRules();
  if (existing.length > 0)
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
    });
  if (existingSession.length > 0)
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existingSession.map((r) => r.id),
    });
}
