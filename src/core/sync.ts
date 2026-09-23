// Cross-device replication of profiles over chrome.storage.sync.
//
// Design: chrome.storage.local stays the single source of truth for the
// compile→DNR pipeline. This module is a *replication layer*, never part of the
// hot path — if sync is unavailable, quota-exceeded, or the user is signed out,
// header modification keeps working exactly as it does with sync off.
//
// Everything here is pure. `reconcile()` takes the local schema, a snapshot of
// the remote area, and this device's sync state, and returns a plan describing
// what to push, pull, and delete. The thin chrome.storage.sync adapter lives in
// sync-area.ts (with a Firefox twin), so this file is fully unit-testable with
// no browser mocks — same discipline as compiler.ts and limits.ts.
//
// One item per profile (rather than one blob) is forced by sync's 8 KB
// per-item limit, and buys per-profile merge for free: two devices editing
// different profiles both keep their edits, where a single blob would have one
// silently clobber the other.

import type { Profile, Settings, StorageSchema } from './types';
import { SCHEMA_VERSION } from './types';
import { coerceProfiles } from './importexport';
import { DEFAULT_SETTINGS } from './constants';

/** Wire-format version of the sync items. Bump only on a breaking item change. */
export const SYNC_VERSION = 1 as const;

export const SYNC_META_KEY = 'ht_s_meta';
export const SYNC_SETTINGS_KEY = 'ht_s_settings';
export const SYNC_PROFILE_PREFIX = 'ht_s_p_';

/** Local-only key holding this device's SyncState. Never written to sync. */
export const SYNC_STATE_KEY = 'httpatch_sync_state';

/**
 * How long a deletion is remembered. Tombstones are what stop a device that
 * still holds a profile from cheerfully re-uploading one another device
 * deleted; the TTL bounds the meta item so it cannot grow without limit.
 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** chrome.storage.sync.QUOTA_BYTES / QUOTA_BYTES_PER_ITEM. */
export const QUOTA_BYTES = 102_400;
export const QUOTA_BYTES_PER_ITEM = 8_192;

export const profileKey = (id: string): string => `${SYNC_PROFILE_PREFIX}${id}`;

// ---------------------------------------------------------------------------
// Wire format (what actually lives in chrome.storage.sync)
// ---------------------------------------------------------------------------

export interface SyncProfileItem {
  v: number;
  profile: Profile;
  /** Epoch ms stamped by the device that wrote this revision. */
  updatedAt: number;
  deviceId: string;
}

export interface SyncMetaItem {
  v: number;
  /** Profile id order, so ordering survives a round trip. */
  order: string[];
  /** profileId → deletion time (epoch ms). */
  tombstones: Record<string, number>;
  updatedAt: number;
  deviceId: string;
}

export interface SyncSettingsItem {
  v: number;
  /** Only `theme` syncs. `paused` and `activeProfileId` are deliberately device-local. */
  theme: Settings['theme'];
  updatedAt: number;
  deviceId: string;
}

/** A parsed, validated view of the whole remote area. */
export interface RemoteSnapshot {
  meta: SyncMetaItem | null;
  profiles: Record<string, SyncProfileItem>;
  settings: SyncSettingsItem | null;
}

// ---------------------------------------------------------------------------
// Device-local sync bookkeeping (never synced)
// ---------------------------------------------------------------------------

export interface SyncEntry {
  /** Content hash of the profile as of the last successful push or pull. */
  syncedHash: string;
  /** The item `updatedAt` that hash corresponds to. */
  syncedAt: number;
  /**
   * When a local divergence from `syncedHash` was first observed. Present means
   * "dirty"; its value is the local edit time used to order against a remote
   * revision under last-write-wins.
   */
  dirtiedAt?: number;
}

export interface SyncState {
  v: number;
  deviceId: string;
  entries: Record<string, SyncEntry>;
  /** Local deletions awaiting propagation, profileId → deletion time. */
  tombstones: Record<string, number>;
  /** Bookkeeping for the synced slice of settings (theme only). */
  settings?: SyncEntry;
  lastSyncedAt?: number;
  lastError?: string;
  /** False until this device has completed one successful sync. */
  initialized: boolean;
}

export function newSyncState(deviceId: string): SyncState {
  return { v: SYNC_VERSION, deviceId, entries: {}, tombstones: {}, initialized: false };
}

/**
 * What to do when a device syncs for the first time and both sides already hold
 * profiles. `merge` is the default because duplicate names are survivable and
 * silently losing a profile set is not.
 */
export type MergeMode = 'merge' | 'keep-local' | 'keep-remote';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface SyncSkip {
  profileId: string;
  profileName: string;
  reason: 'too-large' | 'quota';
  bytes: number;
}

export interface SyncPlan {
  /** Profile items to write to the sync area. */
  push: Array<{ key: string; item: SyncProfileItem }>;
  /** Sync keys to remove (deletions to propagate outward). */
  removeKeys: string[];
  /** Meta item to write, or null when nothing about order/tombstones changed. */
  meta: SyncMetaItem | null;
  /** Settings item to write, or null when the synced slice is unchanged. */
  settings: SyncSettingsItem | null;
  /** Merged schema to persist locally, or null when local needs no change. */
  localSchema: StorageSchema | null;
  /** Commit this only after the writes above have succeeded. */
  nextState: SyncState;
  /** Profiles that could not be pushed, with a reason to surface in the UI. */
  skipped: SyncSkip[];
  /** Names of profiles where a local edit lost a last-write-wins race. */
  conflicts: string[];
  /** Projected total bytes in the sync area after this plan is applied. */
  projectedBytes: number;
  /** Set when the plan is a no-op because syncing would be unsafe. */
  blocked?: string;
}

export interface ReconcileInput {
  local: StorageSchema;
  remote: RemoteSnapshot;
  state: SyncState;
  /** Epoch ms; injected so the engine stays pure and testable. */
  now: number;
  mergeMode?: MergeMode;
}

// ---------------------------------------------------------------------------
// Hashing / sizing
// ---------------------------------------------------------------------------

/** Key-order-independent JSON so hashes do not change with property order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

/**
 * 64-bit FNV-1a (as two 32-bit halves) over the stable serialization. Used only
 * for change detection, so a hash collision costs a missed sync, not
 * corruption — and at 64 bits that is not a practical concern.
 */
export function hashProfile(profile: Profile): string {
  const s = stableStringify(profile);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 3)), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function hashTheme(theme: Settings['theme']): string {
  return `theme:${theme}`;
}

const byteLength = (s: string): number =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;

/** Bytes an item consumes against the sync quota — key length counts too. */
export function itemBytes(key: string, value: unknown): number {
  return byteLength(key) + byteLength(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Parsing the remote area (untrusted: another device, possibly newer)
// ---------------------------------------------------------------------------

const COERCE_OPTS = { preserveIds: true, nameFallback: 'Untitled profile' } as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function coerceTombstones(raw: unknown): Record<string, number> {
  if (!isObject(raw)) return {};
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(raw)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

/**
 * Validate raw sync-area contents into a RemoteSnapshot. Every profile goes
 * through the same coercion as import/migration, so a corrupted or partially
 * written remote item can never reach the compiler.
 */
export function parseRemote(raw: Record<string, unknown>): RemoteSnapshot {
  const snapshot: RemoteSnapshot = { meta: null, profiles: {}, settings: null };

  const rawMeta = raw[SYNC_META_KEY];
  if (isObject(rawMeta)) {
    snapshot.meta = {
      v: num(rawMeta.v) || SYNC_VERSION,
      order: Array.isArray(rawMeta.order)
        ? rawMeta.order.filter((id): id is string => typeof id === 'string')
        : [],
      tombstones: coerceTombstones(rawMeta.tombstones),
      updatedAt: num(rawMeta.updatedAt),
      deviceId: typeof rawMeta.deviceId === 'string' ? rawMeta.deviceId : '',
    };
  }

  const rawSettings = raw[SYNC_SETTINGS_KEY];
  if (isObject(rawSettings)) {
    const theme = rawSettings.theme;
    snapshot.settings = {
      v: num(rawSettings.v) || SYNC_VERSION,
      theme:
        theme === 'light' || theme === 'dark' || theme === 'system'
          ? theme
          : DEFAULT_SETTINGS.theme,
      updatedAt: num(rawSettings.updatedAt),
      deviceId: typeof rawSettings.deviceId === 'string' ? rawSettings.deviceId : '',
    };
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith(SYNC_PROFILE_PREFIX) || !isObject(value)) continue;
    // Coerce through the shared validator, which also drops invalid rows.
    const [profile] = coerceProfiles([value.profile], [], COERCE_OPTS);
    if (!profile) continue;
    const id = key.slice(SYNC_PROFILE_PREFIX.length);
    // Trust the key over a mismatched inner id so a rename cannot orphan an item.
    profile.id = id;
    snapshot.profiles[id] = {
      v: num(value.v) || SYNC_VERSION,
      profile,
      updatedAt: num(value.updatedAt),
      deviceId: typeof value.deviceId === 'string' ? value.deviceId : '',
    };
  }

  return snapshot;
}

/** Validate a persisted SyncState, falling back to a fresh one. */
export function coerceSyncState(raw: unknown, newDeviceId: () => string): SyncState {
  if (!isObject(raw) || typeof raw.deviceId !== 'string' || !raw.deviceId) {
    return newSyncState(newDeviceId());
  }
  const entries: Record<string, SyncEntry> = {};
  if (isObject(raw.entries)) {
    for (const [id, e] of Object.entries(raw.entries)) {
      if (!isObject(e) || typeof e.syncedHash !== 'string') continue;
      entries[id] = {
        syncedHash: e.syncedHash,
        syncedAt: num(e.syncedAt),
        dirtiedAt: typeof e.dirtiedAt === 'number' ? e.dirtiedAt : undefined,
      };
    }
  }
  const settings =
    isObject(raw.settings) && typeof raw.settings.syncedHash === 'string'
      ? {
          syncedHash: raw.settings.syncedHash,
          syncedAt: num(raw.settings.syncedAt),
          dirtiedAt:
            typeof raw.settings.dirtiedAt === 'number' ? raw.settings.dirtiedAt : undefined,
        }
      : undefined;
  return {
    v: SYNC_VERSION,
    deviceId: raw.deviceId,
    entries,
    tombstones: coerceTombstones(raw.tombstones),
    settings,
    lastSyncedAt: typeof raw.lastSyncedAt === 'number' ? raw.lastSyncedAt : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    initialized: raw.initialized === true,
  };
}

// ---------------------------------------------------------------------------
// Local change detection
// ---------------------------------------------------------------------------

function cloneState(state: SyncState): SyncState {
  return {
    ...state,
    entries: Object.fromEntries(Object.entries(state.entries).map(([k, v]) => [k, { ...v }])),
    tombstones: { ...state.tombstones },
    settings: state.settings ? { ...state.settings } : undefined,
  };
}

/**
 * Stamp local divergences from the last sync point. Exported for tests.
 *
 * A profile is dirty when its hash differs from `syncedHash`; the first time we
 * notice, we record `dirtiedAt` so the edit has a timestamp to race a remote
 * revision with. A profile that has an entry but is no longer in local storage
 * was deleted here, so it earns a tombstone.
 */
export function observeLocal(local: StorageSchema, state: SyncState, now: number): SyncState {
  const next = cloneState(state);
  const localIds = new Set(local.profiles.map((p) => p.id));

  for (const profile of local.profiles) {
    const hash = hashProfile(profile);
    const entry = next.entries[profile.id];
    if (!entry) {
      // Never synced: dirty from birth.
      next.entries[profile.id] = { syncedHash: '', syncedAt: 0, dirtiedAt: now };
    } else if (hash !== entry.syncedHash && entry.dirtiedAt === undefined) {
      entry.dirtiedAt = now;
    }
    // A resurrected id cannot also be pending deletion.
    delete next.tombstones[profile.id];
  }

  for (const id of Object.keys(next.entries)) {
    if (localIds.has(id)) continue;
    // Had an entry, gone from local → deleted here.
    if (next.tombstones[id] === undefined) next.tombstones[id] = now;
    delete next.entries[id];
  }

  const themeHash = hashTheme(local.settings.theme);
  if (!next.settings) {
    next.settings = { syncedHash: '', syncedAt: 0, dirtiedAt: now };
  } else if (themeHash !== next.settings.syncedHash && next.settings.dirtiedAt === undefined) {
    next.settings.dirtiedAt = now;
  }

  return next;
}

/**
 * Order-independent merge of two tombstone maps: the latest deletion wins.
 *
 * Spreading one over the other is NOT convergent. Each device records its own
 * local deletion time, so when two devices delete the same profile
 * independently, `{...remote, ...local}` makes each one overwrite the other's
 * value with its own — forever, at one meta write per cycle per device. `max` is
 * commutative, associative and idempotent, so both sides compute the same answer
 * and stop. It also matches the last-write-wins rule used for profiles, and
 * favours the more recent statement that something was deleted.
 */
function mergeTombstones(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [id, at] of Object.entries(b)) {
    out[id] = Math.max(out[id] ?? 0, at);
  }
  return out;
}

function pruneTombstones(tombstones: Record<string, number>, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(tombstones)) {
    if (now - at < TOMBSTONE_TTL_MS) out[id] = at;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

type Action =
  | { kind: 'push'; profile: Profile }
  | { kind: 'pull'; item: SyncProfileItem; conflict: boolean }
  | { kind: 'delete-local' }
  | { kind: 'delete-remote' }
  | { kind: 'noop' };

/**
 * Decide the fate of a single profile id. Kept separate from the plan assembly
 * so the decision table is readable in one screen.
 */
function decide(
  local: Profile | undefined,
  remote: SyncProfileItem | undefined,
  entry: SyncEntry | undefined,
  remoteTombstone: number | undefined,
  localTombstone: number | undefined,
): Action {
  const dirtiedAt = entry?.dirtiedAt;
  const locallyDirty = local !== undefined && (entry === undefined || dirtiedAt !== undefined);
  const syncedAt = entry?.syncedAt ?? 0;

  if (local && remote) {
    const remoteNewer = remote.updatedAt > syncedAt;
    if (!locallyDirty) {
      return remoteNewer ? { kind: 'pull', item: remote, conflict: false } : { kind: 'noop' };
    }
    if (!remoteNewer) return { kind: 'push', profile: local };
    // Both sides moved since the last sync point: last write wins.
    return remote.updatedAt > (dirtiedAt ?? 0)
      ? { kind: 'pull', item: remote, conflict: true }
      : { kind: 'push', profile: local };
  }

  if (local && !remote) {
    if (remoteTombstone !== undefined) {
      // Another device deleted it. Keep it only if we edited it since.
      return locallyDirty && (dirtiedAt ?? 0) > remoteTombstone
        ? { kind: 'push', profile: local }
        : { kind: 'delete-local' };
    }
    return { kind: 'push', profile: local };
  }

  if (!local && remote) {
    if (localTombstone !== undefined) {
      // We deleted it. A newer remote edit resurrects it here.
      return remote.updatedAt > localTombstone
        ? { kind: 'pull', item: remote, conflict: false }
        : { kind: 'delete-remote' };
    }
    return { kind: 'pull', item: remote, conflict: false };
  }

  return { kind: 'noop' };
}

/**
 * Compute the replication plan. Pure: no storage access, no clock, no randomness.
 *
 * The caller must commit `nextState` only after the writes succeed — on partial
 * failure it should discard the plan, leaving the dirty flags in place so the
 * next cycle recomputes from an unchanged sync point.
 */
export function reconcile(input: ReconcileInput): SyncPlan {
  const { local, remote, now, mergeMode = 'merge' } = input;

  // Refuse to touch an area written by a newer wire format rather than mangle it.
  if (remote.meta && remote.meta.v > SYNC_VERSION) {
    return {
      push: [],
      removeKeys: [],
      meta: null,
      settings: null,
      localSchema: null,
      nextState: input.state,
      skipped: [],
      conflicts: [],
      projectedBytes: 0,
      blocked: `This browser's sync data was written by a newer version of HTTPatch (format ${remote.meta.v}). Update the extension to sync again.`,
    };
  }

  const firstRun = !input.state.initialized;
  const state = observeLocal(local, input.state, now);
  const nextState = cloneState(state);
  nextState.tombstones = pruneTombstones(nextState.tombstones, now);

  const remoteTombstones = pruneTombstones(remote.meta?.tombstones ?? {}, now);

  const ids = new Set<string>([
    ...local.profiles.map((p) => p.id),
    ...Object.keys(remote.profiles),
    ...Object.keys(remoteTombstones),
    ...Object.keys(nextState.tombstones),
  ]);

  const localById = new Map(local.profiles.map((p) => [p.id, p]));
  const pushes: Profile[] = [];
  const pulls: SyncProfileItem[] = [];
  const deleteLocal = new Set<string>();
  const removeKeys: string[] = [];
  const conflicts: string[] = [];

  for (const id of ids) {
    const localProfile = localById.get(id);
    const remoteItem = remote.profiles[id];

    // A first sync with an explicit one-sided choice bypasses the merge table.
    if (firstRun && mergeMode === 'keep-local') {
      if (localProfile) pushes.push(localProfile);
      else if (remoteItem) removeKeys.push(profileKey(id));
      continue;
    }
    if (firstRun && mergeMode === 'keep-remote') {
      if (remoteItem) pulls.push(remoteItem);
      else if (localProfile) deleteLocal.add(id);
      continue;
    }
    // Same id on both sides, on a first run: the published revision wins, for the
    // same reason the theme does. A never-synced device has no sync point, so
    // observeLocal marks it dirty at `now`, which would beat any remote
    // `updatedAt` under last-write-wins and let a fresh device silently overwrite
    // an established one. Only flagged as a conflict when the content actually
    // differs, so re-enabling sync over an identical copy stays quiet.
    if (firstRun && localProfile && remoteItem) {
      pulls.push(remoteItem);
      if (hashProfile(localProfile) !== hashProfile(remoteItem.profile)) {
        conflicts.push(localProfile.name);
      }
      continue;
    }

    const action = decide(
      localProfile,
      remoteItem,
      nextState.entries[id],
      remoteTombstones[id],
      nextState.tombstones[id],
    );

    switch (action.kind) {
      case 'push':
        pushes.push(action.profile);
        break;
      case 'pull':
        pulls.push(action.item);
        // Only a *foreign* edit is worth telling the user about. After a partly
        // failed push we discard nextState, so the next cycle sees our own
        // just-written revision as newer than our sync point while the profile is
        // still marked dirty — which looks exactly like a conflict and would
        // claim "another device replaced your copy" about this very device.
        if (action.conflict && localProfile && action.item.deviceId !== nextState.deviceId) {
          conflicts.push(localProfile.name);
        }
        break;
      case 'delete-local':
        deleteLocal.add(id);
        break;
      case 'delete-remote':
        removeKeys.push(profileKey(id));
        break;
      case 'noop':
        break;
    }
  }

  // ---- size budgeting -----------------------------------------------------
  // Start from what stays in the area, then admit pushes in local order until
  // the total quota is reached, so an oversized tail cannot starve everything.
  //
  // Every surviving remote item counts, including ones a push is about to
  // replace: a push that then gets skipped leaves the older revision sitting in
  // the area, and pre-excluding it made the budget too optimistic. Each admitted
  // push adds only its delta over the revision it replaces.
  const removedKeys = new Set(removeKeys);
  let projectedBytes = 0;
  for (const [id, item] of Object.entries(remote.profiles)) {
    const key = profileKey(id);
    if (removedKeys.has(key)) continue;
    projectedBytes += itemBytes(key, item);
  }
  // The meta and settings items occupy the same 100 KB budget, so they belong in
  // the baseline even when this cycle leaves them untouched. Omitting them made
  // the budget over-optimistic, which let a push through that the platform then
  // rejected outright — reported as "sync storage is full" instead of the
  // profile being cleanly listed as skipped. Whichever of the two is rewritten
  // below has the delta applied then, so nothing is double-counted.
  const existingMetaBytes = remote.meta ? itemBytes(SYNC_META_KEY, remote.meta) : 0;
  const existingSettingsBytes = remote.settings ? itemBytes(SYNC_SETTINGS_KEY, remote.settings) : 0;
  projectedBytes += existingMetaBytes + existingSettingsBytes;

  const skipped: SyncSkip[] = [];
  const push: Array<{ key: string; item: SyncProfileItem }> = [];
  for (const profile of pushes) {
    const key = profileKey(profile.id);
    const item: SyncProfileItem = {
      v: SYNC_VERSION,
      profile,
      updatedAt: now,
      deviceId: nextState.deviceId,
    };
    const bytes = itemBytes(key, item);
    if (bytes > QUOTA_BYTES_PER_ITEM) {
      skipped.push({
        profileId: profile.id,
        profileName: profile.name,
        reason: 'too-large',
        bytes,
      });
      continue;
    }
    // Replacing an existing revision only costs the difference.
    const existing = remote.profiles[profile.id];
    const delta = bytes - (existing ? itemBytes(key, existing) : 0);
    if (projectedBytes + delta > QUOTA_BYTES) {
      skipped.push({ profileId: profile.id, profileName: profile.name, reason: 'quota', bytes });
      continue;
    }
    projectedBytes += delta;
    push.push({ key, item });
  }

  // ---- merged local schema ------------------------------------------------
  // Ordering has to CONVERGE, not just merge. Profile order is not cosmetic here:
  // the compiler gives each profile its own ascending priority band, so order
  // decides which profile wins a header conflict. And deriving the published
  // order from each device's own local order made it non-convergent — two devices
  // that each contributed a profile held permanently different orders, so both
  // saw `orderChanged` forever and rewrote the sync meta item at each other for as long
  // as the browser was open, burning the sync write quota.
  //
  // So: adopt the published order for every id it mentions, then append the ids
  // it does not (in this device's current order). Both devices compute this from
  // the same remote snapshot, so after one exchange they agree and go quiet.
  const pulledById = new Map(pulls.map((item) => [item.profile.id, item.profile]));
  const kept = local.profiles
    .filter((p) => !deleteLocal.has(p.id))
    .map((p) => pulledById.get(p.id) ?? p);
  const keptIds = new Set(kept.map((p) => p.id));
  const incoming = [...pulledById.values()].filter((p) => !keptIds.has(p.id));

  const byId = new Map([...kept, ...incoming].map((p) => [p.id, p]));
  const remoteOrder = remote.meta?.order ?? [];
  const adopted = remoteOrder.filter((id) => byId.has(id));
  const adoptedIds = new Set(adopted);
  const appended = [...kept, ...incoming].map((p) => p.id).filter((id) => !adoptedIds.has(id));
  const order = [...adopted, ...appended];
  const profiles = order.map((id) => byId.get(id)!);

  // The order we PUBLISH may only name ids that actually exist in the sync area.
  // A profile that cannot be published — over the 8 KB item limit, or skipped
  // because the area is full — is in the local order but has no item, so a peer
  // strips it when adopting and this device re-appends it: the same
  // non-convergent loop as before, one door along. Ids already in the area count,
  // not just this cycle's pushes, or a skipped profile whose older revision is
  // still published would be dropped from the order.
  const syncedIds = new Set<string>();
  for (const id of Object.keys(remote.profiles)) {
    if (!removedKeys.has(profileKey(id))) syncedIds.add(id);
  }
  for (const { item } of push) syncedIds.add(item.profile.id);
  const publishedOrder = order.filter((id) => syncedIds.has(id));

  // A pure reorder still has to be persisted, or this device would recompute the
  // same adoption every cycle and never actually settle.
  const localOrderChanged =
    local.profiles.length !== profiles.length ||
    local.profiles.some((p, i) => profiles[i]?.id !== p.id);

  // ---- settings (theme only) ---------------------------------------------
  let theme = local.settings.theme;
  let settingsItem: SyncSettingsItem | null = null;
  const settingsEntry = nextState.settings;
  const remoteSettings = remote.settings;
  const settingsDirty = settingsEntry?.dirtiedAt !== undefined;
  const pushSettings = (): SyncSettingsItem => ({
    v: SYNC_VERSION,
    theme,
    updatedAt: now,
    deviceId: nextState.deviceId,
  });

  if (firstRun) {
    // Settings are a single shared value, so unlike profiles both sides always
    // look "changed" on a first run — a never-synced device is dirty by
    // definition, and its `dirtiedAt` is always later than the remote's
    // `updatedAt`. Running that through last-write-wins would let any fresh
    // device silently overwrite an established device's theme. So on a first
    // run an existing synced choice wins, because this device has no real edit
    // to defend; `keep-local` is the explicit opt-out.
    if (mergeMode === 'keep-local' || !remoteSettings) {
      settingsItem = pushSettings();
    } else {
      theme = remoteSettings.theme;
    }
  } else if (remoteSettings && remoteSettings.updatedAt > (settingsEntry?.syncedAt ?? 0)) {
    if (!settingsDirty || remoteSettings.updatedAt > (settingsEntry?.dirtiedAt ?? 0)) {
      theme = remoteSettings.theme;
    } else {
      settingsItem = { v: SYNC_VERSION, theme, updatedAt: now, deviceId: nextState.deviceId };
    }
  } else if (settingsDirty) {
    settingsItem = { v: SYNC_VERSION, theme, updatedAt: now, deviceId: nextState.deviceId };
  }

  if (settingsItem) {
    nextState.settings = { syncedHash: hashTheme(theme), syncedAt: now };
  } else if (remoteSettings && theme === remoteSettings.theme) {
    nextState.settings = { syncedHash: hashTheme(theme), syncedAt: remoteSettings.updatedAt };
  }

  // ---- state bookkeeping --------------------------------------------------
  for (const { item } of push) {
    nextState.entries[item.profile.id] = {
      syncedHash: hashProfile(item.profile),
      syncedAt: item.updatedAt,
    };
  }
  for (const item of pulls) {
    nextState.entries[item.profile.id] = {
      syncedHash: hashProfile(item.profile),
      syncedAt: item.updatedAt,
    };
  }
  for (const id of deleteLocal) {
    delete nextState.entries[id];
    // Deleted because a peer said so — no need to re-announce it.
    delete nextState.tombstones[id];
  }
  for (const key of removeKeys) {
    const id = key.slice(SYNC_PROFILE_PREFIX.length);
    delete nextState.entries[id];
    if (nextState.tombstones[id] === undefined) nextState.tombstones[id] = now;
  }
  nextState.initialized = true;
  nextState.lastSyncedAt = now;
  delete nextState.lastError;

  // ---- meta ---------------------------------------------------------------
  const mergedTombstones = pruneTombstones(
    mergeTombstones(remoteTombstones, nextState.tombstones),
    now,
  );
  const orderChanged =
    stableStringify(publishedOrder) !== stableStringify(remote.meta?.order ?? []);
  const tombstonesChanged =
    stableStringify(mergedTombstones) !== stableStringify(remote.meta?.tombstones ?? {});
  const meta: SyncMetaItem | null =
    orderChanged || tombstonesChanged || !remote.meta
      ? {
          v: SYNC_VERSION,
          order: publishedOrder,
          tombstones: mergedTombstones,
          updatedAt: now,
          deviceId: nextState.deviceId,
        }
      : null;
  // Deltas, not additions: the pre-existing sizes are already in the baseline.
  if (meta) projectedBytes += itemBytes(SYNC_META_KEY, meta) - existingMetaBytes;
  if (settingsItem) {
    projectedBytes += itemBytes(SYNC_SETTINGS_KEY, settingsItem) - existingSettingsBytes;
  }

  const localChanged =
    pulls.length > 0 || deleteLocal.size > 0 || theme !== local.settings.theme || localOrderChanged;
  const localSchema: StorageSchema | null = localChanged
    ? {
        version: SCHEMA_VERSION,
        profiles,
        settings: { ...local.settings, theme },
      }
    : null;

  return {
    push,
    removeKeys,
    meta,
    settings: settingsItem,
    localSchema,
    nextState,
    skipped,
    conflicts,
    projectedBytes,
  };
}

/**
 * Flatten the outward-bound half of a plan into the key/value map the storage
 * adapter writes. Pure, so the adapter stays a dumb transport.
 */
export function planToItems(plan: SyncPlan): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  for (const { key, item } of plan.push) items[key] = item;
  if (plan.meta) items[SYNC_META_KEY] = plan.meta;
  if (plan.settings) items[SYNC_SETTINGS_KEY] = plan.settings;
  return items;
}

/** True when the plan would not change anything on either side. */
export function isNoopPlan(plan: SyncPlan): boolean {
  return (
    plan.push.length === 0 &&
    plan.removeKeys.length === 0 &&
    plan.meta === null &&
    plan.settings === null &&
    plan.localSchema === null
  );
}
