import type { UrlFilter } from './types';

/** DNR domain anchor for the current web page, including its subdomains. */
export function siteScopeFromUrl(url: string): { hostname: string; filter: UrlFilter } | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return {
      hostname: parsed.hostname,
      filter: { kind: 'wildcard', mode: 'include', pattern: `||${parsed.hostname}^` },
    };
  } catch {
    return null;
  }
}
