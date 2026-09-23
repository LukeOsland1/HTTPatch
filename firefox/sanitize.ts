// Firefox-only DNR normalization, kept pure (no browser.*) so it's unit-tested.
//
// Chrome's declarativeNetRequest resource-type enum is a superset of Firefox's.
// `webtransport` and `webbundle` are Chrome-only; if any rule carries them,
// Firefox rejects the ENTIRE updateDynamicRules batch ("Invalid enumeration
// value"). The shared compiler emits the full Chrome list when a profile selects
// no resource types, so we narrow those to Firefox's supported set here — a
// Firefox concern that must never leak into the shared compiler.
import type { ResourceType } from '@/core/types';
import type { CompileWarning, DnrRule } from '@/core/compiler';

export const FIREFOX_UNSUPPORTED_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set([
  'webtransport',
  'webbundle',
]);

/**
 * Drop Firefox-unsupported resource types from each rule. Rules left with an
 * empty resource-type list (a profile that selected ONLY unsupported types) are
 * skipped with a warning, because an empty `resourceTypes` array is itself
 * rejected and would take the whole batch down.
 */
export function sanitizeForFirefox(rules: DnrRule[], warnings: CompileWarning[]): DnrRule[] {
  const out: DnrRule[] = [];
  for (const rule of rules) {
    const kept = rule.condition.resourceTypes.filter(
      (t) => !FIREFOX_UNSUPPORTED_RESOURCE_TYPES.has(t),
    );
    if (kept.length === rule.condition.resourceTypes.length) {
      out.push(rule); // nothing to strip
    } else if (kept.length > 0) {
      out.push({ ...rule, condition: { ...rule.condition, resourceTypes: kept } });
    } else {
      warnings.push({
        message:
          'A rule targeted only resource types Firefox does not support (webtransport/webbundle) and was skipped.',
      });
    }
  }
  return out;
}
