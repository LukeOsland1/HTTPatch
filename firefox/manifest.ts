// Firefox MV3 manifest. Mirrors the Chrome manifest (manifest.config.ts) but
// with the Gecko-specific differences: an event-page `background.scripts` entry
// instead of a service worker, `browser_specific_settings.gecko` (a stable
// add-on id + a min-version floor), an `options_ui` block (Firefox's options
// surface), and no Chrome-only `minimum_chrome_version`.
//
// strict_min_version is 128.0 because that's when Firefox's declarativeNetRequest
// gained the `modifyHeaders` action this extension is built on.
//
// The version is read from the root package.json so it tracks the single source
// of truth (same as the Chrome build).
import pkg from '../package.json' with { type: 'json' };

export const firefoxManifest = {
  manifest_version: 3,
  name: 'HTTPatch',
  description:
    'Free, ad-free modification of HTTP request & response headers. An open ModHeader alternative.',
  version: pkg.version,
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'HTTPatch',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
    },
  },
  // Firefox's options surface. open_in_tab matches Chrome's full-page options.
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  // Firefox MV3 uses a non-persistent background *event page*, loaded as a module
  // script (Firefox 128 supports module background scripts). background.js is the
  // stable entry filename emitted by firefox/vite.config.ts.
  background: {
    scripts: ['background.js'],
    type: 'module',
  },
  // `modifyHeaders` is an "unsafe" DNR action, so it requires host access.
  // `alarms` backs the sync trailing flush (see firefox/background.ts).
  permissions: ['declarativeNetRequestWithHostAccess', 'storage', 'alarms'],
  host_permissions: ['<all_urls>'],
  browser_specific_settings: {
    gecko: {
      id: 'httpatch@lukeosland1',
      // Floor for the DNR `modifyHeaders` action (Firefox 128+).
      strict_min_version: '128.0',
      // HTTPatch collects no user data; declare it explicitly (AMO now
      // expects this key). Older Firefox ignores unknown keys.
      data_collection_permissions: {
        required: ['none'],
      },
    },
  },
};
