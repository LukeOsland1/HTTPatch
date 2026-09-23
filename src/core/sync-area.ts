// The sole boundary to chrome.storage.sync (plus the local key holding this
// device's sync bookkeeping). All decisions live in the pure engine in sync.ts;
// this module is a dumb transport that also normalizes the platform's error
// vocabulary into something the UI can show a human.
//
// Every function here is failure-tolerant on purpose: sync is a replication
// layer, so an unavailable or policy-disabled sync area must degrade to "sync
// off", never break the local storage path that actually drives DNR.

import { newId } from './id';
import { isOwnedSyncKey, previousLocalEntry, transferLegacySyncItems } from './storage-compat';
import {
  SYNC_STATE_KEY,
  coerceSyncState,
  parseRemote,
  type RemoteSnapshot,
  type SyncState,
} from './sync';

/**
 * Whether this browser exposes a usable sync area. Enterprise policy can
 * disable sync outright, in which case the namespace may be missing.
 */
export function isSyncAvailable(): boolean {
  return typeof chrome !== 'undefined' && chrome.storage?.sync !== undefined;
}

/** Read and validate the entire sync area. */
export async function readRemote(): Promise<RemoteSnapshot> {
  const raw = (await chrome.storage.sync.get(null)) as Record<string, unknown>;
  return parseRemote(await transferLegacySyncItems(raw, chrome.storage.sync));
}

export interface WriteOutcome {
  ok: boolean;
  /** Human-readable failure, already mapped off the platform's error strings. */
  error?: string;
  /** Keys that individually failed when the batch was retried item by item. */
  failedKeys?: string[];
}

/**
 * Translate a storage rejection into something worth showing a user. The
 * platform reports quota problems only as an error string, so matching on it is
 * unavoidable.
 */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/QUOTA_BYTES_PER_ITEM/i.test(message)) {
    return 'A profile is too large to sync (the per-item limit is 8 KB).';
  }
  if (/QUOTA_BYTES/i.test(message)) {
    return 'Sync storage is full (the limit is 100 KB). Delete or shrink a profile to sync again.';
  }
  if (/MAX_WRITE_OPERATIONS|WRITE_OPERATIONS_PER/i.test(message)) {
    return 'Too many sync writes for now — this will retry automatically shortly.';
  }
  if (/MAX_ITEMS/i.test(message)) {
    return 'Too many profiles to sync (the limit is 512 items).';
  }
  return message;
}

/**
 * Apply the outward half of a plan. Writes are batched so the whole push costs
 * one write operation against the hourly quota; if the batch is rejected we
 * retry item by item purely to identify the culprit, since a batch failure is
 * otherwise silent about which profile caused it.
 */
export async function writeRemote(
  items: Record<string, unknown>,
  removeKeys: string[],
): Promise<WriteOutcome> {
  // Removals are attempted separately so a failure here cannot be masked by the
  // item-by-item retry below, which only ever re-sends `items`. Reporting ok
  // would let the caller commit bookkeeping that records the deletions as
  // propagated when they are still sitting in the area.
  try {
    if (removeKeys.length > 0) await chrome.storage.sync.remove(removeKeys);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  try {
    if (Object.keys(items).length > 0) await chrome.storage.sync.set(items);
    return { ok: true };
  } catch (err) {
    const failedKeys: string[] = [];
    for (const [key, value] of Object.entries(items)) {
      try {
        await chrome.storage.sync.set({ [key]: value });
      } catch {
        failedKeys.push(key);
      }
    }
    return failedKeys.length === 0
      ? { ok: true }
      : { ok: false, error: describeError(err), failedKeys };
  }
}

/** Remove every HTTPatch key from the sync area (used when opting out). */
export async function clearRemote(keys: string[]): Promise<void> {
  await chrome.storage.sync.remove(keys);
}

export async function listOwnedRemoteKeys(): Promise<string[]> {
  const raw = (await chrome.storage.sync.get(null)) as Record<string, unknown>;
  return Object.keys(raw).filter(isOwnedSyncKey);
}

/** Bytes currently used in the sync area, or null when unsupported. */
export async function getBytesInUse(): Promise<number | null> {
  try {
    return await chrome.storage.sync.getBytesInUse(null);
  } catch {
    return null;
  }
}

// --- device-local bookkeeping (lives in storage.local, never synced) --------

export async function loadSyncState(): Promise<SyncState> {
  const result = await chrome.storage.local.get(null);
  const previous = previousLocalEntry(result, SYNC_STATE_KEY, 'sync-state');
  if (result[SYNC_STATE_KEY] !== undefined) {
    if (previous) await chrome.storage.local.remove(previous[0]).catch(() => {});
    return coerceSyncState(result[SYNC_STATE_KEY], newId);
  }
  if (!previous) return coerceSyncState(undefined, newId);
  const state = coerceSyncState(previous[1], newId);
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: state });
  await chrome.storage.local.remove(previous[0]).catch(() => {});
  return state;
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: state });
}
