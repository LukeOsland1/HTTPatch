import { describe, expect, it } from 'vitest';
import {
  QUOTA_BYTES_PER_ITEM,
  SYNC_VERSION,
  TOMBSTONE_TTL_MS,
  hashProfile,
  isNoopPlan,
  itemBytes,
  newSyncState,
  observeLocal,
  parseRemote,
  planToItems,
  profileKey,
  reconcile,
  type SyncPlan,
  type SyncState,
} from '../src/core/sync';
import type { Profile, StorageSchema } from '../src/core/types';
import { header, profile, schema } from './helpers';

const NOW = 1_700_000_000_000;

/** Raw sync-area contents, then parsed through the real validator. */
function remoteArea(opts: {
  profiles?: Array<{ profile: Profile; updatedAt: number; deviceId?: string }>;
  tombstones?: Record<string, number>;
  order?: string[];
  metaUpdatedAt?: number;
  metaVersion?: number;
  theme?: 'system' | 'light' | 'dark';
  themeUpdatedAt?: number;
}) {
  const raw: Record<string, unknown> = {};
  for (const p of opts.profiles ?? []) {
    raw[profileKey(p.profile.id)] = {
      v: SYNC_VERSION,
      profile: p.profile,
      updatedAt: p.updatedAt,
      deviceId: p.deviceId ?? 'other-device',
    };
  }
  if (opts.tombstones || opts.order || opts.metaUpdatedAt || opts.metaVersion) {
    raw['ht_s_meta'] = {
      v: opts.metaVersion ?? SYNC_VERSION,
      order: opts.order ?? (opts.profiles ?? []).map((p) => p.profile.id),
      tombstones: opts.tombstones ?? {},
      updatedAt: opts.metaUpdatedAt ?? NOW - 1000,
      deviceId: 'other-device',
    };
  }
  if (opts.theme) {
    raw['ht_s_settings'] = {
      v: SYNC_VERSION,
      theme: opts.theme,
      updatedAt: opts.themeUpdatedAt ?? NOW - 1000,
      deviceId: 'other-device',
    };
  }
  return parseRemote(raw);
}

/** State as it would look after a clean sync of the given profiles. */
function syncedState(profiles: Profile[], syncedAt: number): SyncState {
  const state = newSyncState('this-device');
  state.initialized = true;
  for (const p of profiles) {
    state.entries[p.id] = { syncedHash: hashProfile(p), syncedAt };
  }
  state.settings = { syncedHash: 'theme:light', syncedAt };
  return state;
}

const edited = (p: Profile, name: string): Profile => ({ ...p, name });

describe('hashProfile', () => {
  it('ignores key order but not content', () => {
    const a = profile({ id: 'p1', name: 'A', headers: [header({ id: 'h1' })] });
    const reordered = JSON.parse(
      JSON.stringify({
        filters: a.filters,
        headers: a.headers,
        enabled: a.enabled,
        name: a.name,
        id: a.id,
      }),
    ) as Profile;
    expect(hashProfile(reordered)).toBe(hashProfile(a));
    expect(hashProfile({ ...a, name: 'B' })).not.toBe(hashProfile(a));
  });
});

describe('observeLocal', () => {
  it('stamps a dirtiedAt once and keeps the original edit time', () => {
    const p = profile({ id: 'p1' });
    const state = syncedState([p], NOW - 5000);
    const local = schema([edited(p, 'renamed')]);

    const first = observeLocal(local, state, NOW);
    expect(first.entries.p1.dirtiedAt).toBe(NOW);

    // Observing again later must not push the edit time forward.
    const second = observeLocal(local, first, NOW + 60_000);
    expect(second.entries.p1.dirtiedAt).toBe(NOW);
  });

  it('tombstones a profile that has an entry but is gone from local storage', () => {
    const p = profile({ id: 'p1' });
    const next = observeLocal(schema([]), syncedState([p], NOW - 5000), NOW);
    expect(next.tombstones.p1).toBe(NOW);
    expect(next.entries.p1).toBeUndefined();
  });
});

describe('reconcile — merge behaviour', () => {
  it('keeps both edits when two devices change different profiles', () => {
    const p1 = profile({ id: 'p1', name: 'One' });
    const p2 = profile({ id: 'p2', name: 'Two' });
    const state = syncedState([p1, p2], NOW - 10_000);
    const local: StorageSchema = schema([edited(p1, 'One (local edit)'), p2]);
    const remote = remoteArea({
      profiles: [
        { profile: p1, updatedAt: NOW - 10_000 },
        { profile: edited(p2, 'Two (remote edit)'), updatedAt: NOW - 1000 },
      ],
    });

    const plan = reconcile({ local, remote, state, now: NOW });

    expect(plan.push.map((p) => p.item.profile.name)).toEqual(['One (local edit)']);
    expect(plan.localSchema?.profiles.map((p) => p.name)).toEqual([
      'One (local edit)',
      'Two (remote edit)',
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it('resolves a same-profile conflict last-write-wins and reports it', () => {
    const p1 = profile({ id: 'p1', name: 'Base' });
    const state = syncedState([p1], NOW - 10_000);
    const local = schema([edited(p1, 'Local edit')]);

    // Remote revision is newer than the local edit → remote wins.
    const remoteWins = reconcile({
      local,
      remote: remoteArea({
        profiles: [{ profile: edited(p1, 'Remote edit'), updatedAt: NOW + 5000 }],
      }),
      state: observeLocal(local, state, NOW),
      now: NOW + 6000,
    });
    expect(remoteWins.localSchema?.profiles[0].name).toBe('Remote edit');
    expect(remoteWins.push).toEqual([]);
    expect(remoteWins.conflicts).toEqual(['Local edit']);

    // Local edit is newer than the remote revision → local wins, no conflict.
    const localWins = reconcile({
      local,
      remote: remoteArea({
        profiles: [{ profile: edited(p1, 'Remote edit'), updatedAt: NOW - 5000 }],
      }),
      state: observeLocal(local, state, NOW),
      now: NOW + 1000,
    });
    expect(localWins.push.map((p) => p.item.profile.name)).toEqual(['Local edit']);
    expect(localWins.localSchema).toBeNull();
    expect(localWins.conflicts).toEqual([]);
  });

  it('applies a remote deletion instead of resurrecting the profile', () => {
    const p1 = profile({ id: 'p1', name: 'Doomed' });
    const state = syncedState([p1], NOW - 10_000);
    const plan = reconcile({
      local: schema([p1]),
      remote: remoteArea({ tombstones: { p1: NOW - 1000 } }),
      state,
      now: NOW,
    });

    expect(plan.localSchema?.profiles).toEqual([]);
    expect(plan.push).toEqual([]);
    expect(plan.nextState.entries.p1).toBeUndefined();
    // Nothing to re-announce — the peer already knows.
    expect(plan.nextState.tombstones.p1).toBeUndefined();
  });

  it('keeps a local edit that lands after a remote deletion', () => {
    const p1 = profile({ id: 'p1', name: 'Doomed' });
    const state = syncedState([p1], NOW - 10_000);
    const local = schema([edited(p1, 'Revived')]);
    const plan = reconcile({
      local,
      remote: remoteArea({ tombstones: { p1: NOW - 5000 } }),
      state: observeLocal(local, state, NOW),
      now: NOW,
    });

    expect(plan.push.map((p) => p.item.profile.name)).toEqual(['Revived']);
    expect(plan.localSchema).toBeNull();
  });

  it('propagates a local deletion outward as a key removal', () => {
    const p1 = profile({ id: 'p1' });
    const plan = reconcile({
      local: schema([]),
      remote: remoteArea({ profiles: [{ profile: p1, updatedAt: NOW - 10_000 }] }),
      state: syncedState([p1], NOW - 10_000),
      now: NOW,
    });

    expect(plan.removeKeys).toEqual([profileKey('p1')]);
    expect(plan.meta?.tombstones.p1).toBe(NOW);
  });

  it('lets an expired tombstone stop suppressing a profile', () => {
    const p1 = profile({ id: 'p1' });
    const plan = reconcile({
      local: schema([p1]),
      remote: remoteArea({ tombstones: { p1: NOW - TOMBSTONE_TTL_MS - 1 } }),
      state: syncedState([p1], NOW - 10_000),
      now: NOW,
    });

    expect(plan.localSchema).toBeNull();
    expect(plan.push.map((p) => p.item.profile.id)).toEqual(['p1']);
    expect(plan.meta?.tombstones.p1).toBeUndefined();
  });

  it('pulls a profile that only exists remotely', () => {
    const p1 = profile({ id: 'p1' });
    const p2 = profile({ id: 'p2', name: 'From the other laptop' });
    const plan = reconcile({
      local: schema([p1]),
      remote: remoteArea({ profiles: [{ profile: p2, updatedAt: NOW - 1000 }] }),
      state: syncedState([p1], NOW - 10_000),
      now: NOW,
    });

    expect(plan.localSchema?.profiles.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});

describe('reconcile — first run', () => {
  const p1 = profile({ id: 'p1', name: 'Local only' });
  const p2 = profile({ id: 'p2', name: 'Cloud only' });
  const fresh = () => newSyncState('this-device');
  const remote = () => remoteArea({ profiles: [{ profile: p2, updatedAt: NOW - 1000 }] });

  it('merges both sides by default', () => {
    const plan = reconcile({ local: schema([p1]), remote: remote(), state: fresh(), now: NOW });
    expect(plan.localSchema?.profiles.map((p) => p.name)).toEqual(['Local only', 'Cloud only']);
    expect(plan.push.map((p) => p.item.profile.name)).toEqual(['Local only']);
  });

  it('keep-local overwrites the cloud', () => {
    const plan = reconcile({
      local: schema([p1]),
      remote: remote(),
      state: fresh(),
      now: NOW,
      mergeMode: 'keep-local',
    });
    expect(plan.push.map((p) => p.item.profile.name)).toEqual(['Local only']);
    expect(plan.removeKeys).toEqual([profileKey('p2')]);
    expect(plan.localSchema).toBeNull();
  });

  it('keep-remote replaces this device', () => {
    const plan = reconcile({
      local: schema([p1]),
      remote: remote(),
      state: fresh(),
      now: NOW,
      mergeMode: 'keep-remote',
    });
    expect(plan.localSchema?.profiles.map((p) => p.name)).toEqual(['Cloud only']);
    expect(plan.push).toEqual([]);
  });

  it('marks the state initialized so later runs use the merge table', () => {
    const plan = reconcile({ local: schema([p1]), remote: remote(), state: fresh(), now: NOW });
    expect(plan.nextState.initialized).toBe(true);
    expect(plan.nextState.lastSyncedAt).toBe(NOW);
  });
});

describe('reconcile — quota', () => {
  it('skips a profile too large for a single sync item, keeping the rest', () => {
    const big = profile({
      id: 'big',
      name: 'Huge',
      headers: [header({ id: 'h1', value: 'x'.repeat(QUOTA_BYTES_PER_ITEM) })],
    });
    const small = profile({ id: 'small', name: 'Small' });

    const plan = reconcile({
      local: schema([big, small]),
      remote: remoteArea({}),
      state: newSyncState('this-device'),
      now: NOW,
    });

    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ profileId: 'big', reason: 'too-large' });
    expect(plan.push.map((p) => p.item.profile.id)).toEqual(['small']);
  });

  it('counts the meta and settings items against the budget', () => {
    // They share the same 100 KB area, so leaving them out of the baseline made
    // the budget over-optimistic and let a push through that the platform then
    // rejected outright. Same local state, two remotes differing only by the
    // presence of a (large) meta item: the fuller one must admit fewer pushes.
    const profiles = Array.from({ length: 14 }, (_, i) =>
      profile({
        id: `p${i}`,
        name: `P${i}`,
        headers: [header({ id: `h${i}`, value: 'x'.repeat(7000) })],
      }),
    );
    const local = schema(profiles);

    const withoutMeta = reconcile({
      local,
      remote: remoteArea({}),
      state: newSyncState('this-device'),
      now: NOW,
    });
    // A meta item carrying many tombstones is a real shape, and not free.
    const tombstones = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`deleted-profile-uuid-${i}`, NOW - 1000]),
    );
    const withMeta = reconcile({
      local,
      remote: remoteArea({ tombstones, order: [] }),
      state: newSyncState('this-device'),
      now: NOW,
    });

    expect(withMeta.push.length).toBeLessThan(withoutMeta.push.length);
    expect(withMeta.projectedBytes).toBeLessThanOrEqual(102_400);
  });

  it("keeps a skipped push's existing remote revision in the budget", () => {
    // A push excluded from the baseline as "about to be replaced" and then
    // skipped leaves the older revision sitting in the area. Dropping it from
    // the budget made the projection too optimistic.
    const small = profile({ id: 'p1', name: 'Small' });
    const remote = remoteArea({
      profiles: [{ profile: small, updatedAt: NOW - 1000 }],
      tombstones: {},
    });
    const huge = {
      ...small,
      headers: [header({ id: 'h1', value: 'x'.repeat(QUOTA_BYTES_PER_ITEM) })],
    };

    const plan = reconcile({
      local: schema([huge]),
      remote,
      state: syncedState([small], NOW - 1000),
      now: NOW,
    });

    expect(plan.skipped[0]).toMatchObject({ profileId: 'p1', reason: 'too-large' });
    expect(plan.projectedBytes).toBeGreaterThanOrEqual(
      itemBytes(profileKey('p1'), remote.profiles['p1']),
    );
  });

  it('reports a quota skip once the area is full', () => {
    // Each profile is just under the per-item cap, so a dozen overflows 100 KB.
    const profiles = Array.from({ length: 20 }, (_, i) =>
      profile({
        id: `p${i}`,
        name: `P${i}`,
        headers: [header({ id: `h${i}`, value: 'x'.repeat(7000) })],
      }),
    );

    const plan = reconcile({
      local: schema(profiles),
      remote: remoteArea({}),
      state: newSyncState('this-device'),
      now: NOW,
    });

    expect(plan.skipped.length).toBeGreaterThan(0);
    expect(plan.skipped.every((s) => s.reason === 'quota')).toBe(true);
    expect(plan.push.length).toBeLessThan(profiles.length);
    expect(plan.projectedBytes).toBeLessThanOrEqual(102_400);
  });
});

describe('reconcile — convergence', () => {
  /**
   * Apply a plan's outward half to the raw sync area, exactly as the adapter
   * would: set the pushed items, then delete the removed keys.
   */
  const applyToRaw = (
    plan: SyncPlan,
    before: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const raw = { ...before, ...planToItems(plan) };
    for (const key of plan.removeKeys) delete raw[key];
    return raw;
  };

  it('reaches a no-op on the second cycle when nothing else changed', () => {
    // The write-loop guard: our own push fires storage.onChanged, which triggers
    // another cycle. If that cycle were not a no-op, the extension would write to
    // sync forever.
    const local = schema([profile({ id: 'p1' }), profile({ id: 'p2' })]);
    const first = reconcile({
      local,
      remote: remoteArea({}),
      state: newSyncState('this-device'),
      now: NOW,
    });
    expect(isNoopPlan(first)).toBe(false);

    const second = reconcile({
      local,
      remote: parseRemote(applyToRaw(first)),
      state: first.nextState,
      now: NOW + 1000,
    });
    expect(isNoopPlan(second)).toBe(true);
  });

  it('reaches a no-op after a deletion has propagated', () => {
    const p1 = profile({ id: 'p1' });
    const p2 = profile({ id: 'p2' });
    const both = reconcile({
      local: schema([p1, p2]),
      remote: remoteArea({}),
      state: newSyncState('this-device'),
      now: NOW,
    });
    let raw = applyToRaw(both);

    // Delete p2 locally and let the removal propagate.
    const afterDelete = reconcile({
      local: schema([p1]),
      remote: parseRemote(raw),
      state: both.nextState,
      now: NOW + 1000,
    });
    expect(afterDelete.removeKeys).toEqual([profileKey('p2')]);
    raw = applyToRaw(afterDelete, raw);

    const settled = reconcile({
      local: schema([p1]),
      remote: parseRemote(raw),
      state: afterDelete.nextState,
      now: NOW + 2000,
    });
    expect(isNoopPlan(settled)).toBe(true);
    // The tombstone stays published so a device that was offline still learns of it.
    expect(parseRemote(raw).meta?.tombstones.p2).toBe(NOW + 1000);
  });

  it('reaches a no-op after a theme change has propagated', () => {
    const p1 = profile({ id: 'p1' });
    const base = schema([p1]);
    const local: StorageSchema = { ...base, settings: { ...base.settings, theme: 'dark' } };
    const first = reconcile({
      local,
      remote: remoteArea({}),
      state: newSyncState('this-device'),
      now: NOW,
    });
    expect(first.settings?.theme).toBe('dark');

    const second = reconcile({
      local,
      remote: parseRemote(applyToRaw(first)),
      state: first.nextState,
      now: NOW + 1000,
    });
    expect(isNoopPlan(second)).toBe(true);
  });

  it('a pulling device also settles rather than pushing back', () => {
    // Device A publishes; device B pulls; B's next cycle must be quiet.
    const p1 = profile({ id: 'p1', name: 'From A' });
    const fromA = reconcile({
      local: schema([p1]),
      remote: remoteArea({}),
      state: newSyncState('device-a'),
      now: NOW,
    });
    let raw = applyToRaw(fromA);

    const bPull = reconcile({
      local: schema([]),
      remote: parseRemote(raw),
      state: newSyncState('device-b'),
      now: NOW + 1000,
    });
    expect(bPull.localSchema?.profiles.map((p) => p.name)).toEqual(['From A']);
    raw = applyToRaw(bPull, raw);

    const bSettled = reconcile({
      local: bPull.localSchema!,
      remote: parseRemote(raw),
      state: bPull.nextState,
      now: NOW + 2000,
    });
    expect(isNoopPlan(bSettled)).toBe(true);
  });
});

describe('reconcile — safety', () => {
  it('refuses to write an area from a newer wire format', () => {
    const plan = reconcile({
      local: schema([profile({ id: 'p1' })]),
      remote: remoteArea({ metaVersion: SYNC_VERSION + 1, tombstones: {} }),
      state: newSyncState('this-device'),
      now: NOW,
    });

    expect(plan.blocked).toMatch(/newer version/i);
    expect(plan.push).toEqual([]);
    expect(plan.localSchema).toBeNull();
    expect(plan.nextState.initialized).toBe(false);
  });

  it('coerces corrupted remote items away instead of passing them through', () => {
    const remote = parseRemote({
      [profileKey('good')]: {
        v: SYNC_VERSION,
        profile: profile({ id: 'good', headers: [header({ id: 'h1' })] }),
        updatedAt: NOW,
        deviceId: 'other',
      },
      [profileKey('bad')]: { v: SYNC_VERSION, profile: 'not an object', updatedAt: NOW },
      [profileKey('alsobad')]: 'garbage',
    });

    expect(Object.keys(remote.profiles)).toEqual(['good']);
  });

  it('trusts the item key over a mismatched inner profile id', () => {
    const remote = parseRemote({
      [profileKey('key-id')]: {
        v: SYNC_VERSION,
        profile: profile({ id: 'inner-id' }),
        updatedAt: NOW,
        deviceId: 'other',
      },
    });

    expect(remote.profiles['key-id'].profile.id).toBe('key-id');
  });
});

describe('reconcile — settings', () => {
  it('pulls a newer remote theme', () => {
    const p1 = profile({ id: 'p1' });
    const plan = reconcile({
      local: schema([p1]),
      remote: remoteArea({
        profiles: [{ profile: p1, updatedAt: NOW - 10_000 }],
        theme: 'dark',
        themeUpdatedAt: NOW - 1000,
      }),
      state: syncedState([p1], NOW - 10_000),
      now: NOW,
    });

    expect(plan.localSchema?.settings.theme).toBe('dark');
  });

  it('adopts an established theme on a first run instead of clobbering it', () => {
    // Regression: settings are a single shared value, so on a first run BOTH
    // sides look changed and the local `dirtiedAt` is always later than the
    // remote `updatedAt`. Under plain last-write-wins any fresh device would
    // overwrite an established device's theme with its own default.
    const p1 = profile({ id: 'p1' });
    const plan = reconcile({
      local: schema([p1]), // theme: 'light' (the default)
      remote: remoteArea({ theme: 'dark', themeUpdatedAt: NOW - 100_000 }),
      state: newSyncState('fresh-device'),
      now: NOW,
    });

    expect(plan.localSchema?.settings.theme).toBe('dark');
    expect(plan.settings).toBeNull();
  });

  it('still publishes the local theme on a first run with nothing synced yet', () => {
    const p1 = profile({ id: 'p1' });
    const base = schema([p1]);
    const plan = reconcile({
      local: { ...base, settings: { ...base.settings, theme: 'light' } },
      remote: remoteArea({}),
      state: newSyncState('fresh-device'),
      now: NOW,
    });

    expect(plan.settings?.theme).toBe('light');
  });

  it('keep-local publishes this device theme over an established one', () => {
    const p1 = profile({ id: 'p1' });
    const base = schema([p1]);
    const plan = reconcile({
      local: { ...base, settings: { ...base.settings, theme: 'light' } },
      remote: remoteArea({ theme: 'dark', themeUpdatedAt: NOW - 100_000 }),
      state: newSyncState('fresh-device'),
      now: NOW,
      mergeMode: 'keep-local',
    });

    expect(plan.settings?.theme).toBe('light');
    expect(plan.localSchema?.settings.theme ?? 'light').toBe('light');
  });

  it('never syncs paused or activeProfileId', () => {
    const p1 = profile({ id: 'p1' });
    const local: StorageSchema = {
      ...schema([p1], true),
      settings: { paused: true, theme: 'light', activeProfileId: 'p1', syncEnabled: true },
    };
    const plan = reconcile({
      local,
      remote: remoteArea({ profiles: [{ profile: p1, updatedAt: NOW - 10_000 }] }),
      state: syncedState([p1], NOW - 10_000),
      now: NOW,
    });

    const serialized = JSON.stringify(plan.settings ?? {});
    expect(serialized).not.toMatch(/paused/);
    expect(serialized).not.toMatch(/activeProfileId/);
    // A device-local pause must survive reconciliation untouched.
    expect(plan.localSchema?.settings.paused ?? local.settings.paused).toBe(true);
  });
});
