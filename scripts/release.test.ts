import { describe, expect, test } from 'bun:test';
import { isPrerelease, versionProblem } from './release';

describe('release versions', () => {
  const tags = ['v0.1.0', 'v0.2.0-rc.1', 'not-a-version'];

  test('accepts a newer release or prerelease', () => {
    expect(versionProblem('0.2.0', tags)).toBeNull();
    expect(versionProblem('0.2.0-rc.2', tags)).toBeNull();
    expect(versionProblem('0.10.0', ['v0.9.0'])).toBeNull();
    expect(versionProblem('0.1.0', [])).toBeNull();
  });

  test('rejects existing, older and malformed versions', () => {
    expect(versionProblem('0.1.0', tags)).toMatch(/already exists/);
    expect(versionProblem('0.2.0-rc.0', tags)).toMatch(/not newer than existing tag v0.2.0-rc.1/);
    expect(versionProblem('0.0.9', tags)).toMatch(/not newer/);
    expect(versionProblem('v0.3.0', tags)).toMatch(/not a version/);
    expect(versionProblem('0.3', tags)).toMatch(/not a version/);
  });

  test('a suffix marks a prerelease', () => {
    expect(isPrerelease('0.2.0-rc.1')).toBe(true);
    expect(isPrerelease('0.2.0')).toBe(false);
  });
});
