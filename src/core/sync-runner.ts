// Orchestrates one replication cycle: read both sides, ask the pure engine for a
// plan, apply it, then commit this device's bookkeeping.
//
// This module is browser-free by construction — it only reaches the platform
// through `@/core/storage` and `@/core/sync-area`, both of which the Firefox
// build swaps via resolve.alias. Note the `@/core/...` specifiers: a relative
// `./storage` import would bypass those aliases and drag chrome.* into the
// Firefox bundle.
//
// The background script owns sync, not the UI: the worker is woken by the
// `apply` message the UI already sends after every save, so pushes still happen
// with no view open, and there is only ever one context reconciling.

import { load, save } from '@/core/storage';
import {
  clearRemote,
  getBytesInUse,
  isSyncAvailable,
  listOwnedRemoteKeys,
  loadSyncState,
  readRemote,
  saveSyncState,
  writeRemote,
} from '@/core/sync-area';
import {
  QUOTA_BYTES,
  SYNC_META_KEY,
  SYNC_SETTINGS_KEY,
  isNoopPlan,
  newSyncState,
  planToItems,
  profileKey,
  type MergeMode,
  type SyncSkip,
  reconcile,
} from './sync';

export interface SyncOutcome {
  /** False when sync is off or unavailable — not an error. */
  ran: boolean;
  /** True when local storage changed, so the caller must recompile DNR rules. */
  localChanged: boolean;
  skipped: SyncSkip[];
  conflicts: string[];
  bytesInUse: number | null;
  lastSyncedAt?: number;
  error?: string;
}

const IDLE: SyncOutcome = {
  ran: false,
  localChanged: false,
  skipped: [],
  conflicts: [],
  bytesInUse: null,
};

/**
 * Serializes cycles. A remote change arriving mid-push, or a push racing the
 * periodic alarm, would otherwise interleave reads and writes and could commit
 * bookkeeping that does not match what was actually written.
 */
let inFlight: Promise<SyncOutcome> = Promise.resolve(IDLE);

export function runSync(opts: { mergeMode?: MergeMode; now?: number } = {}): Promise<SyncOutcome> {
  const next = inFlight.catch(() => IDLE).then(() => cycle(opts));
  // Keep the chain alive even if this cycle rejects.
  inFlight = next.catch(() => IDLE);
  return next;
}

async function cycle(opts: { mergeMode?: MergeMode; now?: number }): Promise<SyncOutcome> {
  const schema = await load();
  if (!schema.settings.syncEnabled) return IDLE;
  if (!isSyncAvailable()) {
    return { ...IDLE, error: 'This browser does not have a usable sync area.' };
  }

  const now = opts.now ?? Date.now();
  const state = await loadSyncState();

  let remote;
  try {
    remote = await readRemote();
  } catch (err) {
    return { ...IDLE, error: err instanceof Error ? err.message : String(err) };
  }

  const plan = reconcile({ local: schema, remote, state, now, mergeMode: opts.mergeMode });

  if (plan.blocked) {
    await saveSyncState({ ...state, lastError: plan.blocked });
    return { ...IDLE, error: plan.blocked };
  }

  if (isNoopPlan(plan)) {
    // Still record the successful round trip so the UI can show a fresh timestamp.
    await saveSyncState(plan.nextState);
    return {
      ran: true,
      localChanged: false,
      skipped: plan.skipped,
      conflicts: plan.conflicts,
      bytesInUse: await getBytesInUse(),
      lastSyncedAt: plan.nextState.lastSyncedAt,
    };
  }

  const outcome = await writeRemote(planToItems(plan), plan.removeKeys);
  if (!outcome.ok) {
    // Deliberately do NOT commit nextState: leaving the dirty flags in place
    // means the next cycle recomputes from an unchanged sync point and retries.
    await saveSyncState({ ...state, lastError: outcome.error });
    return { ...IDLE, error: outcome.error, bytesInUse: await getBytesInUse() };
  }

  // Pulls are applied to local storage only after the outward write succeeded,
  // so a half-failed cycle never leaves local and remote disagreeing about what
  // this device has already seen.
  if (plan.localSchema) {
    // Re-read first. `plan.localSchema` is a whole-schema snapshot taken before
    // the outward write, and that write talks to the browser's sync area, so it
    // can take a while. The UI also writes the whole schema. Saving the stale
    // snapshot would silently discard any edit the user made in between —
    // exactly the kind of loss that looks like the extension eating your work.
    //
    // Key order is deterministic here because both values come from migrate(),
    // so a string compare is a sound identity check.
    const current = await load();
    if (JSON.stringify(current) !== JSON.stringify(schema)) {
      // Local moved under us. Abandon the whole plan, including nextState, so the
      // next cycle recomputes against the new local state. The outward writes
      // were this device's own content, so repeating them is idempotent.
      return {
        ran: true,
        localChanged: false,
        skipped: plan.skipped,
        conflicts: [],
        bytesInUse: await getBytesInUse(),
        lastSyncedAt: state.lastSyncedAt,
      };
    }
    await save(plan.localSchema);
  }
  await saveSyncState(plan.nextState);

  return {
    ran: true,
    localChanged: plan.localSchema !== null,
    skipped: plan.skipped,
    conflicts: plan.conflicts,
    bytesInUse: await getBytesInUse(),
    lastSyncedAt: plan.nextState.lastSyncedAt,
  };
}

/** Every sync key this extension owns, for a clean opt-out. */
export function ownedKeys(profileIds: string[]): string[] {
  return [SYNC_META_KEY, SYNC_SETTINGS_KEY, ...profileIds.map(profileKey)];
}

/**
 * Delete this extension's copy in the browser account's sync data and forget the
 * local sync point. Local profiles are untouched — opting out must never cost
 * the user their profiles. Offered because the synced items contain header
 * values, so "stop syncing" should be able to mean "and remove what is up there".
 */
export async function clearSync(): Promise<void> {
  const state = await loadSyncState();
  let keys: string[];
  try {
    keys = await listOwnedRemoteKeys();
  } catch {
    // Fall back to the ids we know about locally.
    keys = ownedKeys(Object.keys(state.entries));
  }
  if (keys.length > 0) await clearRemote(keys);
  await saveSyncState(newSyncState(state.deviceId));
}

export interface SyncSnapshot {
  enabled: boolean;
  available: boolean;
  firstRun: boolean;
  remoteProfileCount: number;
  bytesInUse: number | null;
  quotaBytes: number;
  lastSyncedAt?: number;
  lastError?: string;
}

/**
 * Status view for the options UI. It does not reconcile profiles, though it
 * may perform a one-time storage-key transfer on an upgraded installation.
 */
export async function readSyncSnapshot(): Promise<SyncSnapshot> {
  const schema = await load();
  const available = isSyncAvailable();
  const base: SyncSnapshot = {
    enabled: schema.settings.syncEnabled,
    available,
    firstRun: true,
    remoteProfileCount: 0,
    bytesInUse: null,
    quotaBytes: QUOTA_BYTES,
  };
  if (!available) return base;

  const state = await loadSyncState();
  base.firstRun = !state.initialized;
  base.lastSyncedAt = state.lastSyncedAt;
  base.lastError = state.lastError;

  try {
    const remote = await readRemote();
    base.remoteProfileCount = Object.keys(remote.profiles).length;
    base.bytesInUse = await getBytesInUse();
  } catch {
    // A readable snapshot is best-effort; the counts simply stay at zero.
  }
  return base;
}
