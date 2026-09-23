// The only long-lived DNR controller. It is a non-persistent MV3 service worker,
// so it keeps NO live rule state in memory: it rehydrates from chrome.storage on
// install/startup, and re-applies whenever the UI signals a change.

import type { StorageSchema } from '@/core/types';
import { load } from '@/core/storage';
import { applySchema, type ApplyResult } from '@/core/apply';
import { clearSync, readSyncSnapshot, runSync } from '@/core/sync-runner';
import { DEFAULT_BADGE_COLOR } from '@/core/constants';
import { loadTabAssignments, saveTabAssignments } from '@/core/tab-assignments';
import type { ApplyStatus, Message, SyncStatus } from '@/messaging/messages';
import type { SyncSkip } from '@/core/sync';

let lastResult: ApplyResult | null = null;
let reapplyQueue: Promise<void> = Promise.resolve();

function reapply(): Promise<ApplyResult> {
  // Keep rule-set rewrites ordered. A delayed edit apply must not overwrite a
  // newer tab assignment with a stale dynamic/session split.
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
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
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
// The worker owns replication so it happens with no view open and only one
// context ever reconciles. Sync is never in the apply path: a failed cycle is
// recorded and surfaced in the options UI, and rules carry on unaffected.

/** Floor between outward writes, well inside sync's 120-writes-per-minute cap. */
const SYNC_MIN_INTERVAL_MS = 10_000;
const SYNC_ALARM = 'httpatch-sync';
const SYNC_BACKSTOP_ALARM = 'httpatch-sync-backstop';

let lastSyncAt = 0;
let trailingSync: ReturnType<typeof setTimeout> | null = null;

async function syncNow(mergeMode?: 'merge' | 'keep-local' | 'keep-remote') {
  lastSyncAt = Date.now();
  const outcome = await runSync({ mergeMode });
  // A pull changed local storage, so the compiled rules are now stale.
  if (outcome.localChanged) reapplyWithRetry();
  return outcome;
}

/**
 * Coalesce edit bursts into one outward write. The setTimeout is the fast path;
 * the alarm is the durable one, because a non-persistent worker can be killed
 * before the timer fires.
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
  chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM && alarm.name !== SYNC_BACKSTOP_ALARM) return;
  void syncNow().catch((err) => console.error('HTTPatch: sync failed', err));
});

// Pull profiles another device pushed. Routed through the same throttle as
// local edits, NOT straight into syncNow(): if a cycle ever writes something a
// peer does not converge on, each side's write wakes the other and the pair
// ping-pongs with no user activity, burning the sync write quota. Ordering was
// exactly that bug; the floor keeps any future recurrence slow and visible
// rather than instant and quota-exhausting.
chrome.storage.onChanged.addListener((_changes, area) => {
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
// Chrome persists dynamic rules across updates/restarts, so if this rehydrating
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
  void syncNow().catch((err) => console.error('HTTPatch: sync failed', err));
  chrome.alarms.create(SYNC_BACKSTOP_ALARM, { periodInMinutes: 30 });
}

chrome.runtime.onInstalled.addListener(reapplyThenSync);
chrome.runtime.onStartup.addListener(reapplyThenSync);

chrome.tabs.onRemoved.addListener((tabId) => {
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

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse: (r: ApplyStatus | SyncStatus) => void) => {
    (async () => {
      try {
        if (message.type === 'sync-now') {
          const outcome = await syncNow(message.mergeMode);
          sendResponse(
            await syncStatus({ skipped: outcome.skipped, conflicts: outcome.conflicts }),
          );
          return;
        }
        if (message.type === 'sync-status') {
          sendResponse(await syncStatus());
          return;
        }
        if (message.type === 'sync-clear') {
          await clearSync();
          sendResponse(await syncStatus());
          return;
        }
        if (message.type === 'apply') {
          const result = await reapply();
          const schema = await load();
          sendResponse(toStatus(schema, result));
          // A local edit just landed, so mirror it outward (throttled).
          scheduleSync();
          return;
        }
        if (message.type === 'assign-tab') {
          const schema = await load();
          const profile = schema.profiles.find((p) => p.id === message.profileId);
          if (!profile?.tabOnly && message.tabId !== null)
            throw new Error('Enable tab-only mode before assigning a tab.');
          if (message.tabId !== null) {
            if (!Number.isSafeInteger(message.tabId) || message.tabId < 0)
              throw new Error('Invalid tab ID.');
            await chrome.tabs.get(message.tabId);
          }
          const assignments = await loadTabAssignments();
          if (message.tabId === null) delete assignments[message.profileId];
          else assignments[message.profileId] = message.tabId;
          await saveTabAssignments(assignments);
          const result = await reapply();
          sendResponse(toStatus(schema, result));
          return;
        }
        // get-status
        const schema = await load();
        const result = lastResult ?? (await reapply());
        sendResponse(toStatus(schema, result));
      } catch (err) {
        // Always respond, so the caller's promise never hangs / rejects with a
        // "channel closed" error and the UI can surface the failure.
        console.error('HTTPatch: message handling failed', err);
        sendResponse({
          applied: false,
          paused: false,
          ruleCount: 0,
          warnings: [],
          limits: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true; // keep the message channel open for the async response
  },
);
