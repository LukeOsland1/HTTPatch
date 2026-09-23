// Firefox variant of src/messaging/messages.ts. Same typed contract between the
// UI and the background script, but sends over the promise-based
// `browser.runtime.sendMessage` (via webextension-polyfill). Wired in for the
// Firefox build via a Vite resolve alias so the shared UI that imports
// `@/messaging/messages` picks this up. The Chrome build is untouched.

import browser from 'webextension-polyfill';
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

async function send<T>(message: Message): Promise<T> {
  return (await browser.runtime.sendMessage(message)) as T;
}

export function sendMessage(message: Message): Promise<ApplyStatus> {
  return send<ApplyStatus>(message);
}

/** Ask the background script to recompile and apply the current stored schema. */
export function requestApply(): Promise<ApplyStatus> {
  return send<ApplyStatus>({ type: 'apply' });
}

/** Read the current apply status without forcing a recompile + DNR rewrite. */
export function requestStatus(): Promise<ApplyStatus> {
  return send<ApplyStatus>({ type: 'get-status' });
}

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
