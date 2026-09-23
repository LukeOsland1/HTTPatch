// The heart of HTTPatch: a PURE function that compiles the stored profiles
// into declarativeNetRequest dynamic rules. No chrome.* here — fully testable.

import type { HeaderRule, Profile, ResourceType, StorageSchema, UrlFilter } from './types';
import { ALL_RESOURCE_TYPES, APPEND_ALLOWLIST } from './constants';
import { isBareDomain } from './url-match';
import { cookieRuleError } from './common-headers';

/** Structural mirror of chrome.declarativeNetRequest.ModifyHeaderInfo. */
export interface ModifyHeaderInfo {
  header: string;
  operation: 'set' | 'append' | 'remove';
  value?: string;
}

/** Structural mirror of the DNR rule shape we produce. Cast to chrome's type at the API boundary. */
export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    requestHeaders?: ModifyHeaderInfo[];
    responseHeaders?: ModifyHeaderInfo[];
  };
  condition: DnrCondition;
}

export interface DnrCondition {
  urlFilter?: string;
  regexFilter?: string;
  resourceTypes: ResourceType[];
  excludedRequestDomains?: string[];
  /** Session rules only. */
  tabIds?: number[];
}

export interface CompileWarning {
  profileId?: string;
  headerId?: string;
  message: string;
}

export interface CompileResult {
  rules: DnrRule[];
  warnings: CompileWarning[];
}

/**
 * Builds one or more DNR conditions for a profile's filters. DNR allows only a
 * single positive URL matcher per rule and urlFilter/regexFilter are mutually
 * exclusive, so multiple include patterns fan out into multiple conditions.
 */
export function buildConditions(
  filters: Profile['filters'],
  warnings: CompileWarning[],
  profileId: string,
): DnrCondition[] {
  const resourceTypes =
    filters.resourceTypes.length > 0 ? [...filters.resourceTypes] : [...ALL_RESOURCE_TYPES];

  const includes = filters.urlFilters
    .filter((f) => f.mode === 'include')
    .filter((f) => {
      if (f.pattern.trim() === '') {
        warnings.push({
          profileId,
          message: 'Include URL filter with an empty pattern was skipped.',
        });
        return false;
      }
      return true;
    });
  const excludes = filters.urlFilters.filter((f) => f.mode === 'exclude');

  const excludedRequestDomains: string[] = [];
  for (const ex of excludes) {
    if (ex.kind === 'wildcard' && isBareDomain(ex.pattern)) {
      excludedRequestDomains.push(ex.pattern.toLowerCase());
    } else {
      warnings.push({
        profileId,
        message: `Exclude filter "${ex.pattern}" is not a bare domain and is unsupported in v1; it was ignored.`,
      });
    }
  }

  const base: Omit<DnrCondition, 'urlFilter' | 'regexFilter'> = { resourceTypes };
  if (excludedRequestDomains.length > 0) base.excludedRequestDomains = excludedRequestDomains;

  if (includes.length === 0) {
    // An unfinished include must not silently broaden a scoped rule to every site.
    if (filters.urlFilters.some((f) => f.mode === 'include')) return [];
    return [{ ...base }];
  }

  return includes.map((inc: UrlFilter) => {
    const cond: DnrCondition = { ...base };
    if (inc.kind === 'regex') cond.regexFilter = inc.pattern.trim();
    else cond.urlFilter = inc.pattern.trim();
    return cond;
  });
}

function buildHeaderEntry(
  h: HeaderRule,
  warnings: CompileWarning[],
  profileId: string,
): ModifyHeaderInfo | null {
  const headerName = h.name.trim();
  if (!headerName) {
    warnings.push({ profileId, headerId: h.id, message: 'Header with an empty name was skipped.' });
    return null;
  }

  if (h.editor === 'request-cookie' || h.editor === 'response-cookie') {
    const response = h.editor === 'response-cookie';
    if (
      h.target !== (response ? 'response' : 'request') ||
      h.operation !== 'append' ||
      headerName.toLowerCase() !== (response ? 'set-cookie' : 'cookie')
    ) {
      warnings.push({ profileId, headerId: h.id, message: 'Cookie rule has invalid settings.' });
      return null;
    }
    const error = cookieRuleError(h.value ?? '', response);
    if (error) {
      warnings.push({ profileId, headerId: h.id, message: `${error} Cookie rule skipped.` });
      return null;
    }
  }
  if (h.editor === 'csp') {
    if (
      h.target !== 'response' ||
      h.operation !== 'set' ||
      headerName.toLowerCase() !== 'content-security-policy'
    ) {
      warnings.push({ profileId, headerId: h.id, message: 'CSP rule has invalid settings.' });
      return null;
    }
    if (!h.value?.trim() || /[\r\n]/.test(h.value)) {
      warnings.push({
        profileId,
        headerId: h.id,
        message: 'Enter a single-line CSP policy. Rule skipped.',
      });
      return null;
    }
  }

  if (h.operation === 'remove') {
    return { header: headerName, operation: 'remove' };
  }

  if (
    h.operation === 'append' &&
    h.target === 'request' &&
    !APPEND_ALLOWLIST.has(headerName.toLowerCase())
  ) {
    warnings.push({
      profileId,
      headerId: h.id,
      message: `Append is not allowed on request header "${headerName}"; use Set instead. Rule skipped.`,
    });
    return null;
  }

  if (h.operation === 'append' && (h.value === undefined || h.value === null)) {
    warnings.push({
      profileId,
      headerId: h.id,
      message: `Append rule for "${headerName}" has no value and was skipped.`,
    });
    return null;
  }

  return { header: headerName, operation: h.operation, value: h.value ?? '' };
}

/**
 * Compile the full storage schema into DNR dynamic rules.
 * - paused => no rules at all (storage untouched)
 * - later profiles get higher priority so they win header conflicts
 * - N enabled headers x M include patterns => N*M rules
 */
function compileForRuleSet(
  schema: StorageSchema,
  kind: 'dynamic' | 'session',
  tabAssignments: Readonly<Record<string, number>>,
): CompileResult {
  const warnings: CompileWarning[] = [];
  const rules: DnrRule[] = [];

  if (schema.settings.paused) {
    return { rules, warnings };
  }

  let ruleId = 1;
  let priority = 1;

  for (const profile of schema.profiles) {
    if (!profile.enabled) continue;
    if ((kind === 'session') !== (profile.tabOnly === true)) {
      priority++;
      continue;
    }
    const assignedTab = profile.tabOnly ? tabAssignments[profile.id] : undefined;
    if (profile.tabOnly && !Number.isSafeInteger(assignedTab)) {
      priority++;
      continue;
    }

    const conditions = buildConditions(profile.filters, warnings, profile.id);

    for (const h of profile.headers) {
      if (!h.enabled) continue;

      const entry = buildHeaderEntry(h, warnings, profile.id);
      if (!entry) continue;

      const action: DnrRule['action'] = { type: 'modifyHeaders' };
      if (h.target === 'request') action.requestHeaders = [entry];
      else action.responseHeaders = [entry];

      for (const condition of conditions) {
        rules.push({
          id: ruleId++,
          priority,
          action,
          condition:
            assignedTab === undefined ? condition : { ...condition, tabIds: [assignedTab] },
        });
      }
    }

    // Each profile occupies its own priority band; later profiles win conflicts.
    priority++;
  }

  return { rules, warnings };
}

export function compile(schema: StorageSchema): CompileResult {
  return compileForRuleSet(schema, 'dynamic', {});
}

/** Separate persistent global rules from tab-bound session rules. */
export function compileRuleSets(
  schema: StorageSchema,
  tabAssignments: Readonly<Record<string, number>>,
): { dynamic: CompileResult; session: CompileResult } {
  return {
    dynamic: compileForRuleSet(schema, 'dynamic', tabAssignments),
    session: compileForRuleSet(schema, 'session', tabAssignments),
  };
}
