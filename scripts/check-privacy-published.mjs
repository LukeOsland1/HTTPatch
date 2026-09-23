// Optional verification of a personal, publicly hosted Markdown policy.
import { readFileSync } from 'node:fs';

const url = process.env.PRIVACY_POLICY_URL;
if (!url) {
  console.error('Set PRIVACY_POLICY_URL to your public Markdown privacy policy URL.');
  process.exit(1);
}
if (new URL(url).protocol !== 'https:') throw new Error('PRIVACY_POLICY_URL must use HTTPS.');
const response = await fetch(url);
if (!response.ok) throw new Error(`Privacy policy request failed: HTTP ${response.status}`);
const published = await response.text();
const local = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
const normalize = (s) =>
  s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
if (normalize(local) !== normalize(published)) {
  console.error(
    'The published policy differs from PRIVACY.md. Publish the current policy before release.',
  );
  process.exit(1);
}
console.log('✓ The published privacy policy matches PRIVACY.md.');
