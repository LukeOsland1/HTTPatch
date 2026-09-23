// Typed message contract between the UI (popup/options) and the service worker.
// The UI mutates chrome.storage and then asks the worker to recompile + apply,
// so live rule state never lives only in the (non-persistent) worker memory.
//
// Sync replication is driven from the worker too — the UI only asks for it and
// reads back status, so there is never more than one context reconciling.

import type { CompileWarning } from '@/core/compiler';
import type { LimitReport } from '@/core/limits';
import type { MergeMode, SyncSkip } from '@/core/sync';
import type { SyncSnapshot } from '@/core/sync-runner';

export type Message =
  | { type: 'apply' } // recompile from storage and push to DNR
  | { type: 'get-status' } // read current apply status
  | { type: 'assign-tab'; profileId: string; tabId: number | null }
  | { type: 'sync-now'; mergeMode?: MergeMode } // run one replication cycle
  | { type: 'sync-status' } // read sync status without reconciling
  | { type: 'sync-clear' }; // delete the copy in the browser account's sync data

export interface ApplyStatus {
  applied: boolean;
  paused: boolean;
  ruleCount: number;
  warnings: CompileWarning[];
  limits: LimitReport | null;
  error?: string;
}

/** Sync status for the options UI: the persisted snapshot plus last-cycle results. */
export interface SyncStatus extends SyncSnapshot {
  skipped: SyncSkip[];
  conflicts: string[];
}

function send<T>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export function sendMessage(message: Message): Promise<ApplyStatus> {
  return send<ApplyStatus>(message);
}

/** Ask the service worker to recompile and apply the current stored schema. */
export function requestApply(): Promise<ApplyStatus> {
  return send<ApplyStatus>({ type: 'apply' });
}

/** Read the current apply status without forcing a recompile + DNR rewrite. */
export function requestStatus(): Promise<ApplyStatus> {
  return send<ApplyStatus>({ type: 'get-status' });
}

/** Bind or unbind a tab-only profile on this device and reapply session rules. */
export function requestAssignTab(profileId: string, tabId: number | null): Promise<ApplyStatus> {
  return send<ApplyStatus>({ type: 'assign-tab', profileId, tabId });
}

/**
 * Run one replication cycle. `mergeMode` only matters on a device's first sync,
 * where it decides between merging the two sides and letting one win.
 */
export function requestSync(mergeMode?: MergeMode): Promise<SyncStatus> {
  return send<SyncStatus>({ type: 'sync-now', mergeMode });
}

/** Read sync status. Never writes to either storage area. */
export function requestSyncStatus(): Promise<SyncStatus> {
  return send<SyncStatus>({ type: 'sync-status' });
}

/** Remove this extension's synced copy. Local profiles are left alone. */
export function requestSyncClear(): Promise<SyncStatus> {
  return send<SyncStatus>({ type: 'sync-clear' });
}
