import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CHANGELOG,
  cli,
  cutRelease,
  releaseNotes,
  unreleasedNotes,
  versionNotes,
} from './changelog';

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

  test('the last section and a section without a date are read to the end', () => {
    const last = '# Changelog\n\n## Unreleased\n\n- Pending.\n';
    expect(unreleasedNotes(last)).toBe('- Pending.');
    expect(versionNotes('## 1.0.0\n\n- Undated.\n', '1.0.0')).toBe('- Undated.');
    // A version is matched whole: 1.0.0 is not 1.0.0-rc.1, and dots are literal.
    expect(versionNotes('## 1.0.0-rc.1 - 2026-01-01\n\n- RC.\n', '1.0.0')).toBeNull();
    expect(versionNotes('## 1x0x0 - 2026-01-01\n\n- No.\n', '1.0.0')).toBeNull();
  });

  test('a release cut when Unreleased is the last section', () => {
    const cut = cutRelease('# Changelog\n\n## Unreleased\n\n- Only.\n', '0.1.0', '2026-01-01');
    expect(cut).toBe('# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-01-01\n\n- Only.\n');
  });
});

describe('changelog notes command', () => {
  const read = () => changelog;

  test('prints the notes for a release or a prerelease', () => {
    expect(cli(['notes', '0.1.0'], read)).toEqual({ code: 0, stdout: '- First release.' });
    expect(cli(['notes', '0.2.0-rc.1'], read)).toEqual({
      code: 0,
      stdout: '- Add a thing.\n- Fix a bug.',
    });
  });

  test('fails with usage for a missing version or another command', () => {
    const usage = { code: 1, stderr: 'Usage: bun scripts/changelog.ts notes <version>' };
    expect(cli([], read)).toEqual(usage);
    expect(cli(['notes'], read)).toEqual(usage);
    expect(cli(['cut', '0.2.0'], read)).toEqual(usage);
  });

  test('fails with the reason for a version without notes', () => {
    expect(cli(['notes', '0.3.0'], read)).toEqual({
      code: 1,
      stderr: `❌ ${CHANGELOG} has no notes for 0.3.0`,
    });
    expect(
      cli(['notes', '0.3.0'], () => {
        throw 'unreadable';
      })
    ).toEqual({ code: 1, stderr: '❌ unreadable' });
  });

  test('runs as the release workflow calls it', () => {
    const ok = Bun.spawnSync(['bun', 'scripts/changelog.ts', 'notes', '0.0.1']);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString().trim()).toBe(
      versionNotes(readFileSync(CHANGELOG, 'utf8'), '0.0.1') ?? ''
    );
    const bad = Bun.spawnSync(['bun', 'scripts/changelog.ts', 'notes']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain('Usage:');
  });
});
