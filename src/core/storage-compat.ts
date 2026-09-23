// Transfer data from earlier development builds to the current storage keys.
import { SYNC_META_KEY, SYNC_PROFILE_PREFIX, SYNC_SETTINGS_KEY } from './sync';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function previousLocalEntry(
  raw: Record<string, unknown>,
  currentKey: string,
  kind: 'schema' | 'sync-state',
): [string, unknown] | null {
  for (const [key, value] of Object.entries(raw)) {
    if (key === currentKey || !isRecord(value)) continue;
    if (kind === 'schema' && Array.isArray(value.profiles) && isRecord(value.settings))
      return [key, value];
    if (kind === 'sync-state' && typeof value.deviceId === 'string' && isRecord(value.entries))
      return [key, value];
  }
  return null;
}

export const LEGACY_SYNC_META_KEY = 'oh_s_meta';
export const LEGACY_SYNC_SETTINGS_KEY = 'oh_s_settings';
export const LEGACY_SYNC_PROFILE_PREFIX = 'oh_s_p_';

export function currentSyncKey(key: string): string | null {
  if (key === LEGACY_SYNC_META_KEY) return SYNC_META_KEY;
  if (key === LEGACY_SYNC_SETTINGS_KEY) return SYNC_SETTINGS_KEY;
  if (key.startsWith(LEGACY_SYNC_PROFILE_PREFIX))
    return `${SYNC_PROFILE_PREFIX}${key.slice(LEGACY_SYNC_PROFILE_PREFIX.length)}`;
  return null;
}

export function isOwnedSyncKey(key: string): boolean {
  return (
    key === SYNC_META_KEY ||
    key === SYNC_SETTINGS_KEY ||
    key.startsWith(SYNC_PROFILE_PREFIX) ||
    currentSyncKey(key) !== null
  );
}

export function shouldTransferSyncItem(previous: unknown, current: unknown): boolean {
  if (current === undefined) return true;
  if (!previous || typeof previous !== 'object' || !current || typeof current !== 'object')
    return false;
  const previousAt = (previous as { updatedAt?: unknown }).updatedAt;
  const currentAt = (current as { updatedAt?: unknown }).updatedAt;
  return (
    typeof previousAt === 'number' &&
    Number.isFinite(previousAt) &&
    (typeof currentAt !== 'number' || !Number.isFinite(currentAt) || previousAt > currentAt)
  );
}

/** Move one item at a time so the old and new full-size values never occupy quota together. */
export async function transferLegacySyncItems(
  raw: Record<string, unknown>,
  area: {
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
  },
): Promise<Record<string, unknown>> {
  for (const [previousKey, value] of Object.entries(raw)) {
    const currentKey = currentSyncKey(previousKey);
    if (!currentKey) continue;
    if (shouldTransferSyncItem(value, raw[currentKey])) {
      // Replacing the old value with null and adding the new one in the same
      // write avoids temporarily doubling sync usage. A failed write leaves
      // the old item intact for the next attempt.
      await area.set({ [previousKey]: null, [currentKey]: value });
      raw[currentKey] = value;
    }
    await area.remove(previousKey);
    delete raw[previousKey];
  }
  return raw;
}
