---
name: bump-libghostty
description: Check for a new libghostty-vt release and move ghostty-web onto it - repin and verify the WASM builds, review upstream ABI and behavior changes against what the bridge relies on, update code, tests and docs, record the new release in package.json, and choose the commit type that sets the next semver bump. Use when asked to bump, upgrade or update libghostty / libghostty-vt / ghostty-vt.wasm, check whether a new libghostty release is out, or do a "version bump" for this project.
---

# Bump libghostty-vt

ghostty-web's version is its own semver, independent of libghostty-vt's numbers. The bundled libghostty-vt
release is recorded in two places that must agree (a test in `lib/ghostty.test.ts` checks them against the loaded
module): `VERSION` in `scripts/fetch-wasm.sh`, which decides what is downloaded, and the `libghostty-vt` field in
`package.json`, which users see and which release-please puts at the top of the release notes ("Built on
libghostty-vt X.Y.Z.").

So bumping libghostty means changing those two, making the code correct for the new release, and picking the
commit type. Do not edit `version` in `package.json`, `demo/package.json`, `flake.nix` or
`.release-please-manifest.json`; release-please sets those from the commit types in its release PR.

## 1. Check for a release

```sh
./scripts/update-libghostty.sh --check
```

It prints the pinned version and the newest `vt-X.Y.Z` tag in `ghostty-org/ghostty`. If they match, tell the user
it is up to date and stop. If the user named a version, use that instead of the latest. Only move forward; the
script refuses older versions.

If the new release is a new major version, stop and tell the user before going further: the C ABI promise only
holds within a major version, so expect renamed or removed functions and plan that work with them.

## 2. Read what changed upstream

Before touching the pin, find out what the bridge has to deal with. Use `OLD` and `NEW` from step 1.

The tags carry no release notes and GitHub's compare API stops at 250 commits and 300 files, so use a blobless
clone of Ghostty in your scratchpad (`GHOSTTY` below):

```sh
git clone --filter=blob:none --no-checkout https://github.com/ghostty-org/ghostty "$GHOSTTY"
git -C "$GHOSTTY" diff --stat vt-OLD vt-NEW -- include/
```

- Header changes are the ABI changes: `git -C "$GHOSTTY" diff vt-OLD vt-NEW -- include/`. Within a major version
  a release may only add functions, types, enum values and fields at the end of sized structs; anything else is
  worth flagging to the user. Look especially for new `GHOSTTY_DEPRECATED` markers on functions the bridge calls
  (`grep -n "ghostty_" lib/types.ts` lists every export it uses).

- Behavior changes:
  `git -C "$GHOSTTY" log --oneline vt-OLD..vt-NEW -- src/terminal src/input include src/lib_vt.zig`. The repo
  is all of Ghostty, so most commits elsewhere don't affect libghostty-vt.

- The release's docs: `https://release.files.ghostty.org/libghostty-vt/NEW/libghostty-vt-NEW-docs.zip`, or
  https://lib.ghostty.org/ once it shows NEW. Unpack into a fresh scratch directory and read the pages for the
  areas the headers changed.

Put downloads in your scratchpad, not the repo.

## 3. Repin and fetch

```sh
./scripts/update-libghostty.sh NEW
```

This takes the checksums of both WASM builds from the release's `SHA256SUMS`, verifies that file's minisign
signature against Ghostty's key, rewrites `VERSION`, `SMALL_SHA256` and `FAST_SHA256` in `scripts/fetch-wasm.sh`
and the `libghostty-vt` field in `package.json`, and downloads `ghostty-vt.wasm` and `ghostty-vt-fast.wasm`. If it warns that minisign is not installed, tell the
user the signature was not checked. If the release lacks either WASM file, stop and report it; don't fall back
to one build.

## 4. Make the code right for the new release

Run the full check from CLAUDE.md:

```sh
bun run fmt && bun run lint && bun run typecheck && bun test && bun run build
```

What failures usually mean:

- `lib/abi-enums.test.ts`: an enum constant in `lib/types.ts` no longer matches the module. Fix the constant
  from the new header.
- `AbiLayout` throws while loading: a manifest field the bridge reads is missing or renamed. Fix the lookup in
  `lib/abi.ts`, using `ghostty_type_json()` from the new module as the source of truth.
- WASM size check in CI (1 MiB on `ghostty-vt.wasm`): report the new size to the user rather than raising the
  limit yourself.

Then go through what passing tests don't prove:

- Every item under "Known libghostty-vt ... quirks" in CLAUDE.md. For each, check whether NEW fixed it (release
  docs, headers, commits). If it is fixed, remove the workaround and its comment in `lib/`, add or adjust a test,
  and drop the item. If it still applies, leave it.
- Any version-specific comments in `lib/` (`grep -rn "libghostty-vt [0-9]" lib CLAUDE.md README.md`).
- New functions or options that replace TypeScript doing terminal work, per the guiding rule in CLAUDE.md.
  List them for the user; adopt one in this bump only if the user asks or it is a small direct swap.
- Behavior changes the README's "Behavior worth knowing" should mention.

Check `bun run demo:dev` in a browser if the change touches rendering, input or selection, or tell the user
that only the test suite was run.

## 5. Update the docs

- CLAUDE.md: the version in the "Known libghostty-vt X.Y quirks" heading and the quirks list itself.
- README.md: anything from step 4 that users would notice.
- Leave CHANGELOG.md alone; release-please writes it.

## 6. Commit (only when the user asks)

Work on a branch, never `main`, in one commit. The subject's type sets the next release's semver bump, so pick
it from what users get:

| The bump ...                                                         | Subject                                    |
| -------------------------------------------------------------------- | ------------------------------------------ |
| brings behavior or API users can use (usually a libghostty minor)    | `feat(deps): update libghostty-vt to NEW`  |
| fixes things or changes nothing visible (usually a libghostty patch) | `deps: update libghostty-vt to NEW`        |
| forces a breaking change in ghostty-web's own API                    | `feat(deps)!: update libghostty-vt to NEW` |

`feat` lists the change under Features and `deps` under Dependencies; both pass the PR title check. When it isn't
obvious, ask the user which applies. A libghostty-vt major version does not by itself mean a ghostty-web major:
only a breaking change to ghostty-web's API does.

Don't commit `ghostty-vt.wasm` or `ghostty-vt-fast.wasm` (they are gitignored), and don't commit `bun.lock`
unless dependencies changed.

## 7. Report

Tell the user: OLD → NEW, whether the signature was verified, the new WASM sizes, what upstream changed that
matters here, what you changed (code, tests, quirks removed or kept), what you didn't verify, and the commit type you chose
or recommend and the semver bump it leads to.
