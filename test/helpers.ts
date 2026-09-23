import type { HeaderRule, Profile, StorageSchema } from '../src/core/types';
import { SCHEMA_VERSION } from '../src/core/types';
import { DEFAULT_SETTINGS } from '../src/core/constants';

let counter = 0;
const id = () => `id-${counter++}`;

export function header(overrides: Partial<HeaderRule> = {}): HeaderRule {
  return {
    id: id(),
    enabled: true,
    target: 'request',
    operation: 'set',
    name: 'X-Test',
    value: 'v',
    ...overrides,
  };
}

export function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: id(),
    name: 'P',
    enabled: true,
    headers: [],
    filters: { urlFilters: [], resourceTypes: [] },
    ...overrides,
  };
}

export function schema(profiles: Profile[], paused = false): StorageSchema {
  return {
    version: SCHEMA_VERSION,
    profiles,
    settings: { ...DEFAULT_SETTINGS, paused },
  };
}
