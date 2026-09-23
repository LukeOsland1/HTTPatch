import { describe, expect, it } from 'vitest';
import { migrate } from '../src/core/storage';
import { SCHEMA_VERSION } from '../src/core/types';

describe('migrate', () => {
  it('returns an empty schema for non-object input', () => {
    expect(migrate(null).profiles).toEqual([]);
    expect(migrate(null).settings.theme).toBe('light');
    expect(migrate('nonsense').profiles).toEqual([]);
    expect(migrate(42).settings.paused).toBe(false);
  });

  it('preserves valid profile and header ids', () => {
    const result = migrate({
      profiles: [
        {
          id: 'p1',
          name: 'Keep me',
          enabled: true,
          headers: [
            { id: 'h1', enabled: true, target: 'request', operation: 'set', name: 'X', value: '1' },
          ],
          filters: { urlFilters: [], resourceTypes: [] },
        },
      ],
    });
    expect(result.profiles[0].id).toBe('p1');
    expect(result.profiles[0].headers[0].id).toBe('h1');
  });

  it('drops corrupted profiles and headers instead of passing them through', () => {
    const result = migrate({
      profiles: [
        'not an object',
        {
          id: 'p1',
          name: 'Ok',
          enabled: true,
          headers: [
            { id: 'h1', enabled: true, target: 'request', operation: 'set', name: 'X', value: '1' },
            { id: 'h2', target: 'bogus', operation: 'set', name: 'Y' }, // invalid target
          ],
          filters: {},
        },
      ],
    });
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].headers).toHaveLength(1);
    expect(result.profiles[0].filters).toEqual({ urlFilters: [], resourceTypes: [] });
  });

  it('validates settings field-by-field, falling back on bad values', () => {
    const result = migrate({
      profiles: [],
      settings: { paused: 'yes', theme: 'neon', activeProfileId: 5 },
    });
    expect(result.settings.paused).toBe(false);
    expect(result.settings.theme).toBe('light');
    expect(result.settings.activeProfileId).toBeUndefined();
    expect(result.version).toBe(SCHEMA_VERSION);
  });

  it('opts settings from before sync existed into syncEnabled', () => {
    // A pre-sync install has no syncEnabled key, so it takes the default.
    const result = migrate({ profiles: [], settings: { paused: false, theme: 'dark' } });
    expect(result.settings.syncEnabled).toBe(true);
    expect(result.settings.theme).toBe('dark');
  });

  it('preserves an explicit system theme', () => {
    const result = migrate({ profiles: [], settings: { theme: 'system' } });
    expect(result.settings.theme).toBe('system');
  });

  it('preserves an explicit sync opt-out', () => {
    const result = migrate({ profiles: [], settings: { syncEnabled: false } });
    expect(result.settings.syncEnabled).toBe(false);
  });

  it('treats an unacknowledged sync notice as pending, and a dismissal as sticky', () => {
    // Absence is what marks a user as having been opted in *for* them, so it
    // must not be inventable by a stray truthy value in stored data.
    expect(migrate({ profiles: [], settings: {} }).settings.syncNoticeDismissed).toBeUndefined();
    expect(
      migrate({ profiles: [], settings: { syncNoticeDismissed: 'yes' } }).settings
        .syncNoticeDismissed,
    ).toBeUndefined();
    expect(
      migrate({ profiles: [], settings: { syncNoticeDismissed: true } }).settings
        .syncNoticeDismissed,
    ).toBe(true);
  });
});
