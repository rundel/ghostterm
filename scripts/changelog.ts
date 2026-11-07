/**
 * CHANGELOG.md helpers for releases.
 *
 * Changes are written under `## Unreleased` as they land. A release moves them under
 * `## <version> - <date>`; a prerelease leaves them in place, since its changes ship again in the
 * release that follows it.
 *
 *   bun scripts/changelog.ts notes <version>   print the notes for a version (the workflow uses this)
 */

import { readFileSync } from 'node:fs';

export const CHANGELOG = 'CHANGELOG.md';

const UNRELEASED_HEADING = '## Unreleased';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The body of the first `## ` section whose heading matches, without the heading. */
function sectionBody(changelog: string, heading: RegExp): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

/** What is under `## Unreleased`; throws if the heading is missing. */
export function unreleasedNotes(changelog: string): string {
  const body = sectionBody(changelog, new RegExp(`^${escapeRegExp(UNRELEASED_HEADING)}\\s*$`));
  if (body === null) throw new Error(`${CHANGELOG} has no "${UNRELEASED_HEADING}" section`);
  return body;
}

/** The notes of a released version, or null if it has no section. */
export function versionNotes(changelog: string, version: string): string | null {
  return sectionBody(changelog, new RegExp(`^## ${escapeRegExp(version)}(\\s|$)`));
}

/** Moves the Unreleased notes under a new `## <version> - <date>` heading, leaving Unreleased empty. */
export function cutRelease(changelog: string, version: string, date: string): string {
  const notes = unreleasedNotes(changelog);
  if (!notes) throw new Error(`Nothing under "${UNRELEASED_HEADING}" in ${CHANGELOG}`);
  if (versionNotes(changelog, version) !== null) {
    throw new Error(`${CHANGELOG} already has a section for ${version}`);
  }
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  const section = [UNRELEASED_HEADING, '', `## ${version} - ${date}`, '', notes, ''];
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n');
}

/** The notes a GitHub release shows: its section for a release, Unreleased for a prerelease. */
export function releaseNotes(changelog: string, version: string): string {
  const notes = version.includes('-')
    ? unreleasedNotes(changelog)
    : versionNotes(changelog, version);
  if (!notes) throw new Error(`${CHANGELOG} has no notes for ${version}`);
  return notes;
}

if (import.meta.main) {
  const [command, version] = process.argv.slice(2);
  if (command !== 'notes' || !version) {
    console.error('Usage: bun scripts/changelog.ts notes <version>');
    process.exit(1);
  }
  try {
    console.log(releaseNotes(readFileSync(CHANGELOG, 'utf8'), version));
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
