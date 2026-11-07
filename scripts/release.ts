/**
 * Cut a release: bun run release <version> [--push]
 *
 * A plain version (0.2.0) becomes a GitHub release; one with a suffix (0.2.0-rc.1) becomes a
 * prerelease. The script checks the version, the working tree and that CHANGELOG.md has entries under
 * Unreleased, runs the checks and the build, sets the version in package.json, moves the Unreleased entries under the
 * version (a release only; see scripts/changelog.ts), commits and creates the tag. Pushing the tag starts .github/workflows/release.yml,
 * which builds and publishes the GitHub release. Without --push it prints the push command instead.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CHANGELOG, cutRelease, unreleasedNotes } from './changelog';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

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

function run(cmd: string[], quiet = false): string {
  const proc = Bun.spawnSync(cmd, { stdout: quiet ? 'pipe' : 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed`);
  return quiet ? (proc.stdout?.toString() ?? '').trim() : '';
}

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const version = args.find((a) => !a.startsWith('--'));
  if (!version) fail('Usage: bun run release <version> [--push]');

  if (run(['git', 'status', '--porcelain'], true)) fail('The working tree has uncommitted changes');
  if (run(['git', 'branch', '--show-current'], true) !== 'main') fail('Releases are cut from main');
  run(['git', 'fetch', '--quiet', '--tags', 'origin']);
  if (run(['git', 'rev-parse', 'HEAD'], true) !== run(['git', 'rev-parse', 'origin/main'], true)) {
    fail('main is not the same as origin/main; pull or push first');
  }

  const problem = versionProblem(version, run(['git', 'tag', '--list'], true).split('\n'));
  if (problem) fail(problem);

  const changelog = readFileSync(CHANGELOG, 'utf8');
  if (!unreleasedNotes(changelog))
    fail(`Add the changes to ${CHANGELOG} under "## Unreleased" first`);

  for (const script of ['fmt', 'lint', 'typecheck', 'test', 'build']) run(['bun', 'run', script]);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  pkg.version = version;
  writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  if (!isPrerelease(version)) {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
    writeFileSync(CHANGELOG, cutRelease(changelog, version, today));
  }

  const tag = `v${version}`;
  run(['git', 'commit', '--quiet', '-m', `Release ${tag}`, 'package.json', CHANGELOG]);
  run(['git', 'tag', '-a', tag, '-m', tag]);
  const kind = isPrerelease(version) ? 'prerelease' : 'release';
  console.log(`✅ Tagged ${tag} (${kind}, libghostty-vt ${pkg['libghostty-vt']})`);

  if (push) {
    run(['git', 'push', '--atomic', 'origin', 'main', tag]);
    console.log('🚀 Pushed; .github/workflows/release.yml will publish it');
  } else {
    console.log(`Push to publish: git push --atomic origin main ${tag}`);
  }
}

if (import.meta.main) main();
