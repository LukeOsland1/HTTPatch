// JSON import/export of profiles with strict, non-eval validation.

import type {
  ExportBundle,
  HeaderRule,
  Profile,
  ProfileFilters,
  ResourceType,
  UrlFilter,
} from './types';
import { SCHEMA_VERSION } from './types';
import { ALL_RESOURCE_TYPES } from './constants';
import { newId } from './id';

export interface ImportResult {
  profiles: Profile[];
  warnings: string[];
}

export class ImportError extends Error {}

/**
 * How to coerce raw profile data.
 * - `preserveIds`: keep existing string ids (migration) vs. mint fresh ones
 *   (import, where colliding ids would clobber existing profiles).
 * - `nameFallback`: name to use when a profile has none.
 */
export interface CoerceOptions {
  preserveIds: boolean;
  nameFallback: string;
}

const IMPORT_OPTS: CoerceOptions = { preserveIds: false, nameFallback: 'Imported profile' };

const HEADER_TARGETS = new Set(['request', 'response']);
const HEADER_OPS = new Set(['set', 'append', 'remove']);
const FILTER_KINDS = new Set(['wildcard', 'regex']);
const FILTER_MODES = new Set(['include', 'exclude']);
const RESOURCE_TYPE_SET = new Set<string>(ALL_RESOURCE_TYPES);

// The badge color is interpolated into an inline `style` string and handed to
// chrome.action.setBadgeBackgroundColor, so restrict it to a hex literal (what
// the `<input type="color">` picker emits) to close a stored CSS-injection sink.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function coerceId(raw: Record<string, unknown>, preserveIds: boolean): string {
  if (preserveIds && typeof raw.id === 'string' && raw.id.length > 0) return raw.id;
  return newId();
}

function coerceHeader(raw: unknown, warnings: string[], opts: CoerceOptions): HeaderRule | null {
  if (!isObject(raw)) {
    warnings.push('Skipped a header row that was not an object.');
    return null;
  }
  const target = str(raw.target);
  const operation = str(raw.operation);
  if (!HEADER_TARGETS.has(target) || !HEADER_OPS.has(operation)) {
    warnings.push(`Skipped header "${str(raw.name, '(unnamed)')}" with invalid target/operation.`);
    return null;
  }
  return {
    id: coerceId(raw, opts.preserveIds),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    target: target as HeaderRule['target'],
    operation: operation as HeaderRule['operation'],
    name: str(raw.name),
    value: typeof raw.value === 'string' ? raw.value : undefined,
    comment: typeof raw.comment === 'string' ? raw.comment : undefined,
    editor:
      raw.editor === 'request-cookie' || raw.editor === 'response-cookie' || raw.editor === 'csp'
        ? raw.editor
        : undefined,
  };
}

function coerceUrlFilter(raw: unknown): UrlFilter | null {
  if (!isObject(raw)) return null;
  const kind = str(raw.kind);
  const mode = str(raw.mode);
  const pattern = str(raw.pattern);
  // Preserve unfinished includes: dropping them would turn a scoped profile into
  // a match-all profile when storage is reloaded, imported or synced.
  if (!FILTER_KINDS.has(kind) || !FILTER_MODES.has(mode)) return null;
  return { kind: kind as UrlFilter['kind'], mode: mode as UrlFilter['mode'], pattern };
}

function coerceFilters(raw: unknown): ProfileFilters {
  if (!isObject(raw)) return { urlFilters: [], resourceTypes: [] };
  const urlFilters = Array.isArray(raw.urlFilters)
    ? raw.urlFilters.map(coerceUrlFilter).filter((f): f is UrlFilter => f !== null)
    : [];
  const resourceTypes = Array.isArray(raw.resourceTypes)
    ? (raw.resourceTypes.filter(
        (t) => typeof t === 'string' && RESOURCE_TYPE_SET.has(t),
      ) as ResourceType[])
    : [];
  return { urlFilters, resourceTypes };
}

function coerceProfile(raw: unknown, warnings: string[], opts: CoerceOptions): Profile | null {
  if (!isObject(raw)) {
    warnings.push('Skipped a profile that was not an object.');
    return null;
  }
  const headers = Array.isArray(raw.headers)
    ? raw.headers
        .map((h) => coerceHeader(h, warnings, opts))
        .filter((h): h is HeaderRule => h !== null)
    : [];
  return {
    id: coerceId(raw, opts.preserveIds),
    name: str(raw.name, opts.nameFallback),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    tabOnly: raw.tabOnly === true ? true : undefined,
    color: typeof raw.color === 'string' && HEX_COLOR.test(raw.color) ? raw.color : undefined,
    badgeText: typeof raw.badgeText === 'string' ? raw.badgeText : undefined,
    headers,
    filters: coerceFilters(raw.filters),
  };
}

/**
 * Validate/normalize an arbitrary value into a clean Profile[]. Shared by import
 * (fresh ids) and storage migration (preserved ids). Non-array input yields [].
 */
export function coerceProfiles(raw: unknown, warnings: string[], opts: CoerceOptions): Profile[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => coerceProfile(p, warnings, opts)).filter((p): p is Profile => p !== null);
}

/** Serialize profiles to a stable, pretty JSON export string. */
export function exportProfiles(profiles: Profile[]): string {
  const bundle: ExportBundle = { version: SCHEMA_VERSION, profiles };
  return JSON.stringify(bundle, null, 2);
}

/**
 * Parse and validate an import. Throws ImportError on unusable input; otherwise
 * returns coerced profiles with freshly generated ids (avoids collisions) plus
 * any per-item warnings.
 */
export function importProfiles(input: string | unknown): ImportResult {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw new ImportError('File is not valid JSON.');
    }
  }

  // Accept either a full bundle {version, profiles} or a bare profiles array.
  let profilesRaw: unknown;
  if (Array.isArray(data)) {
    profilesRaw = data;
  } else if (isObject(data)) {
    if (data.version !== undefined && data.version !== SCHEMA_VERSION) {
      throw new ImportError(
        `Unsupported export version ${String(data.version)} (expected ${SCHEMA_VERSION}).`,
      );
    }
    profilesRaw = data.profiles;
  } else {
    throw new ImportError('Unrecognized import format.');
  }

  if (!Array.isArray(profilesRaw)) {
    throw new ImportError('No profiles found in import.');
  }

  const warnings: string[] = [];
  const profiles = coerceProfiles(profilesRaw, warnings, IMPORT_OPTS);

  if (profiles.length === 0) {
    throw new ImportError('Import contained no valid profiles.');
  }

  return { profiles, warnings };
}
