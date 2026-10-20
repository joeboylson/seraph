#!/bin/sh
# Installs or updates seraph in ~/.local/bin. Two ways to run it:
#
#   curl -fsSL https://raw.githubusercontent.com/joeboylson/seraph/main/install.sh | sh
#       downloads the latest release built for this computer
#   ./install.sh
#       in a copy of the repo: builds it from the code there
#
# Run it again to update; a running controller restarts onto the new copy.
# SERAPH_VERSION=v0.2.0 picks a release. The page is deployed separately
# (Vercel, from web/).
set -e

repo="joeboylson/seraph"
bin_dir="$HOME/.local/bin"
mkdir -p "$bin_dir"
new="$bin_dir/.seraph.new"

# Piped into sh, $0 is the shell, not this file: always download then.
here=""
case "$0" in
  *install.sh) here="$(cd "$(dirname "$0")" && pwd)" ;;
esac
if [ -n "$here" ] && [ -f "$here/Cargo.toml" ] && grep -q '^name = "seraph"' "$here/Cargo.toml"; then
  echo "Building seraph…"
  (cd "$here" && cargo build --release --quiet)
  # A copy, not a link, so the installed one keeps working while the repo changes.
  cp "$here/target/release/seraph" "$new"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=aarch64-apple-darwin ;;
    Darwin-x86_64) target=x86_64-apple-darwin ;;
    Linux-x86_64) target=x86_64-unknown-linux-musl ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl ;;
    *) echo "No seraph build for $(uname -s) $(uname -m). Build it from the repo: https://github.com/$repo" >&2; exit 1 ;;
  esac
  if [ -n "$SERAPH_VERSION" ]; then
    base="https://github.com/$repo/releases/download/$SERAPH_VERSION"
  else
    base="https://github.com/$repo/releases/latest/download"
  fi
  echo "Downloading seraph for $target…"
  curl -fsSL "$base/seraph-$target" -o "$new"
  want="$(curl -fsSL "$base/seraph-$target.sha256" | cut -d' ' -f1)"
  if command -v shasum >/dev/null; then got="$(shasum -a 256 "$new" | cut -d' ' -f1)"; else got="$(sha256sum "$new" | cut -d' ' -f1)"; fi
  if [ "$want" != "$got" ]; then
    rm -f "$new"
    echo "The download doesn't match its checksum, so it wasn't installed. Try again." >&2
    exit 1
  fi
  chmod +x "$new"
fi

mv "$new" "$bin_dir/seraph"
seraph="$bin_dir/seraph"
echo "Installed $("$seraph" --version) in $bin_dir"

# A running controller keeps the old copy until it restarts. Claude sessions
# keep running through it.
if "$seraph" status 2>/dev/null | grep -q "Controller: running"; then
  "$seraph" restart
fi

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add this to your shell profile: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
if [ ! -f "${SERAPH_HOME:-$HOME/.seraph}/config.json" ]; then
  echo "Next: seraph setup, then seraph start"
fi
