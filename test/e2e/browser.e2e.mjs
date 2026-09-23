// Exercise the packaged extension in a real Chromium browser.
// CI uses Playwright Chromium; Windows uses installed Chrome via
// Extensions.loadUnpacked. Set HTTPATCH_BROWSER_CHANNEL to override.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const screenshots = process.argv.includes('--screenshots');
const channel =
  process.env.HTTPATCH_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'chrome' : 'chromium');
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(request.headers));
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const port = server.address().port;
let context;

try {
  context = await chromium.launchPersistentContext('', {
    channel,
    headless: true,
    colorScheme: 'dark',
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args:
      channel === 'chromium'
        ? [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`]
        : ['--enable-unsafe-extension-debugging'],
  });
  if (channel !== 'chromium') {
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: dist });
    await cdp.detach();
  }

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  const errors = [];
  options.on('pageerror', (error) => errors.push(error.message));
  options.on('dialog', (dialog) => void dialog.accept());

  // A fresh install stays light even when the operating system prefers dark.
  await options.goto(`chrome-extension://${id}/src/options/index.html`);
  const themeSelect = options
    .locator('select')
    .filter({ has: options.locator('option[value="dark"]') });
  await expect(themeSelect).toHaveValue('light');
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(options.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const freshPopup = await context.newPage();
  await freshPopup.goto(`chrome-extension://${id}/src/popup/index.html`);
  await expect(freshPopup.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(freshPopup.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await freshPopup.close();

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      httpatch: {
        version: 1,
        profiles: [
          {
            id: 'smoke',
            name: 'Example site',
            enabled: true,
            color: '#4f46e5',
            headers: [
              {
                id: 'header',
                enabled: true,
                target: 'request',
                operation: 'set',
                name: 'X-HTTPatch-Test',
                value: 'working',
              },
            ],
            filters: {
              urlFilters: [{ kind: 'wildcard', mode: 'include', pattern: '||127.0.0.1^' }],
              resourceTypes: [],
            },
          },
        ],
        settings: { paused: false, theme: 'light', syncEnabled: false },
      },
    });
  });

  await options.reload();
  await expect(options.getByRole('heading', { name: 'HTTPatch', exact: true })).toBeVisible();
  await expect(options.getByRole('link', { name: 'Luke Osland' })).toHaveCount(0);
  await expect(options.getByRole('link', { name: /Support on Ko-fi/ })).toHaveAttribute(
    'href',
    'https://ko-fi.com/lukeosland',
  );

  const applied = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'apply' }));
  if (!applied.applied || applied.ruleCount !== 1) throw new Error('Header rule did not apply');
  await options.reload();
  await expect(options.getByText('1 active rule.', { exact: true })).toBeVisible();
  if (screenshots) {
    mkdirSync('docs/screenshots', { recursive: true });
    await options.screenshot({ path: 'docs/screenshots/options-light.png', fullPage: true });
  }
  await themeSelect.selectOption('system');
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'system');
  await expect(options.locator('body')).toHaveCSS('background-color', 'rgb(22, 24, 29)');
  await themeSelect.selectOption('dark');
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(options.getByRole('button', { name: '+ Header', exact: true })).toHaveCSS(
    'background-color',
    'rgb(15, 17, 21)',
  );
  if (screenshots)
    await options.screenshot({ path: 'docs/screenshots/options-dark.png', fullPage: true });
  for (const width of [900, 680, 375]) {
    await options.setViewportSize({ width, height: 800 });
    const noHorizontalScroll = await options.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    if (!noHorizontalScroll) throw new Error(`Options layout overflows at ${width}px`);
    if (width === 375) {
      const patternWidth = await options
        .locator('.filters .hrow input')
        .first()
        .evaluate((field) => field.getBoundingClientRect().width);
      if (patternWidth < 180) throw new Error('URL filter input is too narrow to edit');
    }
  }
  await options.setViewportSize({ width: 1280, height: 800 });

  // The shared header-name picker filters by typing, supports keyboard selection,
  // and leaves custom names editable on both request and response rows.
  await options.getByRole('button', { name: '+ Header', exact: true }).click();
  const pickerRow = options.locator('.htable .hrow').last();
  const nameInput = pickerRow.getByRole('combobox', { name: 'Header name' });
  await nameInput.fill('auth');
  await expect(options.getByRole('option', { name: 'Authorization' })).toBeVisible();
  await nameInput.press('Enter');
  await expect(nameInput).toHaveValue('Authorization');
  await nameInput.fill('X-My-Custom-Header');
  await expect(options.getByText('No match. Custom names are welcome.')).toBeVisible();
  await nameInput.press('Tab');
  await expect
    .poll(() =>
      options.evaluate(
        async () =>
          (await chrome.storage.local.get('httpatch')).httpatch.profiles[0].headers[1].name,
      ),
    )
    .toBe('X-My-Custom-Header');
  await pickerRow.locator('.hrow-top select').first().selectOption('response');
  await pickerRow.getByRole('button', { name: 'Show popular header names' }).click();
  await expect(options.getByRole('option', { name: 'Access-Control-Allow-Origin' })).toBeVisible();
  await expect(options.getByRole('option', { name: 'Authorization' })).toHaveCount(0);
  await options.getByRole('option', { name: 'Access-Control-Allow-Origin' }).click();
  await expect(nameInput).toHaveValue('Access-Control-Allow-Origin');
  await pickerRow.getByRole('button', { name: 'Delete' }).click();
  await expect(options.locator('.htable .hrow')).toHaveCount(1);

  // A failed write must show an error, restore the saved view, and allow retry.
  await options.evaluate(() => {
    window.originalStorageSet = chrome.storage.local.set;
    chrome.storage.local.set = () => Promise.reject(new Error('test storage failure'));
  });
  await options.getByRole('button', { name: '+ New profile' }).click();
  await expect(options.getByText(/Could not save changes: test storage failure/)).toBeVisible();
  await expect(options.locator('.plist li')).toHaveCount(1);
  await options.evaluate(() => {
    chrome.storage.local.set = window.originalStorageSet;
  });
  await options.getByRole('button', { name: '+ New profile' }).click();
  await expect(options.locator('.plist li')).toHaveCount(2);
  await expect
    .poll(() =>
      options.evaluate(
        async () => (await chrome.storage.local.get('httpatch')).httpatch.profiles.length,
      ),
    )
    .toBe(2);

  // Return to the stable example profile for the popup and network check.
  await options.locator('.toolbar').getByRole('button', { name: 'Delete' }).click();
  await expect(options.locator('.plist li')).toHaveCount(1);
  await themeSelect.selectOption('light');
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'light');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/popup/index.html`);
  await expect(popup.getByRole('link', { name: /Support on Ko-fi/ })).toBeVisible();
  await popup.getByRole('button', { name: 'Duplicate header' }).click();
  await expect(popup.locator('.htable .hrow')).toHaveCount(2);
  await popup.getByRole('button', { name: 'Delete' }).last().click();
  await expect(popup.locator('.htable .hrow')).toHaveCount(1);
  await popup.getByRole('button', { name: 'Show popular header names' }).click();
  await expect(popup.getByRole('listbox', { name: 'Header names' })).toBeVisible();
  const pickerFits = await popup.evaluate(() => {
    const menu = document.querySelector('.header-name-menu').getBoundingClientRect();
    const panel = document.querySelector('.popup').getBoundingClientRect();
    return menu.top >= panel.top && menu.bottom <= panel.bottom;
  });
  if (!pickerFits) throw new Error('Header suggestions are clipped by the popup');
  if (screenshots)
    await popup.locator('.popup').screenshot({ path: 'docs/screenshots/popup-header-picker.png' });
  const popupName = popup.getByRole('combobox', { name: 'Header name' });
  for (let index = 0; index < 7; index++) await popupName.press('ArrowDown');
  await expect(popup.getByRole('option', { name: 'User-Agent' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await popupName.press('Enter');
  await expect(popupName).toHaveValue('User-Agent');
  await popupName.fill('X-HTTPatch-Test');
  await popupName.press('Escape');
  await expect(popup.getByRole('listbox', { name: 'Header names' })).toHaveCount(0);
  await expect
    .poll(() =>
      options.evaluate(
        async () =>
          (await chrome.storage.local.get('httpatch')).httpatch.profiles[0].headers[0].name,
      ),
    )
    .toBe('X-HTTPatch-Test');

  const target = await context.newPage();
  await target.goto(`http://127.0.0.1:${port}/`);
  let headers = JSON.parse(await target.locator('body').innerText());
  if (headers['x-httpatch-test'] !== 'working') throw new Error('Header was not sent');
  // The popup can scope the selected profile to the current web page's host.
  await options.evaluate(async () => {
    const { httpatch: stored } = await chrome.storage.local.get('httpatch');
    stored.profiles[0].filters.urlFilters[0].pattern = '||example.com^';
    await chrome.storage.local.set({ httpatch: stored });
    await chrome.runtime.sendMessage({ type: 'apply' });
  });
  await target.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: 'Scope to this site' }).click();
  await expect
    .poll(() =>
      options.evaluate(async () => {
        const { httpatch: stored } = await chrome.storage.local.get('httpatch');
        return stored.profiles[0].filters.urlFilters[0].pattern;
      }),
    )
    .toBe('||127.0.0.1^');
  if (screenshots)
    await popup.locator('.popup').screenshot({ path: 'docs/screenshots/popup-site.png' });
  await expect
    .poll(() =>
      options.evaluate(async () =>
        (await chrome.declarativeNetRequest.getDynamicRules()).map(
          (rule) => rule.condition.urlFilter,
        ),
      ),
    )
    .toContain('||127.0.0.1^');
  await target.reload();
  headers = JSON.parse(await target.locator('body').innerText());
  if (headers['x-httpatch-test'] !== 'working') throw new Error('Scoped header was not sent');

  // Tab-only mode uses session rules, and must not affect another tab on the same site.
  const targetTabId = await options.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
  await popup.locator('.tab-scope .switch').click();
  await expect
    .poll(() =>
      options.evaluate(async () => ({
        dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).length,
        session: (await chrome.declarativeNetRequest.getSessionRules()).map(
          (rule) => rule.condition.tabIds,
        ),
      })),
    )
    .toEqual({ dynamic: 0, session: [[targetTabId]] });
  await target.reload();
  headers = JSON.parse(await target.locator('body').innerText());
  if (headers['x-httpatch-test'] !== 'working') throw new Error('Tab-scoped header was not sent');
  const otherTab = await context.newPage();
  await otherTab.goto(`http://127.0.0.1:${port}/`);
  headers = JSON.parse(await otherTab.locator('body').innerText());
  if (headers['x-httpatch-test']) throw new Error('Tab-only header leaked into another tab');
  await otherTab.close();
  await target.bringToFront();
  await popup.reload();
  await popup.locator('.tab-scope .switch').click();
  await expect
    .poll(() =>
      options.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length),
    )
    .toBe(0);

  // Structured cookie and CSP controls compile to actual request/response rules.
  await popup.getByRole('button', { name: '+ Request cookie', exact: true }).click();
  await popup.getByRole('textbox', { name: 'Cookie name' }).fill('httpatch_demo');
  await popup.getByRole('textbox', { name: 'Cookie value' }).fill('one');
  await expect
    .poll(() =>
      options.evaluate(async () =>
        (await chrome.declarativeNetRequest.getDynamicRules()).flatMap(
          (rule) => rule.action.requestHeaders?.map((h) => h.value) ?? [],
        ),
      ),
    )
    .toContain('httpatch_demo=one');
  await target.reload();
  headers = JSON.parse(await target.locator('body').innerText());
  if (!headers.cookie?.includes('httpatch_demo=one'))
    throw new Error('Request cookie was not sent');

  await popup.getByRole('button', { name: '+ Set-Cookie', exact: true }).click();
  const responseCookie = popup.locator('.htable .hrow').last();
  await responseCookie.getByRole('textbox', { name: 'Cookie name' }).fill('response_demo');
  await responseCookie.getByRole('textbox', { name: 'Cookie value' }).fill('two');
  await responseCookie
    .getByRole('textbox', { name: 'Set-Cookie attributes' })
    .fill('Path=/; SameSite=Lax');
  await expect
    .poll(() =>
      options.evaluate(async () =>
        (await chrome.declarativeNetRequest.getDynamicRules()).flatMap(
          (rule) => rule.action.responseHeaders?.map((h) => h.value) ?? [],
        ),
      ),
    )
    .toContain('response_demo=two; Path=/; SameSite=Lax');
  await target.reload();
  if (!(await target.evaluate(() => document.cookie)).includes('response_demo=two'))
    throw new Error('Set-Cookie response was not applied');

  await popup.getByRole('button', { name: '+ CSP', exact: true }).click();
  const csp = popup.locator('.htable .hrow').last();
  await csp.getByRole('button', { name: '+ script-src' }).click();
  await expect(csp.getByRole('textbox', { name: 'Content Security Policy' })).toHaveValue(
    "default-src 'self'; object-src 'none'; base-uri 'self'; script-src 'self'",
  );
  await csp.locator('.switch').click();
  await expect
    .poll(() =>
      options.evaluate(async () =>
        (await chrome.declarativeNetRequest.getDynamicRules()).flatMap(
          (rule) => rule.action.responseHeaders?.map((h) => h.value) ?? [],
        ),
      ),
    )
    .toContain("default-src 'self'; object-src 'none'; base-uri 'self'; script-src 'self'");
  const appliedCsp = await target.evaluate(async () =>
    (await fetch(window.location.href)).headers.get('content-security-policy'),
  );
  if (!appliedCsp?.includes("script-src 'self'")) throw new Error('CSP response was not applied');
  await options.evaluate(async () => {
    const { httpatch: stored } = await chrome.storage.local.get('httpatch');
    stored.profiles[0].filters.urlFilters[0].pattern = '';
    await chrome.storage.local.set({ httpatch: stored });
    await chrome.runtime.sendMessage({ type: 'apply' });
  });
  await target.reload();
  headers = JSON.parse(await target.locator('body').innerText());
  if (headers['x-httpatch-test']) throw new Error('Blank include leaked a header');

  // Exercise browser sync through real extension storage in the maintained browser test.
  await options.evaluate(async () => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.remove('httpatch_sync_state');
  });
  await options.reload();
  const syncToggle = options.locator(
    '.sidebar-secondary .switch[title="Sync profiles across your devices"]',
  );
  await syncToggle.click();
  await expect
    .poll(
      () => options.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).sort()),
      { timeout: 20_000 },
    )
    .toContain('ht_s_p_smoke');
  const syncedProfile = await options.evaluate(
    async () => (await chrome.storage.sync.get('ht_s_p_smoke')).ht_s_p_smoke?.profile,
  );
  if (syncedProfile?.headers[0]?.value !== 'working')
    throw new Error('Browser sync omitted the header value');
  await syncToggle.click();
  await expect(options.getByRole('button', { name: 'Remove synced copy' })).toBeVisible();
  await options.getByRole('button', { name: 'Remove synced copy' }).click();
  await expect
    .poll(() => options.evaluate(async () => Object.keys(await chrome.storage.sync.get(null))))
    .toEqual([]);
  const localAfterSyncRemoval = await options.evaluate(
    async () => (await chrome.storage.local.get('httpatch')).httpatch.profiles.length,
  );
  if (localAfterSyncRemoval !== 1) throw new Error('Removing sync copy removed a local profile');

  await popup.goto(`chrome-extension://${id}/privacy.html`);
  await expect(popup.getByRole('heading', { name: 'HTTPatch Privacy Policy' })).toBeVisible();
  await expect(popup.getByText('Copyright (c) 2026 Luke Osland', { exact: false })).toBeVisible();

  const failedLoad = await context.newPage();
  await failedLoad.addInitScript(() => {
    chrome.storage.local.get = async () => {
      throw new Error('test load failure');
    };
  });
  await failedLoad.goto(`chrome-extension://${id}/src/popup/index.html`);
  await expect(failedLoad.getByRole('alert')).toContainText(
    'Could not load profiles: test load failure',
  );
  await expect(failedLoad.getByRole('button', { name: 'Retry' })).toBeVisible();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Browser check passed: UI, storage, sync, header rules, privacy and credits.');
} finally {
  await context?.close();
  server.close();
}
