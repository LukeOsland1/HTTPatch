// Firefox variant of src/core/storage.ts. Identical logic, but talks to the
// promise-based `browser.storage.local` (via webextension-polyfill) instead of
// `chrome.storage.local`. Wired in for the Firefox build via a Vite resolve
// alias, so the shared UI/core code that imports `@/core/storage` transparently
// gets this module. The Chrome build is untouched.

import browser from 'webextension-polyfill';
import type { Settings, StorageSchema } from '@/core/types';
import { SCHEMA_VERSION } from '@/core/types';
import { DEFAULT_SETTINGS, EMPTY_SCHEMA, STORAGE_KEY } from '@/core/constants';
import { previousLocalEntry } from '@/core/storage-compat';
import { coerceProfiles } from '@/core/importexport';

const MIGRATE_OPTS = { preserveIds: true, nameFallback: 'Untitled profile' } as const;

/** Validate the persisted settings object, falling back to defaults per field. */
function coerceSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const obj = raw as Record<string, unknown>;
  const theme = obj.theme;
  return {
    paused: typeof obj.paused === 'boolean' ? obj.paused : DEFAULT_SETTINGS.paused,
    theme:
      theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_SETTINGS.theme,
    activeProfileId: typeof obj.activeProfileId === 'string' ? obj.activeProfileId : undefined,
    syncEnabled:
      typeof obj.syncEnabled === 'boolean' ? obj.syncEnabled : DEFAULT_SETTINGS.syncEnabled,
    syncNoticeDismissed: obj.syncNoticeDismissed === true ? true : undefined,
    lastBackupAt: typeof obj.lastBackupAt === 'number' ? obj.lastBackupAt : undefined,
  };
}

/**
 * Normalize/migrate arbitrary stored data into a valid current-version schema.
 * Everything is coerced field-by-field (reusing the import validators) so
 * corrupted or future-version blobs can never reach the compiler.
 */
export function migrate(raw: unknown): StorageSchema {
  if (!raw || typeof raw !== 'object') {
    return structuredCloneSafe(EMPTY_SCHEMA);
  }
  const obj = raw as Record<string, unknown>;
  const profiles = coerceProfiles(obj.profiles, [], MIGRATE_OPTS);
  const settings = coerceSettings(obj.settings);
  return { version: SCHEMA_VERSION, profiles, settings };
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function load(): Promise<StorageSchema> {
  const result = await browser.storage.local.get(null);
  const previous = previousLocalEntry(result, STORAGE_KEY, 'schema');
  if (result[STORAGE_KEY] !== undefined) {
    if (previous) await browser.storage.local.remove(previous[0]).catch(() => {});
    return migrate(result[STORAGE_KEY]);
  }
  if (!previous) return migrate(undefined);
  const schema = migrate(previous[1]);
  await browser.storage.local.set({ [STORAGE_KEY]: schema });
  await browser.storage.local.remove(previous[0]).catch(() => {});
  return schema;
}

export async function save(schema: StorageSchema): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: schema });
}

/** Subscribe to changes to our storage key. Returns an unsubscribe fn. */
export function onChange(cb: (schema: StorageSchema) => void): () => void {
  // Derive the listener type from the API itself to sidestep the polyfill's
  // namespace-type import quirks.
  type ChangeListener = Parameters<typeof browser.storage.onChanged.addListener>[0];
  const listener: ChangeListener = (changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb(migrate(changes[STORAGE_KEY].newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
