import type { ResourceType, Settings, StorageSchema } from './types';
import { SCHEMA_VERSION } from './types';

/**
 * Request headers on which DNR's `append` operation is permitted. Chrome
 * rejects `append` for any other request header, so the UI disables it and the
 * compiler skips it as a backstop. Response headers support append broadly, so
 * they are NOT restricted by this list.
 * Source: chrome.declarativeNetRequest.ModifyHeaderInfo docs.
 */
export const APPEND_ALLOWLIST: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for',
]);

/** All DNR resource types. Applied when a profile selects none, so main_frame is not silently missed. */
export const ALL_RESOURCE_TYPES: ResourceType[] = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];

/**
 * Max number of *unsafe* dynamic rules. `modifyHeaders` is an unsafe action, so
 * every rule we emit counts against this (lower) cap — not the 30,000 total.
 * chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES.
 */
export const MAX_UNSAFE_DYNAMIC_RULES = 5000;

/** regexFilter patterns are limited to ~2KB each and 1,000 regex rules total. */
export const MAX_REGEX_PATTERN_BYTES = 2048;
export const MAX_REGEX_RULES = 1000;

export const DEFAULT_BADGE_COLOR = '#4f46e5';

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  theme: 'light',
  // On by default, for new installs AND for installs upgrading from before sync
  // existed: settings are coerced field-by-field against these defaults, and a
  // pre-sync install has no `syncEnabled` key, so it resolves to this value.
  //
  // That means an upgrade starts replicating profiles — header values included —
  // without the user having opted in. Deliberate product decision, not an
  // oversight. An explicit opt-out is still honoured: turning sync off persists
  // `syncEnabled: false`, which coercion preserves, so it is never re-enabled.
  syncEnabled: true,
};

export const EMPTY_SCHEMA: StorageSchema = {
  version: SCHEMA_VERSION,
  profiles: [],
  settings: { ...DEFAULT_SETTINGS },
};

/** Single chrome.storage.local key holding the whole schema. */
export const STORAGE_KEY = 'httpatch';
