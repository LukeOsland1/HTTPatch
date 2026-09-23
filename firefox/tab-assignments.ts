import browser from 'webextension-polyfill';
import type { TabAssignments } from '@/core/tab-assignments';

const KEY = 'httpatch-tab-assignments';

export async function loadTabAssignments(): Promise<TabAssignments> {
  const result = await browser.storage.session.get(KEY);
  const raw = result[KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([id, tabId]) => id.length > 0 && Number.isSafeInteger(tabId) && (tabId as number) >= 0,
    ),
  ) as TabAssignments;
}

export async function saveTabAssignments(assignments: TabAssignments): Promise<void> {
  await browser.storage.session.set({ [KEY]: assignments });
}
