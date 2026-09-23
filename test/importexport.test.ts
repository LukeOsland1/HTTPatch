import { describe, it, expect } from 'vitest';
import { exportProfiles, importProfiles, ImportError } from '../src/core/importexport';
import { header, profile } from './helpers';

describe('import/export', () => {
  it('preserves plain-text notes and accepts older profiles without them', () => {
    const notes = ['Northwind, production', '東京 <img src=x onerror=alert(1)>', '', undefined];
    const original = profile({ headers: notes.map((comment) => header({ comment })) });
    const { profiles } = importProfiles(exportProfiles([original]));
    expect(profiles[0].headers.map((h) => h.comment)).toEqual(notes);
    const malformed = importProfiles([
      { ...original, headers: [{ ...original.headers[0], comment: { text: 'not a string' } }] },
    ]);
    expect(malformed.profiles[0].headers[0].comment).toBeUndefined();
  });

  it('round-trips profiles (regenerating ids)', () => {
    const original = [
      profile({
        name: 'Auth',
        headers: [header({ name: 'Authorization', value: 'Bearer x' })],
        filters: {
          resourceTypes: ['xmlhttprequest'],
          urlFilters: [{ kind: 'wildcard', mode: 'include', pattern: '||api.example.com^' }],
        },
      }),
    ];
    const json = exportProfiles(original);
    const { profiles } = importProfiles(json);

    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('Auth');
    expect(profiles[0].headers[0].name).toBe('Authorization');
    expect(profiles[0].headers[0].value).toBe('Bearer x');
    expect(profiles[0].filters.resourceTypes).toEqual(['xmlhttprequest']);
    // ids are freshly generated, not copied
    expect(profiles[0].id).not.toBe(original[0].id);
  });

  it('rejects an unsupported version', () => {
    expect(() => importProfiles(JSON.stringify({ version: 99, profiles: [] }))).toThrow(
      ImportError,
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => importProfiles('{not json')).toThrow(ImportError);
  });

  it('rejects a bundle with no valid profiles', () => {
    expect(() => importProfiles(JSON.stringify({ version: 1, profiles: [] }))).toThrow(ImportError);
  });

  it('strips a non-hex color to close the CSS-injection sink but keeps valid hex', () => {
    const { profiles } = importProfiles([
      { name: 'Evil', color: '#000;position:fixed;inset:0;background:url(https://evil/x)' },
      { name: 'Ok', color: '#4f46e5' },
    ]);
    expect(profiles[0].color).toBeUndefined();
    expect(profiles[1].color).toBe('#4f46e5');
  });

  it('accepts a bare profiles array and drops invalid header rows', () => {
    const { profiles, warnings } = importProfiles([
      {
        name: 'P',
        headers: [
          { target: 'request', operation: 'set', name: 'X-Ok', value: '1' },
          { target: 'nonsense', operation: 'set', name: 'X-Bad' },
        ],
      },
    ]);
    expect(profiles[0].headers).toHaveLength(1);
    expect(profiles[0].headers[0].name).toBe('X-Ok');
    expect(warnings.length).toBeGreaterThan(0);
  });
});
