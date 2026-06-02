#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${PORTFORWARD_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/portforward"
BUILT="$ROOT/dist/portforward"

if command -v bun >/dev/null 2>&1; then
  echo "Building standalone binary with bun..."
  bun build --compile "$ROOT/src/cli.ts" --outfile "$BUILT"
elif [ ! -f "$BUILT" ]; then
  echo "bun is not installed and no prebuilt binary found at $BUILT."
  echo "Install bun once (https://bun.sh) to build, or ship a prebuilt dist/portforward."
  exit 1
else
  echo "bun not found, installing prebuilt binary from $BUILT"
fi

mkdir -p "$BIN_DIR"
install -m 0755 "$BUILT" "$TARGET"

echo "Installed portforward to $TARGET"
echo "Make sure $BIN_DIR is in your PATH."
echo "The installed binary is standalone — bun is not needed to run it."
