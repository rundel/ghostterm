#!/bin/bash
set -euo pipefail

# Download the official prebuilt libghostty-vt WebAssembly module.
#
# ghostty-web uses the size-optimized build that Ghostty publishes with each
# libghostty-vt release. The version and checksum are pinned here; bump both
# together. Checksums come from the release's SHA256SUMS file, which is signed
# with Ghostty's minisign key (see https://lib.ghostty.org/ "Release Files").

VERSION="1.0.0"
SHA256="dad8e14ce8da57db3864f66ae36caf66a17c4e2691ad0a0110e05c746de047a4"
FILE="ghostty-vt-${VERSION}-small.wasm"
URL="https://release.files.ghostty.org/libghostty-vt/${VERSION}/${FILE}"
OUT="ghostty-vt.wasm"

sha256() {
    if command -v sha256sum &> /dev/null; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

if [ -f "$OUT" ] && [ "$(sha256 "$OUT")" = "$SHA256" ]; then
    echo "✓ $OUT is already libghostty-vt $VERSION"
    exit 0
fi

echo "⬇️  Downloading libghostty-vt $VERSION ($FILE)..."
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl --fail --silent --show-error --location --output "$TMP" "$URL"

ACTUAL="$(sha256 "$TMP")"
if [ "$ACTUAL" != "$SHA256" ]; then
    echo "❌ Checksum mismatch for $FILE"
    echo "   expected $SHA256"
    echo "   got      $ACTUAL"
    exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT
SIZE=$(du -h "$OUT" | cut -f1)
echo "✅ $OUT is libghostty-vt $VERSION ($SIZE)"
