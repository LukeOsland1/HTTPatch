// Packages the built dist/ into versioned zips for release / Web Store upload.
// Run after `npm run build`:  node scripts/zip.mjs
//
// Chrome, Edge, Arc and Brave install the same Chromium bundle.
import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (!existsSync(dist)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });

const archive = new AdmZip();
archive.addLocalFolder(dist);
const bytes = archive.toBuffer();
const out = join(outDir, `httpatch-${pkg.version}-chromium.zip`);
writeFileSync(out, bytes);
console.log(`Packaged ${out}`);
