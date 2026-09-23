// Render PRIVACY.md into the standalone public privacy page.
//
// The point of this script is what it does NOT do: it never copies the
// repository. It reads exactly one file, writes exactly one file, and then
// asserts that is all the output directory contains. That assertion is what
// ensures that publishing this output cannot expose source, docs or history:
// the deployable artifact contains only the policy page.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';

const outDir = process.argv[2] ?? '_site';
const SOURCE = 'PRIVACY.md';
const ALLOWED = ['index.html'];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const body = marked.parse(readFileSync(SOURCE, 'utf8'));

writeFileSync(
  join(outDir, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HTTPatch Privacy Policy</title>
<style>
  :root { color-scheme: light dark; }
  body {
    max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  h1 { font-size: 1.9rem; margin-bottom: .25rem; }
  h2 { margin-top: 2.2rem; font-size: 1.25rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  li { margin: .35rem 0; }
  footer { margin-top: 3rem; font-size: .85rem; opacity: .7; }
</style>
</head>
<body>
${body}
<footer>Based on HTTPatch's <code>${SOURCE}</code>.</footer>
</body>
</html>
`,
);

// Whitelist guard — fail the build rather than publish anything unexpected.
const written = readdirSync(outDir);
const unexpected = written.filter((f) => !ALLOWED.includes(f));
if (unexpected.length > 0) {
  console.error(`Refusing to publish unexpected files: ${unexpected.join(', ')}`);
  process.exit(1);
}
console.log(`Built ${outDir}/ from ${SOURCE} — contains exactly: ${written.join(', ')}`);
