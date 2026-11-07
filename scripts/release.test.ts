import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG } from './changelog';
import {
  CHECKS,
  type ReleaseDeps,
  ReleaseError,
  isPrerelease,
  parseArgs,
  release,
  repoProblem,
  systemDeps,
  versionProblem,
} from './release';

describe('release versions', () => {
  const tags = ['v0.1.0', 'v0.2.0-rc.1', 'not-a-version'];

  test('accepts a newer release or prerelease', () => {
    expect(versionProblem('0.2.0', tags)).toBeNull();
    expect(versionProblem('0.2.0-rc.2', tags)).toBeNull();
    expect(versionProblem('0.10.0', ['v0.9.0'])).toBeNull();
    expect(versionProblem('0.1.0', [])).toBeNull();
    expect(versionProblem('1.0.0-alpha.beta-1', tags)).toBeNull();
  });

  test('rejects existing, older and malformed versions', () => {
    expect(versionProblem('0.1.0', tags)).toBe('v0.1.0 already exists');
    expect(versionProblem('0.2.0-rc.0', tags)).toBe(
      '0.2.0-rc.0 is not newer than existing tag v0.2.0-rc.1'
    );
    expect(versionProblem('0.0.9', ['v0.1.0', 'v0.0.10', 'v0.1.0-rc.1'])).toBe(
      '0.0.9 is not newer than existing tag v0.1.0'
    );
    expect(versionProblem('v0.3.0', tags)).toBe('v0.3.0 is not a version like 1.2.3 or 1.2.3-rc.1');
    expect(versionProblem('0.3', tags)).toMatch(/not a version/);
    expect(versionProblem('0.3.0-', tags)).toMatch(/not a version/);
    expect(versionProblem('0.3.0+build', tags)).toMatch(/not a version/);
  });

  test('a release is newer than its own prereleases, a prerelease is not newer than its release', () => {
    expect(versionProblem('0.3.0', ['v0.3.0-rc.2'])).toBeNull();
    expect(versionProblem('0.3.0-rc.3', ['v0.3.0'])).toMatch(/not newer than existing tag v0.3.0/);
  });

  test('a suffix marks a prerelease', () => {
    expect(isPrerelease('0.2.0-rc.1')).toBe(true);
    expect(isPrerelease('0.2.0')).toBe(false);
  });
});

describe('release arguments', () => {
  test('takes the version and --push in any order', () => {
    expect(parseArgs(['0.2.0'])).toEqual({ version: '0.2.0', push: false });
    expect(parseArgs(['--push', '0.2.0'])).toEqual({ version: '0.2.0', push: true });
    expect(parseArgs(['0.2.0', '--push'])).toEqual({ version: '0.2.0', push: true });
  });

  test('requires a version', () => {
    expect(() => parseArgs([])).toThrow(ReleaseError);
    expect(() => parseArgs(['--push'])).toThrow('Usage: bun run release <version> [--push]');
  });
});

const CHANGES = `# Changelog

## Unreleased

- Add a thing.

## 0.1.0 - 2026-01-01

- First release.
`;

const PACKAGE = `${JSON.stringify({ name: 'ghostterm', version: '0.1.0', 'libghostty-vt': '1.0.0' }, null, 2)}\n`;

interface Repo {
  status?: string;
  branch?: string;
  head?: string;
  originMain?: string;
  tags?: string[];
  changelog?: string;
  /** A command (joined with spaces) that fails. */
  failing?: string;
}

/** Scripted git and files: records every command, write and log line. */
function fakeRepo(repo: Repo = {}) {
  const commands: string[] = [];
  const logs: string[] = [];
  const files = new Map<string, string>([
    [CHANGELOG, repo.changelog ?? CHANGES],
    ['package.json', PACKAGE],
  ]);
  const writes: string[] = [];
  const outputs: Record<string, string> = {
    'git status --porcelain': repo.status ?? '',
    'git branch --show-current': repo.branch ?? 'main',
    'git rev-parse HEAD': repo.head ?? 'abc123',
    'git rev-parse origin/main': repo.originMain ?? repo.head ?? 'abc123',
    'git tag --list': (repo.tags ?? ['v0.1.0']).join('\n'),
  };
  const exec = (cmd: string[]): string => {
    const line = cmd.join(' ');
    commands.push(line);
    if (line === repo.failing) throw new ReleaseError(`${line} failed`);
    return outputs[line] ?? '';
  };
  const deps: ReleaseDeps = {
    run: (cmd) => void exec(cmd),
    read: exec,
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeFile: (path, text) => {
      writes.push(path);
      files.set(path, text);
    },
    today: () => '2026-02-01',
    log: (message) => logs.push(message),
  };
  return { deps, commands, logs, files, writes };
}

const REPO_CHECKS = [
  'git status --porcelain',
  'git branch --show-current',
  'git fetch --quiet --tags origin',
  'git rev-parse HEAD',
  'git rev-parse origin/main',
  'git tag --list',
];
const BUILD_CHECKS = CHECKS.map((script) => `bun run ${script}`);

describe('release repository checks', () => {
  test('a clean main equal to origin/main with an older tag is ready', () => {
    const { deps, commands } = fakeRepo();
    expect(repoProblem(deps, '0.2.0')).toBeNull();
    expect(commands).toEqual(REPO_CHECKS);
  });

  test('refuses uncommitted changes before anything else', () => {
    const { deps, commands } = fakeRepo({ status: ' M lib/terminal.ts' });
    expect(repoProblem(deps, '0.2.0')).toBe('The working tree has uncommitted changes');
    expect(commands).toEqual(['git status --porcelain']);
  });

  test('refuses another branch, before fetching', () => {
    const { deps, commands } = fakeRepo({ branch: 'feature' });
    expect(repoProblem(deps, '0.2.0')).toBe('Releases are cut from main');
    expect(commands).not.toContain('git fetch --quiet --tags origin');
  });

  test('refuses a detached HEAD (no current branch)', () => {
    const { deps } = fakeRepo({ branch: '' });
    expect(repoProblem(deps, '0.2.0')).toBe('Releases are cut from main');
  });

  test('refuses main ahead of or behind origin/main', () => {
    const { deps } = fakeRepo({ head: 'abc123', originMain: 'def456' });
    expect(repoProblem(deps, '0.2.0')).toBe(
      'main is not the same as origin/main; pull or push first'
    );
  });

  test('checks the version against the fetched tags', () => {
    expect(repoProblem(fakeRepo({ tags: ['v0.1.0', 'v0.2.0'] }).deps, '0.2.0')).toBe(
      'v0.2.0 already exists'
    );
    expect(repoProblem(fakeRepo({ tags: [] }).deps, '0.0.1')).toBeNull();
    expect(repoProblem(fakeRepo().deps, '0.2')).toMatch(/not a version/);
  });

  test('a failed fetch stops the release', () => {
    const { deps } = fakeRepo({ failing: 'git fetch --quiet --tags origin' });
    expect(() => repoProblem(deps, '0.2.0')).toThrow('git fetch --quiet --tags origin failed');
  });
});

describe('release', () => {
  test('a release checks, builds, cuts the changelog, commits and tags, then prints the push', () => {
    const { deps, commands, logs, files, writes } = fakeRepo();
    release({ version: '0.2.0', push: false }, deps);
    expect(commands).toEqual([
      ...REPO_CHECKS,
      ...BUILD_CHECKS,
      `git commit --quiet -m Release v0.2.0 package.json ${CHANGELOG}`,
      'git tag -a v0.2.0 -m v0.2.0',
    ]);
    expect(writes).toEqual(['package.json', CHANGELOG]);
    expect(JSON.parse(files.get('package.json')!).version).toBe('0.2.0');
    expect(files.get('package.json')!.endsWith('}\n')).toBe(true);
    expect(files.get(CHANGELOG)).toContain(
      '## Unreleased\n\n## 0.2.0 - 2026-02-01\n\n- Add a thing.'
    );
    expect(logs).toEqual([
      '✅ Tagged v0.2.0 (release, libghostty-vt 1.0.0)',
      'Push to publish: git push --atomic origin main v0.2.0',
    ]);
  });

  test('a prerelease leaves the changelog alone', () => {
    const { deps, commands, logs, files, writes } = fakeRepo();
    release({ version: '0.2.0-rc.1', push: false }, deps);
    expect(writes).toEqual(['package.json']);
    expect(files.get(CHANGELOG)).toBe(CHANGES);
    expect(commands.slice(-2)).toEqual([
      `git commit --quiet -m Release v0.2.0-rc.1 package.json ${CHANGELOG}`,
      'git tag -a v0.2.0-rc.1 -m v0.2.0-rc.1',
    ]);
    expect(logs[0]).toBe('✅ Tagged v0.2.0-rc.1 (prerelease, libghostty-vt 1.0.0)');
  });

  test('--push pushes main and the tag atomically', () => {
    const { deps, commands, logs } = fakeRepo();
    release({ version: '0.2.0', push: true }, deps);
    expect(commands.at(-1)).toBe('git push --atomic origin main v0.2.0');
    expect(logs.at(-1)).toBe('🚀 Pushed; .github/workflows/release.yml will publish it');
  });

  test('a repository problem stops it before the checks', () => {
    const { deps, commands, writes } = fakeRepo({ branch: 'feature' });
    expect(() => release({ version: '0.2.0', push: true }, deps)).toThrow(
      new ReleaseError('Releases are cut from main')
    );
    expect(commands.some((c) => c.startsWith('bun run'))).toBe(false);
    expect(writes).toEqual([]);
  });

  test('an empty or missing Unreleased stops it before the checks', () => {
    const empty = fakeRepo({
      changelog: '# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-01-01\n',
    });
    expect(() => release({ version: '0.2.0', push: false }, empty.deps)).toThrow(
      `Add the changes to ${CHANGELOG} under "## Unreleased" first`
    );
    expect(empty.commands).toEqual(REPO_CHECKS);

    const missing = fakeRepo({ changelog: '# Changelog\n' });
    expect(() => release({ version: '0.2.0', push: false }, missing.deps)).toThrow(
      'has no "## Unreleased" section'
    );
  });

  test('a failing check stops it before anything is written', () => {
    const { deps, commands, writes } = fakeRepo({ failing: 'bun run test' });
    expect(() => release({ version: '0.2.0', push: true }, deps)).toThrow('bun run test failed');
    expect(commands.at(-1)).toBe('bun run test');
    expect(writes).toEqual([]);
  });
});

describe('system commands', () => {
  test('read returns trimmed stdout and a failing command throws', () => {
    expect(systemDeps.read(['echo', '  hello  '])).toBe('hello');
    expect(() => systemDeps.read(['false'])).toThrow(new ReleaseError('false failed'));
    expect(() => systemDeps.run(['true'])).not.toThrow();
    expect(() => systemDeps.run(['false'])).toThrow('false failed');
    expect(systemDeps.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('files and output go to the file system and the console', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghostterm-release-'));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const file = path.join(dir, 'package.json');
      systemDeps.writeFile(file, '{}\n');
      expect(systemDeps.readFile(file)).toBe('{}\n');
      systemDeps.log('tagged');
      expect(log).toHaveBeenCalledWith('tagged');
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the script prints the usage and exits 1 without a version', () => {
    const proc = Bun.spawnSync(['bun', 'scripts/release.ts']);
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString().trim()).toBe('❌ Usage: bun run release <version> [--push]');
  });
});
