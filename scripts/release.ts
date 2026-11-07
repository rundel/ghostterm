/**
 * Cut a release: bun run release <version> [--push]
 *
 * A plain version (0.2.0) becomes a GitHub release; one with a suffix (0.2.0-rc.1) becomes a
 * prerelease. The script checks the version, the working tree and that CHANGELOG.md has entries
 * under Unreleased, runs the checks and the build, sets the version in package.json, moves the
 * Unreleased entries under the version (a release only; see scripts/changelog.ts), commits and
 * creates the tag. Pushing the tag starts .github/workflows/release.yml, which builds and
 * publishes the GitHub release. Without --push it prints the push command instead.
 *
 * `release()` does the work through injected `ReleaseDeps` (commands, files, date, output), so
 * scripts/release.test.ts can run it against a scripted git without a repository or a remote.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CHANGELOG, cutRelease, unreleasedNotes } from './changelog';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The package scripts a release runs, in order, before it changes anything. */
export const CHECKS = ['fmt', 'lint', 'typecheck', 'test', 'build'] as const;

/** Why `next` can't be released given the existing tags, or null if it can. */
export function versionProblem(next: string, tags: string[]): string | null {
  if (!SEMVER.test(next)) return `${next} is not a version like 1.2.3 or 1.2.3-rc.1`;
  const versions = tags.filter((t) => t.startsWith('v')).map((t) => t.slice(1));
  if (versions.includes(next)) return `v${next} already exists`;
  const newer = versions.filter((v) => SEMVER.test(v) && Bun.semver.order(v, next) >= 0);
  if (newer.length > 0)
    return `${next} is not newer than existing tag v${newer.sort(Bun.semver.order).at(-1)}`;
  return null;
}

/** Whether a version is a prerelease (has a suffix after the patch number). */
export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/** A release that can't go ahead; main() prints the message and exits with status 1. */
export class ReleaseError extends Error {}

export interface ReleaseArgs {
  version: string;
  push: boolean;
}

/** The version and --push flag from the command line. */
export function parseArgs(argv: string[]): ReleaseArgs {
  const version = argv.find((a) => !a.startsWith('--'));
  if (!version) throw new ReleaseError('Usage: bun run release <version> [--push]');
  return { version, push: argv.includes('--push') };
}

export interface ReleaseDeps {
  /** Run a command with its output shown; throws if it fails. */
  run(cmd: string[]): void;
  /** Run a command and return its trimmed stdout; throws if it fails. */
  read(cmd: string[]): string;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  /** Today's date as YYYY-MM-DD. */
  today(): string;
  log(message: string): void;
}

/**
 * Why the repository isn't ready to release `version`, or null: the tree must be clean, on main,
 * equal to origin/main after fetching its tags, and the version newer than every v* tag.
 */
export function repoProblem(deps: ReleaseDeps, version: string): string | null {
  if (deps.read(['git', 'status', '--porcelain']))
    return 'The working tree has uncommitted changes';
  if (deps.read(['git', 'branch', '--show-current']) !== 'main')
    return 'Releases are cut from main';
  deps.run(['git', 'fetch', '--quiet', '--tags', 'origin']);
  if (deps.read(['git', 'rev-parse', 'HEAD']) !== deps.read(['git', 'rev-parse', 'origin/main'])) {
    return 'main is not the same as origin/main; pull or push first';
  }
  return versionProblem(version, deps.read(['git', 'tag', '--list']).split('\n'));
}

/** Check, build, then commit and tag `version` (and push it with `push`). */
export function release({ version, push }: ReleaseArgs, deps: ReleaseDeps): void {
  const problem = repoProblem(deps, version);
  if (problem) throw new ReleaseError(problem);

  const changelog = deps.readFile(CHANGELOG);
  if (!unreleasedNotes(changelog)) {
    throw new ReleaseError(`Add the changes to ${CHANGELOG} under "## Unreleased" first`);
  }

  for (const script of CHECKS) deps.run(['bun', 'run', script]);

  const pkg = JSON.parse(deps.readFile('package.json'));
  pkg.version = version;
  deps.writeFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  if (!isPrerelease(version)) {
    deps.writeFile(CHANGELOG, cutRelease(changelog, version, deps.today()));
  }

  const tag = `v${version}`;
  deps.run(['git', 'commit', '--quiet', '-m', `Release ${tag}`, 'package.json', CHANGELOG]);
  deps.run(['git', 'tag', '-a', tag, '-m', tag]);
  const kind = isPrerelease(version) ? 'prerelease' : 'release';
  deps.log(`✅ Tagged ${tag} (${kind}, libghostty-vt ${pkg['libghostty-vt']})`);

  if (push) {
    deps.run(['git', 'push', '--atomic', 'origin', 'main', tag]);
    deps.log('🚀 Pushed; .github/workflows/release.yml will publish it');
  } else {
    deps.log(`Push to publish: git push --atomic origin main ${tag}`);
  }
}

function spawn(cmd: string[], quiet: boolean): string {
  const proc = Bun.spawnSync(cmd, { stdout: quiet ? 'pipe' : 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) throw new ReleaseError(`${cmd.join(' ')} failed`);
  return quiet ? (proc.stdout?.toString() ?? '').trim() : '';
}

/** The real commands, files and clock. */
export const systemDeps: ReleaseDeps = {
  run: (cmd) => void spawn(cmd, false),
  read: (cmd) => spawn(cmd, true),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, text) => writeFileSync(path, text),
  today: () => new Date().toLocaleDateString('en-CA'), // YYYY-MM-DD, local time
  log: (message) => console.log(message),
};

if (import.meta.main) {
  try {
    release(parseArgs(process.argv.slice(2)), systemDeps);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
