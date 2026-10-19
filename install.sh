#!/bin/sh
# Builds seraph from this repo and installs it, or updates it (the page is
# deployed separately: `vercel deploy --prod` in web/). Run it again
# after any change here. Other computers then update with the install line
# from this one's page: curl -fsSL <page address>/install | sh
set -e
cd "$(dirname "$0")"

echo "Building seraph…"
cargo build --release --quiet

mkdir -p "$HOME/.local/bin"
# A copy, not a link, so the installed one keeps working while this repo changes.
cp target/release/seraph "$HOME/.local/bin/.seraph.new"
mv "$HOME/.local/bin/.seraph.new" "$HOME/.local/bin/seraph"
seraph="$HOME/.local/bin/seraph"
echo "Installed $("$seraph" --version) in $HOME/.local/bin"

if "$seraph" status 2>/dev/null | grep -q "Controller: running"; then
  "$seraph" restart
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo 'Add this to your shell profile: export PATH="$HOME/.local/bin:$PATH"' ;;
esac
if [ ! -f "${SERAPH_HOME:-$HOME/.seraph}/config.json" ]; then
  echo "Next: seraph setup, then seraph start"
fi
