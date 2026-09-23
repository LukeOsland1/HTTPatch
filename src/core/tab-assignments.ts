// Device/session-local tab IDs must never be included in synced profiles.
// A profile's tabOnly flag is synced, so an unassigned copy remains inactive
// on another device and after browser restart instead of becoming global.
const KEY = 'httpatch-tab-assignments';

export type TabAssignments = Record<string, number>;

export async function loadTabAssignments(): Promise<TabAssignments> {
  const result = await chrome.storage.session.get(KEY);
  const raw = result[KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([id, tabId]) => id.length > 0 && Number.isSafeInteger(tabId) && (tabId as number) >= 0,
    ),
  ) as TabAssignments;
}

export async function saveTabAssignments(assignments: TabAssignments): Promise<void> {
  await chrome.storage.session.set({ [KEY]: assignments });
}
