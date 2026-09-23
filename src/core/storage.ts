// The sole boundary to chrome.storage.local. Everything else reads/writes the
// schema through here so persistence, defaults, and migrations live in one place.

import type { Settings, StorageSchema } from './types';
import { SCHEMA_VERSION } from './types';
import { DEFAULT_SETTINGS, EMPTY_SCHEMA, STORAGE_KEY } from './constants';
import { previousLocalEntry } from './storage-compat';
import { coerceProfiles } from './importexport';

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
  const result = await chrome.storage.local.get(null);
  const previous = previousLocalEntry(result, STORAGE_KEY, 'schema');
  if (result[STORAGE_KEY] !== undefined) {
    if (previous) await chrome.storage.local.remove(previous[0]).catch(() => {});
    return migrate(result[STORAGE_KEY]);
  }
  if (!previous) return migrate(undefined);
  const schema = migrate(previous[1]);
  await chrome.storage.local.set({ [STORAGE_KEY]: schema });
  await chrome.storage.local.remove(previous[0]).catch(() => {});
  return schema;
}

export async function save(schema: StorageSchema): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: schema });
}

/** Subscribe to changes to our storage key. Returns an unsubscribe fn. */
export function onChange(cb: (schema: StorageSchema) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: string,
  ): void => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb(migrate(changes[STORAGE_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
