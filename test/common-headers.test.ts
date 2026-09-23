import { describe, expect, it } from 'vitest';
import {
  cookieRuleError,
  formatCookieHeader,
  parseCookieHeader,
  setCspDirective,
} from '../src/core/common-headers';
import { exportProfiles, importProfiles } from '../src/core/importexport';
import { header, profile } from './helpers';

describe('cookie helpers', () => {
  it('round-trips a response cookie with attributes and equals in its value', () => {
    const parts = parseCookieHeader('session=a=b; Path=/; SameSite=Lax', true);
    expect(parts).toEqual({ name: 'session', value: 'a=b', attributes: 'Path=/; SameSite=Lax' });
    expect(formatCookieHeader(parts, true)).toBe('session=a=b; Path=/; SameSite=Lax');
  });

  it('rejects incomplete or malformed cookie rules', () => {
    expect(cookieRuleError('', false)).toContain('name');
    expect(cookieRuleError('bad name=value', false)).toContain('name');
    expect(cookieRuleError('ok=a;b', false)).toContain('semicolon');
    expect(cookieRuleError('ok=value', false)).toBeNull();
  });
});

describe('CSP directive helper', () => {
  it('replaces a directive instead of duplicating it', () => {
    expect(setCspDirective("default-src 'none'; object-src 'none'", 'default-src', "'self'")).toBe(
      "default-src 'self'; object-src 'none'",
    );
  });
});

it('keeps structured editors and safe tab-only mode in exported profiles', () => {
  const original = profile({
    tabOnly: true,
    headers: [
      header({
        editor: 'csp',
        target: 'response',
        operation: 'set',
        name: 'Content-Security-Policy',
        value: "default-src 'self'",
      }),
    ],
  });
  const imported = importProfiles(exportProfiles([original])).profiles[0];
  expect(imported.tabOnly).toBe(true);
  expect(imported.headers[0].editor).toBe('csp');
});
