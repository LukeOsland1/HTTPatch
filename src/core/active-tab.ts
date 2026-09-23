/** Current browser tab, using the host access already granted for header rules. */
export async function getActiveTab(): Promise<{ id: number | null; url: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id ?? null, url: tab?.url ?? '' };
}
