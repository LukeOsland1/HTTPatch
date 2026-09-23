// Pure, browser-free analysis of a to-be-imported profile set. Used to render
// an import preview/confirmation before profiles are committed to storage, and
// to warn on export when a profile carries secrets. No chrome.* imports, so it
// stays unit-testable alongside the rest of core/.
//
// Addresses security-scan findings L-01 (imported JSON can silently weaken
// security-relevant response headers with no preview) and L-02 (header values
// may be secrets, stored and exported in plaintext).

import type { HeaderRule, Profile } from './types';

/**
 * Response headers whose modification can weaken the security posture of a site
 * the user visits (relax CSP/HSTS/framing/CORS). A maliciously-crafted profile
 * JSON, if imported by a socially-engineered user, could strip or loosen these
 * across `<all_urls>` — no code execution, but a real semantic risk we surface
 * in the import preview so the user sees it before confirming. (Finding L-01.)
 *
 * Names are lowercased and matched case-insensitively.
 */
export const SECURITY_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  // CORS response headers — loosening these enables cross-origin data theft.
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
]);

/**
 * Header names that commonly carry a secret in their value. Used to warn the
 * user, before an export, that the JSON file will contain those values in
 * plaintext. (Finding L-02.) Lowercased; matched case-insensitively.
 */
export const SENSITIVE_VALUE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-amz-security-token',
]);

export interface HeaderOpSummary {
  target: HeaderRule['target'];
  operation: HeaderRule['operation'];
  name: string;
  /** True if this rule modifies a security-relevant response header. */
  securitySensitive: boolean;
}

export interface ProfileImportSummary {
  name: string;
  enabled: boolean;
  headerCount: number;
  ops: HeaderOpSummary[];
  /** URL filter patterns (target URLs); empty means the profile applies to all URLs. */
  urlPatterns: string[];
}

export interface SecurityHeaderFlag {
  profileName: string;
  target: HeaderRule['target'];
  operation: HeaderRule['operation'];
  headerName: string;
}

export interface ImportSummary {
  profileCount: number;
  totalHeaders: number;
  profiles: ProfileImportSummary[];
  /** Rules that would modify a security-relevant response header (see L-01). */
  securityFlags: SecurityHeaderFlag[];
  /** True if any header value looks like it carries a secret (see L-02). */
  hasSensitiveValues: boolean;
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

/** A rule that modifies a security-relevant response header. See L-01. */
export function isSecuritySensitive(rule: HeaderRule): boolean {
  return rule.target === 'response' && SECURITY_RESPONSE_HEADERS.has(norm(rule.name));
}

/** A rule whose value likely carries a secret (auth token / cookie / API key). See L-02. */
export function carriesSensitiveValue(rule: HeaderRule): boolean {
  return (
    rule.operation !== 'remove' &&
    (rule.value ?? '').length > 0 &&
    SENSITIVE_VALUE_HEADERS.has(norm(rule.name))
  );
}

/** True if any profile contains a header that would be exported with a secret value. */
export function profilesHaveSensitiveValues(profiles: Profile[]): boolean {
  return profiles.some((p) => p.headers.some(carriesSensitiveValue));
}

/** Build a human-readable summary of a pending import for the confirmation preview. */
export function summarizeImport(profiles: Profile[]): ImportSummary {
  const securityFlags: SecurityHeaderFlag[] = [];
  let totalHeaders = 0;
  let hasSensitiveValues = false;

  const summaries: ProfileImportSummary[] = profiles.map((p) => {
    const ops: HeaderOpSummary[] = p.headers.map((h) => {
      const securitySensitive = isSecuritySensitive(h);
      if (securitySensitive) {
        securityFlags.push({
          profileName: p.name,
          target: h.target,
          operation: h.operation,
          headerName: h.name,
        });
      }
      if (carriesSensitiveValue(h)) hasSensitiveValues = true;
      return { target: h.target, operation: h.operation, name: h.name, securitySensitive };
    });
    totalHeaders += p.headers.length;
    return {
      name: p.name,
      enabled: p.enabled,
      headerCount: p.headers.length,
      ops,
      urlPatterns: p.filters.urlFilters.map((f) => f.pattern),
    };
  });

  return {
    profileCount: profiles.length,
    totalHeaders,
    profiles: summaries,
    securityFlags,
    hasSensitiveValues,
  };
}
