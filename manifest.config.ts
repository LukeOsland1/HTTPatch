import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
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
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  // `modifyHeaders` is an "unsafe" DNR action, so it requires host access.
  // WithHostAccess avoids the scary install-time warning; <all_urls> makes
  // rules apply everywhere immediately (matching ModHeader's behavior).
  // `storage` covers both storage.local (the source of truth) and storage.sync
  // (profile replication). `alarms` is the durable trailing-flush timer
  // for sync — a non-persistent worker can die before a setTimeout fires.
  // Neither adds an install-time warning.
  permissions: ['declarativeNetRequestWithHostAccess', 'storage', 'alarms'],
  host_permissions: ['<all_urls>'],
  // Floor for the DNR features we rely on: `excludedRequestDomains` conditions
  // (Chrome 101) and the newer `webtransport`/`webbundle` resource types.
  minimum_chrome_version: '116',
});
