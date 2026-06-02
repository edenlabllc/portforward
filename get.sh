#!/usr/bin/env sh
# Remote installer: curl -fsSL https://raw.githubusercontent.com/edenlabllc/portforward/main/get.sh | sh
# Downloads the prebuilt standalone binary from GitHub Releases. No bun required.
set -eu

REPO="${PORTFORWARD_REPO:-edenlabllc/portforward}"
VERSION="${PORTFORWARD_VERSION:-latest}"
BIN_DIR="${PORTFORWARD_BIN_DIR:-$HOME/.local/bin}"
NAME="portforward"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)

case "$os" in
  darwin|linux) ;;
  *) echo "portforward: unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "portforward: unsupported arch: $arch" >&2; exit 1 ;;
esac

asset="portforward-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

echo "portforward: downloading $asset ($VERSION)..."
mkdir -p "$BIN_DIR"
tmp=$(mktemp)
if ! curl -fsSL "$url" -o "$tmp"; then
  echo "portforward: download failed: $url" >&2
  rm -f "$tmp"
  exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/$NAME"

echo "portforward: installed to $BIN_DIR/$NAME"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "portforward: add $BIN_DIR to your PATH" ;;
esac
