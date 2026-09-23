import type { HeaderRule, Profile } from '@/core/types';
import { DEFAULT_BADGE_COLOR } from '@/core/constants';
import { newId } from '@/core/id';

export function newHeader(overrides: Partial<HeaderRule> = {}): HeaderRule {
  return {
    id: newId(),
    enabled: true,
    target: 'request',
    operation: 'set',
    name: '',
    value: '',
    ...overrides,
  };
}

export function newProfile(name = 'New profile'): Profile {
  return {
    id: newId(),
    name,
    enabled: true,
    color: DEFAULT_BADGE_COLOR,
    badgeText: '',
    headers: [newHeader()],
    filters: { urlFilters: [], resourceTypes: [] },
  };
}
