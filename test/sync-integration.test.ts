// End-to-end test of the replication stack against a fake chrome.storage:
// sync-runner → sync-area → storage, with the real quota rules enforced.
//
// The unit tests in sync.test.ts cover the pure engine. This file covers the
// wiring the engine cannot see: that writes actually land in the sync area, that
// a second device picks them up, that deletions propagate, and — most
// importantly — that a settled pair of devices stops writing.
//
// Two "devices" each get their own storage.local and SHARE one storage.sync,
// which is exactly the topology the real thing runs in.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load, save } from '../src/core/storage';
import { loadSyncState, readRemote } from '../src/core/sync-area';
import { clearSync, readSyncSnapshot, runSync } from '../src/core/sync-runner';
import {
  QUOTA_BYTES,
  QUOTA_BYTES_PER_ITEM,
  SYNC_META_KEY,
  SYNC_PROFILE_PREFIX,
  SYNC_STATE_KEY,
  SYNC_SETTINGS_KEY,
  profileKey,
} from '../src/core/sync';
import { DEFAULT_SETTINGS, STORAGE_KEY } from '../src/core/constants';
import {
  LEGACY_SYNC_META_KEY,
  LEGACY_SYNC_PROFILE_PREFIX,
  LEGACY_SYNC_SETTINGS_KEY,
  transferLegacySyncItems,
} from '../src/core/storage-compat';
import { SCHEMA_VERSION, type Profile, type StorageSchema } from '../src/core/types';
import { header, profile } from './helpers';

interface Quota {
  total?: number;
  perItem?: number;
}

/** Minimal chrome.storage.StorageArea with the real quota semantics. */
class FakeArea {
  private data = new Map<string, string>();

  constructor(private quota: Quota = {}) {}

  private bytes(key: string, serialized: string): number {
    return key.length + serialized.length;
  }

  private totalBytes(exclude = new Set<string>()): number {
    let sum = 0;
    for (const [key, value] of this.data) {
      if (!exclude.has(key)) sum += this.bytes(key, value);
    }
    return sum;
  }

  get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const wanted = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const key of wanted) {
      const raw = this.data.get(key);
      if (raw !== undefined) out[key] = JSON.parse(raw);
    }
    return Promise.resolve(out);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.onSet) {
      const hook = this.onSet;
      this.onSet = null;
      await hook();
    }
    const incoming = new Map<string, string>();
    for (const [key, value] of Object.entries(items)) {
      const serialized = JSON.stringify(value);
      if (this.quota.perItem && this.bytes(key, serialized) > this.quota.perItem) {
        return Promise.reject(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
      }
      incoming.set(key, serialized);
    }
    if (this.quota.total) {
      const replaced = new Set(incoming.keys());
      let projected = this.totalBytes(replaced);
      for (const [key, serialized] of incoming) projected += this.bytes(key, serialized);
      if (projected > this.quota.total) {
        return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
      }
    }
    for (const [key, serialized] of incoming) this.data.set(key, serialized);
    return Promise.resolve();
  }

  /** Set to make remove() reject, covering the failed-removal path. */
  failRemove = false;

  /** Runs during set(), to simulate work landing while a write is in flight. */
  onSet: (() => Promise<void>) | null = null;

  remove(keys: string | string[]): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error('simulated remove failure'));
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
    return Promise.resolve();
  }

  getBytesInUse(keys: string | string[] | null): Promise<number> {
    if (keys === null) return Promise.resolve(this.totalBytes());
    let sum = 0;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const raw = this.data.get(key);
      if (raw !== undefined) sum += this.bytes(key, raw);
    }
    return Promise.resolve(sum);
  }

  /** Deep snapshot for comparing "did anything change?" across cycles. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.data].map(([k, v]) => [k, JSON.parse(v)]));
  }

  keys(): string[] {
    return [...this.data.keys()].sort();
  }
}

let syncArea: FakeArea;
let deviceA: FakeArea;
let deviceB: FakeArea;
let activeLocal: FakeArea;

beforeEach(() => {
  syncArea = new FakeArea({ total: QUOTA_BYTES, perItem: QUOTA_BYTES_PER_ITEM });
  deviceA = new FakeArea();
  deviceB = new FakeArea();
  activeLocal = deviceA;

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    writable: true,
    value: {
      storage: {
        // Routed through a getter so switching devices switches storage.local
        // while storage.sync stays shared.
        get local() {
          return activeLocal;
        },
        sync: syncArea,
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    },
  });
});

/** Run a block "on" a device: its storage.local becomes the active one. */
async function on<T>(device: FakeArea, fn: () => Promise<T>): Promise<T> {
  const previous = activeLocal;
  activeLocal = device;
  try {
    return await fn();
  } finally {
    activeLocal = previous;
  }
}

function schemaWith(profiles: Profile[], syncEnabled = true): StorageSchema {
  return {
    version: SCHEMA_VERSION,
    profiles,
    settings: { ...DEFAULT_SETTINGS, syncEnabled },
  };
}

const seed = (device: FakeArea, profiles: Profile[], syncEnabled = true) =>
  on(device, () => save(schemaWith(profiles, syncEnabled)));

const profileNames = (device: FakeArea) =>
  on(device, async () => (await load()).profiles.map((p) => p.name));

const syncedProfileKeys = () => syncArea.keys().filter((k) => k.startsWith(SYNC_PROFILE_PREFIX));
const PREVIOUS_SCHEMA_KEY = 'previous_schema';
const PREVIOUS_STATE_KEY = 'previous_sync_state';

describe('storage-key upgrade', () => {
  it('moves local profiles to the HTTPatch key before deleting the previous copy', async () => {
    await deviceA.set({
      [PREVIOUS_SCHEMA_KEY]: schemaWith([profile({ id: 'saved', name: 'Saved profile' })]),
    });

    expect((await on(deviceA, load)).profiles[0].name).toBe('Saved profile');
    expect(deviceA.keys()).toContain(STORAGE_KEY);
    expect(deviceA.keys()).not.toContain(PREVIOUS_SCHEMA_KEY);
  });

  it('keeps the current local copy if an interrupted upgrade left both keys', async () => {
    await deviceA.set({
      [PREVIOUS_SCHEMA_KEY]: schemaWith([profile({ id: 'old', name: 'Old' })]),
      [STORAGE_KEY]: schemaWith([profile({ id: 'current', name: 'Current' })]),
    });

    expect((await on(deviceA, load)).profiles[0].name).toBe('Current');
    expect(deviceA.keys()).not.toContain(PREVIOUS_SCHEMA_KEY);
  });

  it('preserves device sync bookkeeping under the new local key', async () => {
    await deviceA.set({
      [PREVIOUS_STATE_KEY]: {
        v: 1,
        deviceId: 'saved-device',
        entries: {},
        tombstones: {},
        initialized: true,
      },
    });

    expect((await on(deviceA, loadSyncState)).deviceId).toBe('saved-device');
    expect(deviceA.keys()).toContain(SYNC_STATE_KEY);
    expect(deviceA.keys()).not.toContain(PREVIOUS_STATE_KEY);
  });

  it('moves synced profiles, settings and order to the new keys', async () => {
    const saved = profile({ id: 'saved', name: 'Synced profile' });
    await syncArea.set({
      [LEGACY_SYNC_META_KEY]: {
        v: 1,
        order: ['saved'],
        tombstones: {},
        updatedAt: 1000,
        deviceId: 'prior-device',
      },
      [LEGACY_SYNC_SETTINGS_KEY]: {
        v: 1,
        theme: 'dark',
        updatedAt: 1000,
        deviceId: 'prior-device',
      },
      [`${LEGACY_SYNC_PROFILE_PREFIX}saved`]: {
        v: 1,
        profile: saved,
        updatedAt: 1000,
        deviceId: 'prior-device',
      },
    });

    const remote = await readRemote();
    expect(remote.profiles.saved.profile.name).toBe('Synced profile');
    expect(remote.meta?.order).toEqual(['saved']);
    expect(remote.settings?.theme).toBe('dark');
    expect(syncArea.keys()).toEqual([SYNC_META_KEY, profileKey('saved'), SYNC_SETTINGS_KEY].sort());
  });

  it('keeps a newer HTTPatch sync revision when both key sets exist', async () => {
    const previousKey = `${LEGACY_SYNC_PROFILE_PREFIX}saved`;
    await syncArea.set({
      [previousKey]: {
        v: 1,
        profile: profile({ id: 'saved', name: 'Old' }),
        updatedAt: 1000,
        deviceId: 'old',
      },
      [profileKey('saved')]: {
        v: 1,
        profile: profile({ id: 'saved', name: 'New' }),
        updatedAt: 2000,
        deviceId: 'new',
      },
    });

    expect((await readRemote()).profiles.saved.profile.name).toBe('New');
    expect(syncArea.keys()).not.toContain(previousKey);
  });

  it('transfers a newer previous sync revision over an older current one', async () => {
    const previousKey = `${LEGACY_SYNC_PROFILE_PREFIX}saved`;
    await syncArea.set({
      [previousKey]: {
        v: 1,
        profile: profile({ id: 'saved', name: 'Latest' }),
        updatedAt: 3000,
        deviceId: 'prior-device',
      },
      [profileKey('saved')]: {
        v: 1,
        profile: profile({ id: 'saved', name: 'Older' }),
        updatedAt: 2000,
        deviceId: 'current-device',
      },
    });

    expect((await readRemote()).profiles.saved.profile.name).toBe('Latest');
    expect(syncArea.keys()).not.toContain(previousKey);
  });

  it('moves a large sync item without needing room for two full copies', async () => {
    const area = new FakeArea({ total: 6000, perItem: QUOTA_BYTES_PER_ITEM });
    const previousKey = `${LEGACY_SYNC_PROFILE_PREFIX}large`;
    await area.set({
      [previousKey]: { updatedAt: 1000, value: 'x'.repeat(3500) },
      unrelated: 'x'.repeat(1500),
    });
    const raw = await area.get(null);

    await transferLegacySyncItems(raw, area);
    expect(area.keys()).toEqual([profileKey('large'), 'unrelated'].sort());
  });

  it('leaves the previous sync item intact if transfer fails', async () => {
    const area = new FakeArea();
    const previousKey = `${LEGACY_SYNC_PROFILE_PREFIX}saved`;
    await area.set({ [previousKey]: { updatedAt: 1000, value: 'saved' } });
    const raw = await area.get(null);
    area.onSet = async () => {
      throw new Error('simulated write failure');
    };

    await expect(transferLegacySyncItems(raw, area)).rejects.toThrow('simulated write failure');
    expect(area.keys()).toEqual([previousKey]);
  });

  it('removes both key namespaces when clearing the synced copy', async () => {
    await syncArea.set({
      [LEGACY_SYNC_META_KEY]: { order: ['saved'] },
      [`${LEGACY_SYNC_PROFILE_PREFIX}saved`]: { profile: profile({ id: 'saved' }) },
      [SYNC_SETTINGS_KEY]: { theme: 'light' },
      unrelated: 'keep',
    });

    await on(deviceA, clearSync);
    expect(syncArea.keys()).toEqual(['unrelated']);
  });
});

describe('replication end to end', () => {
  it('replicates note-only edits and clears, then stops writing', async () => {
    await seed(deviceA, [profile({ id: 'p1', headers: [header({ id: 'h1' })] })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));

    for (const [index, comment] of ['Northwind, production', undefined].entries()) {
      const now = 10000 + index * 10000;
      await on(deviceA, async () => {
        const current = await load();
        current.profiles[0].headers[0].comment = comment;
        await save(current);
      });
      await on(deviceA, () => runSync({ now }));
      await on(deviceB, () => runSync({ now: now + 1000 }));
      expect(await on(deviceB, async () => (await load()).profiles[0].headers[0].comment)).toBe(
        comment,
      );
      const settled = syncArea.snapshot();
      const set = vi.spyOn(syncArea, 'set');
      const remove = vi.spyOn(syncArea, 'remove');
      await on(deviceA, () => runSync({ now: now + 2000 }));
      await on(deviceB, () => runSync({ now: now + 3000 }));
      expect(syncArea.snapshot()).toEqual(settled);
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      set.mockRestore();
      remove.mockRestore();
    }
  });

  it('keeps an oversized note local and reports the sync skip', async () => {
    const comment = 'Customer reminder '.repeat(1000);
    await seed(deviceA, [profile({ id: 'p1', headers: [header({ comment })] })]);
    const outcome = await on(deviceA, () => runSync({ now: 1000 }));
    expect(outcome.skipped).toEqual([
      expect.objectContaining({ profileId: 'p1', reason: 'too-large' }),
    ]);
    expect(await on(deviceA, async () => (await load()).profiles[0].headers[0].comment)).toBe(
      comment,
    );
    const settled = syncArea.snapshot();
    const set = vi.spyOn(syncArea, 'set');
    const remove = vi.spyOn(syncArea, 'remove');
    await on(deviceA, () => runSync({ now: 2000 }));
    expect(syncArea.snapshot()).toEqual(settled);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    set.mockRestore();
    remove.mockRestore();
  });

  it('publishes local profiles to the sync area', async () => {
    await seed(deviceA, [
      profile({ id: 'p1', name: 'Staging' }),
      profile({ id: 'p2', name: 'Prod' }),
    ]);

    const outcome = await on(deviceA, () => runSync({ now: 1000 }));

    expect(outcome.ran).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.skipped).toEqual([]);
    expect(syncedProfileKeys()).toEqual([profileKey('p1'), profileKey('p2')]);
    expect(syncArea.keys()).toContain(SYNC_META_KEY);
    expect(syncArea.keys()).toContain(SYNC_SETTINGS_KEY);
    expect(outcome.bytesInUse).toBeGreaterThan(0);
  });

  it('stops writing once settled — the write-loop guard', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'Staging' })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    const afterFirst = syncArea.snapshot();

    // Our own push fires storage.onChanged, which runs another cycle. If that
    // cycle wrote anything, the extension would write to sync forever.
    const second = await on(deviceA, () => runSync({ now: 2000 }));
    expect(second.ran).toBe(true);
    expect(syncArea.snapshot()).toEqual(afterFirst);

    const third = await on(deviceA, () => runSync({ now: 3000 }));
    expect(syncArea.snapshot()).toEqual(afterFirst);
    expect(third.localChanged).toBe(false);
  });

  it('carries profiles to a second device, which then also settles', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'Staging' })]);
    await on(deviceA, () => runSync({ now: 1000 }));

    await seed(deviceB, []);
    const pull = await on(deviceB, () => runSync({ now: 2000 }));

    expect(pull.localChanged).toBe(true);
    expect(await profileNames(deviceB)).toEqual(['Staging']);

    const afterPull = syncArea.snapshot();
    await on(deviceB, () => runSync({ now: 3000 }));
    expect(syncArea.snapshot()).toEqual(afterPull);
  });

  it('merges divergent edits to different profiles', async () => {
    const p1 = profile({ id: 'p1', name: 'One' });
    const p2 = profile({ id: 'p2', name: 'Two' });
    await seed(deviceA, [p1, p2]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));

    // A renames p1; B renames p2. Both edits must survive on both devices.
    await on(deviceA, async () => {
      const schema = await load();
      await save({
        ...schema,
        profiles: schema.profiles.map((p) => (p.id === 'p1' ? { ...p, name: 'One (A)' } : p)),
      });
    });
    await on(deviceB, async () => {
      const schema = await load();
      await save({
        ...schema,
        profiles: schema.profiles.map((p) => (p.id === 'p2' ? { ...p, name: 'Two (B)' } : p)),
      });
    });

    await on(deviceA, () => runSync({ now: 3000 }));
    await on(deviceB, () => runSync({ now: 4000 }));
    await on(deviceA, () => runSync({ now: 5000 }));

    expect((await profileNames(deviceA)).sort()).toEqual(['One (A)', 'Two (B)']);
    expect((await profileNames(deviceB)).sort()).toEqual(['One (A)', 'Two (B)']);
  });

  it('propagates a deletion without it coming back', async () => {
    await seed(deviceA, [
      profile({ id: 'p1', name: 'Keep' }),
      profile({ id: 'p2', name: 'Delete' }),
    ]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));
    expect(await profileNames(deviceB)).toEqual(['Keep', 'Delete']);

    // A deletes p2.
    await on(deviceA, async () => {
      const schema = await load();
      await save({ ...schema, profiles: schema.profiles.filter((p) => p.id !== 'p2') });
    });
    await on(deviceA, () => runSync({ now: 3000 }));
    expect(syncedProfileKeys()).toEqual([profileKey('p1')]);

    // B applies the deletion rather than re-uploading its copy.
    await on(deviceB, () => runSync({ now: 4000 }));
    expect(await profileNames(deviceB)).toEqual(['Keep']);
    expect(syncedProfileKeys()).toEqual([profileKey('p1')]);

    // And it stays deleted on both.
    await on(deviceA, () => runSync({ now: 5000 }));
    await on(deviceB, () => runSync({ now: 6000 }));
    expect(await profileNames(deviceA)).toEqual(['Keep']);
    expect(await profileNames(deviceB)).toEqual(['Keep']);
  });

  it('resolves a same-profile conflict last-write-wins', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'Base' })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));

    const rename = (device: FakeArea, name: string) =>
      on(device, async () => {
        const schema = await load();
        await save({ ...schema, profiles: schema.profiles.map((p) => ({ ...p, name })) });
      });

    await rename(deviceA, 'Edited on A');
    await rename(deviceB, 'Edited on B');

    // A pushes first, then B pushes with a later timestamp and wins.
    await on(deviceA, () => runSync({ now: 3000 }));
    const bPush = await on(deviceB, () => runSync({ now: 4000 }));
    expect(bPush.conflicts).toEqual([]); // B's local edit was the newer one

    const aPull = await on(deviceA, () => runSync({ now: 5000 }));
    expect(await profileNames(deviceA)).toEqual(['Edited on B']);
    expect(aPull.conflicts).toEqual([]); // A had no unpushed edit left to lose
  });

  it('skips a profile too large to sync but still syncs the others', async () => {
    await seed(deviceA, [
      profile({ id: 'small', name: 'Small' }),
      profile({
        id: 'big',
        name: 'Huge',
        headers: [header({ id: 'h1', value: 'x'.repeat(QUOTA_BYTES_PER_ITEM) })],
      }),
    ]);

    const outcome = await on(deviceA, () => runSync({ now: 1000 }));

    expect(outcome.error).toBeUndefined();
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]).toMatchObject({ profileId: 'big', reason: 'too-large' });
    expect(syncedProfileKeys()).toEqual([profileKey('small')]);
    // The oversized profile is untouched locally — sync never costs data.
    expect(await profileNames(deviceA)).toEqual(['Small', 'Huge']);
  });

  /** Write a raw blob from before sync existed: settings with no syncEnabled key. */
  const seedLegacy = (device: FakeArea, profiles: Profile[], settings = {}) =>
    on(device, () =>
      chrome.storage.local.set({
        httpatch: {
          version: SCHEMA_VERSION,
          profiles,
          settings: { paused: false, theme: 'system', ...settings },
        },
      }),
    );

  it('opts an install upgrading from before the feature into sync', async () => {
    // Settings are coerced field-by-field against DEFAULT_SETTINGS, and a
    // pre-sync install has no syncEnabled key, so it resolves to the default.
    await seedLegacy(deviceA, [profile({ id: 'p1', name: 'Pre-existing' })]);

    const settings = await on(deviceA, async () => (await load()).settings);
    expect(settings.syncEnabled).toBe(true);

    const outcome = await on(deviceA, () => runSync({ now: 1000 }));
    expect(outcome.ran).toBe(true);
    expect(syncedProfileKeys()).toEqual([profileKey('p1')]);
  });

  it('honours an explicit opt-out and never re-enables it', async () => {
    // The guarantee that survives default-on: once a user turns sync off, that
    // is persisted as syncEnabled: false and coercion must preserve it, so no
    // later upgrade or default silently starts uploading their profiles again.
    await seedLegacy(deviceA, [profile({ id: 'p1', name: 'Private' })], { syncEnabled: false });

    const settings = await on(deviceA, async () => (await load()).settings);
    expect(settings.syncEnabled).toBe(false);

    const outcome = await on(deviceA, () => runSync({ now: 1000 }));
    expect(outcome.ran).toBe(false);
    expect(syncArea.keys()).toEqual([]);
  });

  it('does nothing at all when sync is off', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'Local only' })], false);

    const outcome = await on(deviceA, () => runSync({ now: 1000 }));

    expect(outcome.ran).toBe(false);
    expect(syncArea.keys()).toEqual([]);
    expect(await profileNames(deviceA)).toEqual(['Local only']);
  });

  it('clears the synced copy without touching local profiles', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'Mine' })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    expect(syncArea.keys().length).toBeGreaterThan(0);

    await on(deviceA, () => clearSync());

    expect(syncArea.keys()).toEqual([]);
    expect(await profileNames(deviceA)).toEqual(['Mine']);
  });

  it('reports a read-only snapshot without writing anything', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'Mine' })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    const before = syncArea.snapshot();

    const snapshot = await on(deviceA, () => readSyncSnapshot());

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.available).toBe(true);
    expect(snapshot.firstRun).toBe(false);
    expect(snapshot.remoteProfileCount).toBe(1);
    expect(snapshot.lastSyncedAt).toBe(1000);
    expect(snapshot.quotaBytes).toBe(QUOTA_BYTES);
    expect(syncArea.snapshot()).toEqual(before);
  });

  it('keeps both sides on a first-run merge', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'From A' })]);
    await on(deviceA, () => runSync({ now: 1000 }));

    // B already has its own profile before it ever syncs.
    await seed(deviceB, [profile({ id: 'p2', name: 'From B' })]);
    await on(deviceB, () => runSync({ now: 2000, mergeMode: 'merge' }));

    expect((await profileNames(deviceB)).sort()).toEqual(['From A', 'From B']);
    await on(deviceA, () => runSync({ now: 3000 }));
    expect((await profileNames(deviceA)).sort()).toEqual(['From A', 'From B']);
  });

  it('keep-remote replaces this device on first run', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'From A' })]);
    await on(deviceA, () => runSync({ now: 1000 }));

    await seed(deviceB, [profile({ id: 'p2', name: 'From B' })]);
    await on(deviceB, () => runSync({ now: 2000, mergeMode: 'keep-remote' }));

    expect(await profileNames(deviceB)).toEqual(['From A']);
  });

  it('keep-local replaces the synced copy on first run', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'From A' })]);
    await on(deviceA, () => runSync({ now: 1000 }));

    await seed(deviceB, [profile({ id: 'p2', name: 'From B' })]);
    await on(deviceB, () => runSync({ now: 2000, mergeMode: 'keep-local' }));

    expect(syncedProfileKeys()).toEqual([profileKey('p2')]);
    expect(await profileNames(deviceB)).toEqual(['From B']);
  });

  it('syncs theme but never paused or the active profile', async () => {
    await seed(deviceA, [profile({ id: 'p1', name: 'Shared' })]);
    await on(deviceA, async () => {
      const schema = await load();
      await save({
        ...schema,
        settings: { ...schema.settings, theme: 'dark', paused: true, activeProfileId: 'p1' },
      });
    });
    await on(deviceA, () => runSync({ now: 1000 }));

    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));

    const bSettings = await on(deviceB, async () => (await load()).settings);
    expect(bSettings.theme).toBe('dark');
    // B was never paused and has no active profile of A's choosing.
    expect(bSettings.paused).toBe(false);
    expect(bSettings.activeProfileId).toBeUndefined();
  });
});

describe('convergence with profiles on both sides', () => {
  // The topology every earlier settle test missed: device B starts with its OWN
  // profile rather than empty, so its order can diverge from the published one.
  // Reported by Paul on PR #36 — these two are his repros.

  it('a merged pair of devices stops writing', async () => {
    await seed(deviceA, [profile({ id: 'a1', name: 'From A' })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, [profile({ id: 'b1', name: 'From B' })]);
    await on(deviceB, () => runSync({ now: 2000, mergeMode: 'merge' }));

    let now = 3000;
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      const device = i % 2 === 0 ? deviceA : deviceB;
      const before = JSON.stringify(syncArea.snapshot());
      await on(device, () => runSync({ now: (now += 1000) }));
      const after = JSON.stringify(syncArea.snapshot());
      seen.push(`${i % 2 === 0 ? 'A' : 'B'}: ${before === after ? 'no-write' : 'WROTE'}`);
    }
    expect(seen.slice(-4)).toEqual(['A: no-write', 'B: no-write', 'A: no-write', 'B: no-write']);
  });

  it('stops writing after ordinary onboarding, then an edit on each device', async () => {
    // Not a first-run artifact: B onboards empty (so adopts A's order), and only
    // then does each device add a profile of its own.
    await seed(deviceA, [profile({ id: 'a1', name: 'From A' })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));

    const addProfile = (device: FakeArea, id: string, name: string) =>
      on(device, async () => {
        const schema = await load();
        await save({ ...schema, profiles: [...schema.profiles, profile({ id, name })] });
      });
    await addProfile(deviceA, 'a2', 'Added on A');
    await addProfile(deviceB, 'b2', 'Added on B');

    let now = 3000;
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      const device = i % 2 === 0 ? deviceA : deviceB;
      const before = JSON.stringify(syncArea.snapshot());
      await on(device, () => runSync({ now: (now += 1000) }));
      seen.push(before === JSON.stringify(syncArea.snapshot()) ? 'no-write' : 'WROTE');
    }
    expect(seen.slice(-4)).toEqual(['no-write', 'no-write', 'no-write', 'no-write']);
  });

  it('leaves both devices agreeing on one profile order', async () => {
    // Order is not cosmetic: it decides which profile wins a header conflict, so
    // the devices agreeing matters as much as the writes stopping.
    await seed(deviceA, [profile({ id: 'a1', name: 'From A' })]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, [profile({ id: 'b1', name: 'From B' })]);
    await on(deviceB, () => runSync({ now: 2000, mergeMode: 'merge' }));
    for (let i = 0; i < 4; i++) {
      await on(deviceA, () => runSync({ now: 3000 + i * 1000 }));
      await on(deviceB, () => runSync({ now: 3500 + i * 1000 }));
    }

    const orderA = await on(deviceA, async () => (await load()).profiles.map((p) => p.id));
    const orderB = await on(deviceB, async () => (await load()).profiles.map((p) => p.id));
    expect(orderA).toEqual(orderB);
    expect(orderA.sort()).toEqual(['a1', 'b1']);
    expect(syncArea.snapshot()['ht_s_meta']).toMatchObject({ order: orderA });
  });

  it('does not report a conflict when a device re-reads its own interrupted push', async () => {
    // A partly failed push leaves our revision in the area while the profile is
    // still marked dirty locally, which looks like a foreign edit next cycle.
    await seed(deviceA, [profile({ id: 'p1', name: 'Mine' })]);
    await on(deviceA, () => runSync({ now: 1000 }));

    await on(deviceA, async () => {
      const schema = await load();
      await save({
        ...schema,
        profiles: schema.profiles.map((p) => ({ ...p, name: 'Edited locally' })),
      });
    });
    // Push succeeds outwardly, but the state commit is lost (worker killed).
    const stateBefore = await on(deviceA, async () =>
      structuredClone((await chrome.storage.local.get('httpatch_sync_state')).httpatch_sync_state),
    );
    await on(deviceA, () => runSync({ now: 2000 }));
    await on(deviceA, () => chrome.storage.local.set({ httpatch_sync_state: stateBefore }));

    const outcome = await on(deviceA, () => runSync({ now: 3000 }));
    expect(outcome.conflicts).toEqual([]);
  });

  it('reports a failed removal instead of committing it as done', async () => {
    await seed(deviceA, [profile({ id: 'p1' }), profile({ id: 'p2' })]);
    await on(deviceA, () => runSync({ now: 1000 }));

    await on(deviceA, async () => {
      const schema = await load();
      await save({ ...schema, profiles: schema.profiles.filter((p) => p.id !== 'p2') });
    });

    syncArea.failRemove = true;
    const failed = await on(deviceA, () => runSync({ now: 2000 }));
    expect(failed.ran).toBe(false);
    expect(failed.error).toBeTruthy();
    expect(syncArea.keys()).toContain(profileKey('p2'));

    // With removals working again the deletion still propagates.
    syncArea.failRemove = false;
    await on(deviceA, () => runSync({ now: 3000 }));
    expect(syncArea.keys()).not.toContain(profileKey('p2'));
  });

  it('lets the published revision win a first-run same-id collision', async () => {
    const shared = profile({ id: 'same', name: 'Published' });
    await seed(deviceA, [shared]);
    await on(deviceA, () => runSync({ now: 1000 }));

    // B has never synced, and happens to hold the same id with different content.
    await seed(deviceB, [{ ...shared, name: 'Local copy' }]);
    const outcome = await on(deviceB, () => runSync({ now: 2000, mergeMode: 'merge' }));

    expect(await profileNames(deviceB)).toEqual(['Published']);
    expect(outcome.conflicts).toEqual(['Local copy']);
  });
});

describe('convergence with an unpublishable profile', () => {
  // Round 2 of the same loop class, reported by Paul: the published order used to
  // name every local profile, including ones that can never reach the area. A
  // peer strips the unknown id when adopting, the holder re-appends it, forever.
  // Only ids that actually exist in the area may be published.

  /** Alternate cycles between the devices and report which ones wrote. */
  async function cycles(count: number, start: number): Promise<string[]> {
    let now = start;
    const seen: string[] = [];
    for (let i = 0; i < count; i++) {
      const device = i % 2 === 0 ? deviceA : deviceB;
      const before = JSON.stringify(syncArea.snapshot());
      await on(device, () => runSync({ now: (now += 1000) }));
      seen.push(before === JSON.stringify(syncArea.snapshot()) ? 'no-write' : 'WROTE');
    }
    return seen;
  }

  it('goes quiet when a device holds a profile too large to sync', async () => {
    const big = profile({
      id: 'big',
      name: 'Huge',
      headers: [header({ id: 'h1', value: 'x'.repeat(QUOTA_BYTES_PER_ITEM) })],
    });
    await seed(deviceA, [profile({ id: 'small', name: 'Small' }), big]);
    await on(deviceA, () => runSync({ now: 1000 }));
    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));

    expect((await cycles(8, 3000)).slice(-4)).toEqual([
      'no-write',
      'no-write',
      'no-write',
      'no-write',
    ]);

    // The published order names only what is actually up there...
    expect((syncArea.snapshot()['ht_s_meta'] as { order: string[] }).order).toEqual(['small']);
    // ...while the holder keeps the unpublishable profile locally, in position.
    expect(await profileNames(deviceA)).toEqual(['Small', 'Huge']);
    expect(await profileNames(deviceB)).toEqual(['Small']);
  });

  it('goes quiet when a profile is skipped because the area is full', async () => {
    // Enough near-cap profiles that the tail cannot fit in the 100 KB area.
    const profiles = Array.from({ length: 20 }, (_, i) =>
      profile({
        id: `p${i}`,
        name: `P${i}`,
        headers: [header({ id: `h${i}`, value: 'x'.repeat(7000) })],
      }),
    );
    await seed(deviceA, profiles);
    const first = await on(deviceA, () => runSync({ now: 1000 }));
    expect(first.skipped.some((skip) => skip.reason === 'quota')).toBe(true);

    await seed(deviceB, []);
    await on(deviceB, () => runSync({ now: 2000 }));

    expect((await cycles(8, 3000)).slice(-4)).toEqual([
      'no-write',
      'no-write',
      'no-write',
      'no-write',
    ]);

    // Nothing in the published order is missing from the area.
    const snapshot = syncArea.snapshot();
    const published = (snapshot['ht_s_meta'] as { order: string[] }).order;
    for (const id of published) {
      expect(snapshot[profileKey(id)]).toBeDefined();
    }
    // The skipped profiles are still safe on the device that owns them.
    expect((await profileNames(deviceA)).length).toBe(20);
  });
});

describe('a cycle must not clobber a concurrent local edit', () => {
  it('keeps an edit that lands while the outward write is in flight', async () => {
    // The window is real: writeRemote talks to the browser's sync area, and the
    // UI writes the whole schema too, so a snapshot taken before the write can be
    // stale by the time it is saved.
    const p1 = profile({ id: 'p1', name: 'From A' });
    await seed(deviceA, [p1]);
    await on(deviceA, () => runSync({ now: 1000 }));

    // deviceB pulls p1 and pushes its own b1, so the cycle really does write
    // outward. While that write is in flight the user adds another profile on
    // deviceB — a plain storage.local write, exactly as the UI does.
    await seed(deviceB, [profile({ id: 'b1', name: 'From B' })]);
    syncArea.onSet = async () => {
      await on(deviceB, async () => {
        const schema = await load();
        await save({
          ...schema,
          profiles: [...schema.profiles, profile({ id: 'local', name: 'Typed mid-sync' })],
        });
      });
    };

    await on(deviceB, () => runSync({ now: 2000 }));

    // The concurrent edit must survive.
    expect(await profileNames(deviceB)).toContain('Typed mid-sync');

    // And the cycle still completes on a later run, without losing anything.
    await on(deviceB, () => runSync({ now: 3000 }));
    await on(deviceA, () => runSync({ now: 4000 }));
    expect((await profileNames(deviceB)).sort()).toEqual(['From A', 'From B', 'Typed mid-sync']);
    expect((await profileNames(deviceA)).sort()).toEqual(['From A', 'From B', 'Typed mid-sync']);
  });
});
