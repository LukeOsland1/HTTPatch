import browser from 'webextension-polyfill';

export async function getActiveTab(): Promise<{ id: number | null; url: string }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id ?? null, url: tab?.url ?? '' };
}
