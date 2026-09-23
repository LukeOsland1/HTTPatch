import { describe, it, expect } from 'vitest';
import {
  summarizeImport,
  isSecuritySensitive,
  carriesSensitiveValue,
  profilesHaveSensitiveValues,
} from '../src/core/import-analysis';
import { header, profile } from './helpers';

describe('isSecuritySensitive', () => {
  it('flags a response rule that modifies a security-relevant header (case-insensitive)', () => {
    expect(
      isSecuritySensitive(
        header({ target: 'response', operation: 'set', name: 'Content-Security-Policy' }),
      ),
    ).toBe(true);
    expect(
      isSecuritySensitive(
        header({ target: 'response', operation: 'remove', name: 'x-frame-options' }),
      ),
    ).toBe(true);
    expect(
      isSecuritySensitive(
        header({ target: 'response', operation: 'set', name: 'Access-Control-Allow-Origin' }),
      ),
    ).toBe(true);
  });

  it('does not flag the same header name on the request side (only responses weaken a site)', () => {
    expect(
      isSecuritySensitive(header({ target: 'request', name: 'Content-Security-Policy' })),
    ).toBe(false);
  });

  it('does not flag an ordinary response header', () => {
    expect(isSecuritySensitive(header({ target: 'response', name: 'X-Custom' }))).toBe(false);
  });
});

describe('carriesSensitiveValue', () => {
  it('flags a set Authorization/Cookie/API-key value', () => {
    expect(carriesSensitiveValue(header({ name: 'Authorization', value: 'Bearer x' }))).toBe(true);
    expect(carriesSensitiveValue(header({ name: 'cookie', value: 'sid=1' }))).toBe(true);
    expect(carriesSensitiveValue(header({ name: 'X-Api-Key', value: 'k' }))).toBe(true);
  });

  it('does not flag a remove op, an empty value, or a non-sensitive header', () => {
    expect(carriesSensitiveValue(header({ name: 'Authorization', operation: 'remove' }))).toBe(
      false,
    );
    expect(carriesSensitiveValue(header({ name: 'Authorization', value: '' }))).toBe(false);
    expect(carriesSensitiveValue(header({ name: 'X-Custom', value: 'v' }))).toBe(false);
  });
});

describe('summarizeImport', () => {
  it('counts profiles and headers and captures target URL patterns', () => {
    const summary = summarizeImport([
      profile({
        name: 'A',
        headers: [header({ name: 'X-One' }), header({ name: 'X-Two' })],
        filters: {
          resourceTypes: [],
          urlFilters: [{ kind: 'wildcard', mode: 'include', pattern: '||api.example.com^' }],
        },
      }),
      profile({ name: 'B', headers: [] }),
    ]);

    expect(summary.profileCount).toBe(2);
    expect(summary.totalHeaders).toBe(2);
    expect(summary.profiles[0].urlPatterns).toEqual(['||api.example.com^']);
    expect(summary.profiles[1].urlPatterns).toEqual([]);
  });

  it('collects security-header flags across profiles and marks the ops', () => {
    const summary = summarizeImport([
      profile({
        name: 'Weaken',
        headers: [
          header({ target: 'response', operation: 'remove', name: 'Strict-Transport-Security' }),
          header({ target: 'request', operation: 'set', name: 'X-Ok' }),
        ],
      }),
    ]);

    expect(summary.securityFlags).toHaveLength(1);
    expect(summary.securityFlags[0]).toMatchObject({
      profileName: 'Weaken',
      target: 'response',
      operation: 'remove',
      headerName: 'Strict-Transport-Security',
    });
    expect(summary.profiles[0].ops[0].securitySensitive).toBe(true);
    expect(summary.profiles[0].ops[1].securitySensitive).toBe(false);
  });

  it('sets hasSensitiveValues when a credential header carries a value', () => {
    const withSecret = summarizeImport([
      profile({ name: 'S', headers: [header({ name: 'Authorization', value: 'Bearer x' })] }),
    ]);
    const withoutSecret = summarizeImport([
      profile({ name: 'S', headers: [header({ name: 'X-Ok', value: 'v' })] }),
    ]);
    expect(withSecret.hasSensitiveValues).toBe(true);
    expect(withoutSecret.hasSensitiveValues).toBe(false);
  });
});

describe('profilesHaveSensitiveValues', () => {
  it('is true only when some profile has a secret-bearing header', () => {
    expect(
      profilesHaveSensitiveValues([
        profile({ name: 'A', headers: [header({ name: 'X-Ok', value: 'v' })] }),
        profile({ name: 'B', headers: [header({ name: 'Cookie', value: 'sid=1' })] }),
      ]),
    ).toBe(true);
    expect(
      profilesHaveSensitiveValues([
        profile({ name: 'A', headers: [header({ name: 'X-Ok', value: 'v' })] }),
      ]),
    ).toBe(false);
  });
});
