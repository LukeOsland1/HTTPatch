// Verify the packaged extension's identity, permissions and bundled documents.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const failures = [];
const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());
if (manifest.name !== 'HTTPatch' || manifest.action?.default_title !== 'HTTPatch')
  failures.push('Incorrect product branding.');
if (manifest.version !== pkg.version) failures.push('Version does not match package.json.');
if (!same(manifest.permissions, ['declarativeNetRequestWithHostAccess', 'storage', 'alarms']))
  failures.push('Unexpected permissions.');
if (!same(manifest.host_permissions, ['<all_urls>'])) failures.push('Unexpected host permissions.');
if (manifest.content_scripts?.length) failures.push('Content scripts must not be shipped.');
if (manifest.web_accessible_resources?.length)
  failures.push('Unexpected web-accessible resources.');
if (manifest.storage?.managed_schema) failures.push('Unexpected managed storage schema.');
if (manifest.update_url || manifest.key)
  failures.push('An unpacked build must not include an update URL or signing key.');
if (
  manifest.browser_specific_settings &&
  manifest.browser_specific_settings.gecko?.id !== 'httpatch@lukeosland1'
)
  failures.push('Incorrect Firefox identity.');
for (const file of ['privacy.html', 'LICENSE.txt']) {
  if (!existsSync(join(dist, file))) failures.push(`Missing ${file}.`);
}
if (existsSync(join(dist, 'LICENSE.txt'))) {
  const license = readFileSync(join(dist, 'LICENSE.txt'), 'utf8');
  const sourceLicense = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  if (license.replaceAll('\r\n', '\n') !== sourceLicense.replaceAll('\r\n', '\n'))
    failures.push('Packaged licence differs from LICENSE.');
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `✓ ${dist}: HTTPatch identity, expected permissions, no content scripts, privacy and licence included.`,
);
