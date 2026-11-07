import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CHANGELOG, cutRelease, releaseNotes, unreleasedNotes, versionNotes } from './changelog';

const changelog = `# Changelog

Intro.

## Unreleased

- Add a thing.
- Fix a bug.

## 0.1.0 - 2026-01-01

- First release.
`;

describe('changelog', () => {
  test('reads the Unreleased and per-version notes', () => {
    expect(unreleasedNotes(changelog)).toBe('- Add a thing.\n- Fix a bug.');
    expect(versionNotes(changelog, '0.1.0')).toBe('- First release.');
    expect(versionNotes(changelog, '0.1')).toBeNull();
    expect(versionNotes(changelog, '0.2.0')).toBeNull();
  });

  test('a release moves Unreleased under its version and leaves Unreleased empty', () => {
    const cut = cutRelease(changelog, '0.2.0', '2026-02-01');
    expect(cut).toBe(`# Changelog

Intro.

## Unreleased

## 0.2.0 - 2026-02-01

- Add a thing.
- Fix a bug.

## 0.1.0 - 2026-01-01

- First release.
`);
    expect(unreleasedNotes(cut)).toBe('');
    expect(releaseNotes(cut, '0.2.0')).toBe('- Add a thing.\n- Fix a bug.');
  });

  test('a prerelease shows the Unreleased notes', () => {
    expect(releaseNotes(changelog, '0.2.0-rc.1')).toBe('- Add a thing.\n- Fix a bug.');
  });

  test('refuses an empty Unreleased, a duplicate version or a missing section', () => {
    const empty = cutRelease(changelog, '0.2.0', '2026-02-01');
    expect(() => cutRelease(empty, '0.3.0', '2026-03-01')).toThrow(/Nothing under/);
    expect(() => cutRelease(changelog, '0.1.0', '2026-03-01')).toThrow(/already has/);
    expect(() => unreleasedNotes('# Changelog\n')).toThrow(/no "## Unreleased"/);
    expect(() => releaseNotes(empty, '0.3.0-rc.1')).toThrow(/no notes/);
  });

  test("the repository's changelog has an Unreleased section and notes for every release tag", () => {
    const text = readFileSync(CHANGELOG, 'utf8');
    expect(() => unreleasedNotes(text)).not.toThrow();
    const tags = Bun.spawnSync(['git', 'tag', '--list', 'v*'])
      .stdout.toString()
      .split('\n')
      .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
    for (const tag of tags) expect(versionNotes(text, tag.slice(1))).toBeTruthy();
  });
});
