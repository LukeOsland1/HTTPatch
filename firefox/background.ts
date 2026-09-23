// Firefox variant of src/background/service-worker.ts. Firefox MV3 runs a
// non-persistent background *event page* (background.scripts), not a service
// worker, so this is loaded as a module background script. Same design: keeps NO
// live rule state, rehydrates from storage on install/startup, and re-applies
// on demand when the UI signals a change. Uses the promise-based `browser.*`
// APIs and the promise reply pattern for onMessage.

import browser from 'webextension-polyfill';
import type { StorageSchema } from '@/core/types';
import { load } from './storage';
import { applySchema, type ApplyResult } from './apply';
import { clearSync, readSyncSnapshot, runSync } from '@/core/sync-runner';
import { DEFAULT_BADGE_COLOR } from '@/core/constants';
import { loadTabAssignments, saveTabAssignments } from './tab-assignments';
import type { ApplyStatus, Message, SyncStatus } from './messages';
import type { SyncSkip } from '@/core/sync';

let lastResult: ApplyResult | null = null;
let reapplyQueue: Promise<void> = Promise.resolve();

function reapply(): Promise<ApplyResult> {
  const run = reapplyQueue.then(async () => {
    const schema = await load();
    const assignments = await loadTabAssignments();
    const result = await applySchema(schema, assignments);
    lastResult = result;
    await updateBadge(schema, result, assignments);
    return result;
  });
  reapplyQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Reflect the active-profile color/text (or a paused/error state) on the toolbar. */
async function updateBadge(
  schema: StorageSchema,
  result: ApplyResult,
  assignments: Readonly<Record<string, number>>,
): Promise<void> {
  if (schema.settings.paused) {
    await setBadge('❚❚', '#6b7280');
    return;
  }
  if (!result.applied) {
    await setBadge('!', '#dc2626');
    return;
  }

  const enabled = schema.profiles.filter(
    (p) => p.enabled && (!p.tabOnly || assignments[p.id] !== undefined),
  );
  if (enabled.length === 0) {
    await setBadge('', DEFAULT_BADGE_COLOR);
    return;
  }

  const active = enabled.find((p) => p.id === schema.settings.activeProfileId) ?? enabled[0];
  const text = active.badgeText?.trim() || (enabled.length > 1 ? String(enabled.length) : 'ON');
  await setBadge(text.slice(0, 4), active.color || DEFAULT_BADGE_COLOR);
}

async function setBadge(text: string, color: string): Promise<void> {
  await browser.action.setBadgeText({ text });
  await browser.action.setBadgeBackgroundColor({ color });
}

function toStatus(schema: StorageSchema, result: ApplyResult): ApplyStatus {
  return {
    applied: result.applied,
    paused: schema.settings.paused,
    ruleCount: result.ruleCount,
    warnings: result.compile.warnings,
    limits: result.limits,
    error: result.error,
  };
}

// --- sync replication -----------------------------------------------------
// Mirrors the Chrome worker: the background script owns replication, and a
// failed cycle never touches the apply path. Firefox's storage.sync additionally
// needs a signed add-on and a signed-in Firefox Account, so an unavailable sync
// area is an expected state here, not an error.

/** Floor between outward writes, well inside sync's write-rate cap. */
const SYNC_MIN_INTERVAL_MS = 10_000;
const SYNC_ALARM = 'httpatch-sync';
const SYNC_BACKSTOP_ALARM = 'httpatch-sync-backstop';

let lastSyncAt = 0;
let trailingSync: ReturnType<typeof setTimeout> | null = null;

async function syncNow(mergeMode?: 'merge' | 'keep-local' | 'keep-remote') {
  lastSyncAt = Date.now();
  const outcome = await runSync({ mergeMode });
  if (outcome.localChanged) reapplyWithRetry();
  return outcome;
}

/**
 * Coalesce edit bursts into one outward write. The setTimeout is the fast path;
 * the alarm is the durable one, since this is a non-persistent event page.
 */
function scheduleSync(): void {
  const elapsed = Date.now() - lastSyncAt;
  if (elapsed >= SYNC_MIN_INTERVAL_MS) {
    void syncNow().catch((err) => console.error('HTTPatch: sync failed', err));
    return;
  }
  if (!trailingSync) {
    trailingSync = setTimeout(() => {
      trailingSync = null;
      void syncNow().catch((err) => console.error('HTTPatch: sync failed', err));
    }, SYNC_MIN_INTERVAL_MS - elapsed);
  }
  browser.alarms.create(SYNC_ALARM, { delayInMinutes: 0.5 });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM && alarm.name !== SYNC_BACKSTOP_ALARM) return;
  void syncNow().catch((err) => console.error('HTTPatch: sync failed', err));
});

// Pull profiles another device pushed. Routed through the same throttle as
// local edits, NOT straight into syncNow(): if a cycle ever writes something a
// peer does not converge on, each side's write wakes the other and the pair
// ping-pongs with no user activity, burning the sync write quota. Ordering was
// exactly that bug; the floor keeps any future recurrence slow and visible
// rather than instant and quota-exhausting.
browser.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'sync') return;
  scheduleSync();
});

async function syncStatus(extra: { skipped?: SyncSkip[]; conflicts?: string[] } = {}) {
  const snapshot = await readSyncSnapshot();
  return {
    ...snapshot,
    skipped: extra.skipped ?? [],
    conflicts: extra.conflicts ?? [],
  } satisfies SyncStatus;
}

// --- lifecycle: rehydrate on install and browser startup -----------------
// Firefox persists dynamic rules across updates/restarts, so if this rehydrating
// apply fails the previous version's rules could linger. Retry with backoff and
// surface an error badge rather than swallowing the rejection.

function reapplyWithRetry(attempt = 0): void {
  reapply().catch((err) => {
    console.error('HTTPatch: reapply failed', err);
    void setBadge('!', '#dc2626');
    if (attempt < 3) {
      setTimeout(() => reapplyWithRetry(attempt + 1), 1000 * 2 ** attempt);
    }
  });
}

function reapplyThenSync(): void {
  reapplyWithRetry();
  // Catch up on anything other devices pushed while this browser was closed,
  // and register the periodic backstop for sync events we might miss.
  void syncNow().catch((err) => console.error('HTTPatch: sync failed', err));
  browser.alarms.create(SYNC_BACKSTOP_ALARM, { periodInMinutes: 30 });
}

// Sync needs no install-time hook: it is on by DEFAULT_SETTINGS, which covers
// both a fresh install and an upgrade from before the feature existed.
browser.runtime.onInstalled.addListener(() => reapplyThenSync());

browser.runtime.onStartup.addListener(() => reapplyThenSync());

browser.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const assignments = await loadTabAssignments();
    const next = Object.fromEntries(Object.entries(assignments).filter(([, id]) => id !== tabId));
    if (Object.keys(next).length === Object.keys(assignments).length) return;
    await saveTabAssignments(next);
    reapplyWithRetry();
  })().catch((err) => console.error('HTTPatch: tab scope cleanup failed', err));
});

// --- respond to UI requests ----------------------------------------------
// The UI writes storage then sends {type:'apply'}, so all rule updates flow
// through here — no storage.onChange listener needed (avoids double-applying).
// With webextension-polyfill, returning a Promise from the listener sends its
// resolved value as the response (no sendResponse / `return true` dance).

async function handleMessage(message: Message): Promise<ApplyStatus | SyncStatus> {
  try {
    if (message.type === 'sync-now') {
      const outcome = await syncNow(message.mergeMode);
      return await syncStatus({ skipped: outcome.skipped, conflicts: outcome.conflicts });
    }
    if (message.type === 'sync-status') {
      return await syncStatus();
    }
    if (message.type === 'sync-clear') {
      await clearSync();
      return await syncStatus();
    }
    if (message.type === 'apply') {
      const result = await reapply();
      const schema = await load();
      // A local edit just landed, so mirror it outward (throttled).
      scheduleSync();
      return toStatus(schema, result);
    }
    if (message.type === 'assign-tab') {
      const schema = await load();
      const profile = schema.profiles.find((p) => p.id === message.profileId);
      if (!profile?.tabOnly && message.tabId !== null)
        throw new Error('Enable tab-only mode before assigning a tab.');
      if (message.tabId !== null) {
        if (!Number.isSafeInteger(message.tabId) || message.tabId < 0)
          throw new Error('Invalid tab ID.');
        await browser.tabs.get(message.tabId);
      }
      const assignments = await loadTabAssignments();
      if (message.tabId === null) delete assignments[message.profileId];
      else assignments[message.profileId] = message.tabId;
      await saveTabAssignments(assignments);
      const result = await reapply();
      return toStatus(schema, result);
    }
    // get-status
    const schema = await load();
    const result = lastResult ?? (await reapply());
    return toStatus(schema, result);
  } catch (err) {
    // Always resolve, so the caller's promise never hangs / rejects with a
    // "channel closed" error and the UI can surface the failure.
    console.error('HTTPatch: message handling failed', err);
    return {
      applied: false,
      paused: false,
      ruleCount: 0,
      warnings: [],
      limits: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

browser.runtime.onMessage.addListener((message: unknown) => handleMessage(message as Message));
