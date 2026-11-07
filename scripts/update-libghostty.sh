#!/bin/bash
set -euo pipefail

# Move the pinned libghostty-vt release in scripts/fetch-wasm.sh to a new version.
#
#   ./scripts/update-libghostty.sh --check     print the pinned and latest versions, change nothing
#   ./scripts/update-libghostty.sh             update to the latest release
#   ./scripts/update-libghostty.sh 1.1.0       update to a specific release
#
# Releases are the vt-X.Y.Z tags in ghostty-org/ghostty. The new checksums come from the release's
# SHA256SUMS, whose minisign signature is checked against Ghostty's public key when minisign is
# installed. The script then downloads both WASM builds through fetch-wasm.sh.

REPO="ghostty-org/ghostty"
RELEASE_URL="https://release.files.ghostty.org/libghostty-vt"
# Ghostty's release signing key, from https://lib.ghostty.org/installing.html
MINISIGN_KEY="RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV"

cd "$(dirname "$0")/.."
PIN_FILE="scripts/fetch-wasm.sh"

current="$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$PIN_FILE")"
if [ -z "$current" ]; then
    echo "❌ No VERSION=\"...\" line in $PIN_FILE" >&2
    exit 1
fi

latest_release() {
    curl --fail --silent --show-error --location \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$REPO/git/matching-refs/tags/vt-" |
        grep -oE '"ref": *"refs/tags/vt-[0-9]+\.[0-9]+\.[0-9]+"' |
        sed -E 's/.*vt-([0-9.]+)"/\1/' |
        sort -t. -k1,1n -k2,2n -k3,3n |
        tail -1
}

check=false
target=""
case "${1:-}" in
    --check) check=true ;;
    "") ;;
    *) target="$1" ;;
esac

if [ -z "$target" ]; then
    target="$(latest_release)"
    if [ -z "$target" ]; then
        echo "❌ Found no vt-X.Y.Z tags in $REPO" >&2
        exit 1
    fi
fi

if ! [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ Expected a version like 1.1.0, got '$target'" >&2
    exit 1
fi

echo "pinned: $current"
echo "latest: $target"
if $check; then
    [ "$current" = "$target" ] && echo "up to date" || echo "update available"
    exit 0
fi

if [ "$current" = "$target" ]; then
    echo "✓ Already on libghostty-vt $current"
    exit 0
fi

lowest="$(printf '%s\n%s\n' "$current" "$target" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)"
if [ "$lowest" = "$target" ]; then
    echo "❌ $target is older than the pinned $current; package versions must not go backwards" >&2
    exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "⬇️  Fetching SHA256SUMS for libghostty-vt $target..."
curl --fail --silent --show-error --location -o "$tmp/SHA256SUMS" "$RELEASE_URL/$target/SHA256SUMS"
curl --fail --silent --show-error --location -o "$tmp/SHA256SUMS.minisig" \
    "$RELEASE_URL/$target/SHA256SUMS.minisig"

if command -v minisign &> /dev/null; then
    minisign -Vq -P "$MINISIGN_KEY" -m "$tmp/SHA256SUMS" -x "$tmp/SHA256SUMS.minisig"
    echo "✅ SHA256SUMS signature verified"
else
    echo "⚠️  minisign is not installed; SHA256SUMS signature NOT verified"
fi

hash_of() {
    awk -v f="$1" '$2 == f { print $1 }' "$tmp/SHA256SUMS"
}
small="$(hash_of "ghostty-vt-$target-small.wasm")"
fast="$(hash_of "ghostty-vt-$target.wasm")"
if [ -z "$small" ] || [ -z "$fast" ]; then
    echo "❌ SHA256SUMS for $target lacks ghostty-vt-$target-small.wasm or ghostty-vt-$target.wasm:" >&2
    cat "$tmp/SHA256SUMS" >&2
    exit 1
fi

sed -i.bak \
    -e "s/^VERSION=\".*\"$/VERSION=\"$target\"/" \
    -e "s/^SMALL_SHA256=\".*\"$/SMALL_SHA256=\"$small\"/" \
    -e "s/^FAST_SHA256=\".*\"$/FAST_SHA256=\"$fast\"/" \
    "$PIN_FILE"
rm -f "$PIN_FILE.bak"

# package.json records the bundled release for users and the release notes.
sed -i.bak -E "s/^(  \"libghostty-vt\": )\"[^\"]*\"/\1\"$target\"/" package.json
rm -f package.json.bak
if ! grep -q "^  \"libghostty-vt\": \"$target\"" package.json; then
    echo "❌ package.json has no top-level \"libghostty-vt\" field to update" >&2
    exit 1
fi
echo "✅ Pinned libghostty-vt $target in $PIN_FILE and package.json"

./scripts/fetch-wasm.sh

echo
echo "Changes: https://github.com/$REPO/compare/vt-$current...vt-$target"
