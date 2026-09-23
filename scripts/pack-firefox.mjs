// Packages dist-firefox/ into a Firefox .xpi in release/. Run after
// `npm run build:firefox`:  node scripts/pack-firefox.mjs
//
// Firefox (release/beta) refuses to install an UNSIGNED .xpi, so for real
// self-install the add-on must be signed by Mozilla via the AMO API on the
// `unlisted` channel (a signature only — not a public store listing).
//
//   - If AMO_JWT_ISSUER and AMO_JWT_SECRET are set  -> `web-ext sign` (signed).
//   - Otherwise                                     -> `web-ext build` (UNSIGNED,
//     installable only in Firefox Developer Edition / Nightly / ESR, or as a
//     temporary add-on) and we print a loud warning.
//
// Either way the canonical output is release/httpatch-<version>-firefox.xpi.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'dist-firefox');
if (!existsSync(sourceDir)) {
  console.error('dist-firefox/ not found — run `npm run build:firefox` first.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const finalName = `httpatch-${pkg.version}-firefox.xpi`;
const finalPath = join(outDir, finalName);

const webExt = join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
const sign = Boolean(issuer && secret);

if (sign) {
  // A fresh directory prevents an old unsigned final artifact being mistaken
  // for the output of a successful signing attempt.
  const signDir = mkdtempSync(join(outDir, '.firefox-sign-'));
  console.log('AMO credentials found — signing on the `unlisted` channel via web-ext…');
  // Pass the AMO credentials via env vars, not argv: process arguments are
  // world-readable (ps / /proc/<pid>/cmdline), so a co-resident process could
  // read the secret. web-ext honors WEB_EXT_API_KEY / WEB_EXT_API_SECRET.
  execFileSync(
    process.execPath,
    [
      webExt,
      'sign',
      `--source-dir=${sourceDir}`,
      `--artifacts-dir=${signDir}`,
      '--channel=unlisted',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret },
    },
  );
  const produced = existingXpis(signDir);
  if (produced.length !== 1) {
    console.error(
      'Signing finished without exactly one new signed .xpi. Previous artifacts were not changed.',
    );
    process.exit(1);
  }
  rmSync(finalPath, { force: true });
  renameSync(join(signDir, produced[0]), finalPath);
  rmdirSync(signDir);
  console.log(`\nSigned ${finalPath}`);
} else {
  console.warn(
    '\n⚠️  AMO_JWT_ISSUER / AMO_JWT_SECRET not set — building an UNSIGNED .xpi.\n' +
      '   Normal Firefox will refuse to install it; it works only in Firefox\n' +
      '   Developer Edition / Nightly / ESR, or as a temporary add-on.\n',
  );
  rmSync(finalPath, { force: true });
  execFileSync(
    process.execPath,
    [
      webExt,
      'build',
      `--source-dir=${sourceDir}`,
      `--artifacts-dir=${outDir}`,
      '--overwrite-dest',
      `--filename=${finalName}`,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  console.log(`\nBuilt (unsigned) ${finalPath}`);
}

/** List .xpi files currently in the release dir. */
function existingXpis(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.xpi'))
    .filter((f) => statSync(join(dir, f)).isFile());
}
