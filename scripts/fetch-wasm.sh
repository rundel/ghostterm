#!/bin/bash
set -euo pipefail

# Download the official prebuilt libghostty-vt WebAssembly modules.
#
# Ghostty publishes two builds with each libghostty-vt release. Both have every
# feature enabled; they differ only in optimization mode:
#
#   ghostty-vt.wasm       size-optimized (ReleaseSmall), the default
#   ghostty-vt-fast.wasm  speed-optimized (ReleaseFast), opt-in, 10-20% faster
#                         on escape-sequence-heavy output and about 1.5x larger
#
# The version and checksums are pinned here; bump them together. Checksums come
# from the release's SHA256SUMS file, which is signed with Ghostty's minisign
# key (see https://lib.ghostty.org/ "Release Files").

VERSION="1.0.0"
SMALL_SHA256="dad8e14ce8da57db3864f66ae36caf66a17c4e2691ad0a0110e05c746de047a4"
FAST_SHA256="7b428fee6d0677bc81279458f8f9a3335454834123a9ff47efb3fd177f6da5a8"
BASE_URL="https://release.files.ghostty.org/libghostty-vt/${VERSION}"

sha256() {
    if command -v sha256sum &> /dev/null; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# fetch <release file> <output file> <sha256>
fetch() {
    local file="$1" out="$2" expected="$3"

    if [ -f "$out" ] && [ "$(sha256 "$out")" = "$expected" ]; then
        echo "✓ $out is already libghostty-vt $VERSION"
        return
    fi

    echo "⬇️  Downloading libghostty-vt $VERSION ($file)..."
    local tmp
    tmp="$(mktemp)"
    curl --fail --silent --show-error --location --output "$tmp" "$BASE_URL/$file" || {
        rm -f "$tmp"
        exit 1
    }

    local actual
    actual="$(sha256 "$tmp")"
    if [ "$actual" != "$expected" ]; then
        rm -f "$tmp"
        echo "❌ Checksum mismatch for $file"
        echo "   expected $expected"
        echo "   got      $actual"
        exit 1
    fi

    mv "$tmp" "$out"
    echo "✅ $out is libghostty-vt $VERSION ($(du -h "$out" | cut -f1))"
}

fetch "ghostty-vt-${VERSION}-small.wasm" "ghostty-vt.wasm" "$SMALL_SHA256"
fetch "ghostty-vt-${VERSION}.wasm" "ghostty-vt-fast.wasm" "$FAST_SHA256"
