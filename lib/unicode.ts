/**
 * Unicode handling (xterm.js IUnicodeHandling)
 *
 * libghostty decides character widths and grapheme clusters with the Unicode
 * tables built into the module, so there is exactly one version and it can't
 * be switched. The module doesn't report which version that is, so it is
 * recorded here for each libghostty-vt release (a test checks there is an
 * entry for the bundled one).
 */

import type { Ghostty } from './ghostty';
import type { IUnicodeHandling, IUnicodeVersionProvider } from './interfaces';

/** The Unicode version of each libghostty-vt release's tables (from its uucode dependency). */
export const UNICODE_VERSIONS: Record<string, string> = {
  '1.0.0': '18',
  '1.0.1': '18',
};

/** The newest version recorded, for a module whose release isn't listed. */
const LATEST = Object.values(UNICODE_VERSIONS).at(-1)!;

export class UnicodeHandling implements IUnicodeHandling {
  private readonly provider: IUnicodeVersionProvider;
  private warned = false;

  constructor(ghostty: Ghostty | undefined) {
    const version = UNICODE_VERSIONS[ghostty?.version ?? ''] ?? LATEST;
    this.provider = {
      version,
      wcwidth: (codepoint) => ghostty?.codepointWidth(codepoint) ?? 1,
      // xterm.js packs the width at bits 1-2; libghostty does the joining itself.
      charProperties: (codepoint) => (ghostty?.codepointWidth(codepoint) ?? 1) << 1,
    };
  }

  get versions(): readonly string[] {
    return [this.provider.version];
  }

  get activeVersion(): string {
    return this.provider.version;
  }

  /** Only the version libghostty implements can be set; anything else logs a warning once. */
  set activeVersion(version: string) {
    if (version === this.provider.version) return;
    this.warn(`activeVersion ${version} is not available`);
  }

  /** Accepted for compatibility and ignored (with a warning once): libghostty owns the widths. */
  register(provider: IUnicodeVersionProvider): void {
    this.warn(`the provider for version ${provider.version} is not used`);
  }

  /** @internal The active provider (widths from libghostty). */
  get active(): IUnicodeVersionProvider {
    return this.provider;
  }

  private warn(what: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      `unicode: ${what}; character widths come from libghostty's Unicode ${this.provider.version} tables.`
    );
  }
}
