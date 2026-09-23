// Single source of truth for HTTPatch's data model.
// These types describe what is persisted in chrome.storage.local and what the
// pure compiler consumes. Nothing here imports chrome.* so it stays testable.

export type HeaderTarget = 'request' | 'response';
export type HeaderOp = 'set' | 'append' | 'remove';

export interface HeaderRule {
  /** Stable UI identity (uuid). Not the DNR rule id. */
  id: string;
  enabled: boolean;
  target: HeaderTarget;
  operation: HeaderOp;
  /** Header name, e.g. "Authorization". Case-insensitive at match time. */
  name: string;
  /** Required for set/append; ignored for remove. */
  value?: string;
  /** Optional documentation note shown in the UI. */
  comment?: string;
  /** Optional structured editor for common header workflows. */
  editor?: 'request-cookie' | 'response-cookie' | 'csp';
}

export type FilterKind = 'wildcard' | 'regex';
export type FilterMode = 'include' | 'exclude';

export interface UrlFilter {
  kind: FilterKind;
  /** Wildcard urlFilter string (e.g. `||example.com^`, `*` + `/api/`) or an RE2 regex. */
  pattern: string;
  mode: FilterMode;
}

/** DNR resource types we expose in the UI. Mirrors chrome.declarativeNetRequest.ResourceType. */
export type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other';

export interface ProfileFilters {
  urlFilters: UrlFilter[];
  /** Empty means "all resource types". */
  resourceTypes: ResourceType[];
}

export interface Profile {
  id: string;
  name: string;
  enabled: boolean;
  /** Only apply on an assigned tab. The assignment is device/session-local. */
  tabOnly?: boolean;
  /** Badge background color (hex). */
  color?: string;
  /** Short badge text shown on the toolbar icon. */
  badgeText?: string;
  headers: HeaderRule[];
  filters: ProfileFilters;
}

export interface Settings {
  /** Global kill switch — when true, no rules are applied (storage untouched). */
  paused: boolean;
  theme: 'system' | 'light' | 'dark';
  /** Profile highlighted in the popup's quick-switch UI. */
  activeProfileId?: string;
  /**
   * Replication of profiles to the browser's sync area. ON by default (see
   * DEFAULT_SETTINGS), including for installs upgrading from before sync
   * existed. Device-local: deliberately NOT mirrored, so one machine can leave
   * sync without switching it off everywhere else. See src/core/sync.ts.
   */
  syncEnabled: boolean;
  /**
   * Set once the user has acknowledged that sync is on — either by dismissing
   * the notice or by working the toggle themselves. Its absence is what marks
   * someone as having been opted in *for* them, which is who the notice is for.
   */
  syncNoticeDismissed?: boolean;
  /** Epoch ms of the last profile export, used to nag about stale backups. */
  lastBackupAt?: number;
}

export const SCHEMA_VERSION = 1 as const;

export interface StorageSchema {
  version: typeof SCHEMA_VERSION;
  profiles: Profile[];
  settings: Settings;
}

/** The slice of storage that is exported/imported (settings excluded). */
export interface ExportBundle {
  version: typeof SCHEMA_VERSION;
  profiles: Profile[];
}
