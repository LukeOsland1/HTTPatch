// Extract one version's section from CHANGELOG.md, so the GitHub Release page
// carries the human-written notes rather than only an auto-generated list of
// merged PR titles.
//
// Usage:  node scripts/changelog-section.mjs <version> [changelog] > notes.md
//   <version> may be given with or without a leading "v" (v1.0.0 == 1.0.0).
//
// Prints nothing and exits 0 when the section is missing; release.yml treats
// empty output as an error and stops the draft release.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strip a leading "v" so a tag name and a package version are interchangeable. */
export function normalizeVersion(version) {
  return String(version).trim().replace(/^v/i, '');
}

/**
 * Return the body of the `## [<version>]` section — everything up to the next
 * top-level `## ` heading — with surrounding blank lines trimmed. Returns null
 * when there is no such section.
 *
 * Matches the heading shapes this changelog uses: `## [0.2.0] — 2026-07-30`,
 * `## [0.2.0]`, and the bare `## 0.2.0` form, all case-insensitively.
 */
export function changelogSection(markdown, version) {
  const v = normalizeVersion(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##[ \\t]+\\[?${v}\\]?(?![\\d.])[^\\n]*$`, 'im');
  const start = markdown.search(heading);
  if (start === -1) return null;

  const afterHeading = markdown.indexOf('\n', start);
  if (afterHeading === -1) return null;

  const rest = markdown.slice(afterHeading + 1);
  const next = rest.search(/^##[ \t]+/m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return body === '' ? null : body;
}

// Only run when invoked directly, so the helpers above stay importable in tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , version, file = 'CHANGELOG.md'] = process.argv;
  if (!version) {
    console.error('usage: node scripts/changelog-section.mjs <version> [changelog]');
    process.exit(2);
  }
  const section = changelogSection(readFileSync(file, 'utf8'), version);
  if (section) process.stdout.write(section + '\n');
}
