import { describe, expect, it } from 'vitest';
// Plain .mjs script with no type declarations, imported for its pure helpers.
// @ts-expect-error -- changelog-section.mjs is plain JS with no .d.ts
import { changelogSection, normalizeVersion } from '../scripts/changelog-section.mjs';

const CHANGELOG = `# Changelog
## [Unreleased]
Future work
## [0.2.0] — 2026-07-30
### Added
- Profile sync across devices
## [0.1.0] — 2026-07-01
Initial release
`;

describe('normalizeVersion', () => {
  it('treats a tag name and a package version as the same thing', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0');
    expect(normalizeVersion('0.2.0')).toBe('0.2.0');
    expect(normalizeVersion('  V1.2.3 ')).toBe('1.2.3');
  });
});

describe('changelogSection', () => {
  it('extracts the requested release without unreleased or older entries', () => {
    const section = changelogSection(CHANGELOG, 'v0.2.0');
    expect(section).toContain('Profile sync across devices');
    // Stops at the next version heading rather than running to the end of the file.
    expect(section).not.toContain('## [0.1');
    expect(section).not.toContain('Future work');
  });

  it('finds the section whether or not the tag carries a leading v', () => {
    expect(changelogSection(CHANGELOG, '0.2.0')).toBe(changelogSection(CHANGELOG, 'v0.2.0'));
  });

  it('returns null for a version that was never released', () => {
    expect(changelogSection(CHANGELOG, '9.9.9')).toBeNull();
  });

  it('does not confuse 0.1.1 with 0.1.10', () => {
    const md = [
      '## [0.1.10] — 2026-01-02',
      '',
      'ten',
      '',
      '## [0.1.1] — 2026-01-01',
      '',
      'one',
    ].join('\n');
    expect(changelogSection(md, '0.1.1')).toBe('one');
    expect(changelogSection(md, '0.1.10')).toBe('ten');
  });

  it('handles a heading with no date and a bare heading with no brackets', () => {
    expect(changelogSection('## [1.0.0]\n\nbody', '1.0.0')).toBe('body');
    expect(changelogSection('## 1.0.0\n\nbody', '1.0.0')).toBe('body');
  });

  it('returns null for a section that exists but is empty', () => {
    expect(changelogSection('## [1.0.0]\n\n## [0.9.0]\n\nold', '1.0.0')).toBeNull();
  });

  it('keeps the ### subheadings, which are what make the release page readable', () => {
    expect(changelogSection(CHANGELOG, '0.2.0')).toMatch(/^### Added/);
  });
});
