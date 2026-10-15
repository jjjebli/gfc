#!/usr/bin/env bash
# GFC installer — clones to ~/.gfc and wires the OpenCode plugin.
# Safe to re-run: updates an existing clone instead of clobbering it.
set -euo pipefail

GFC_HOME="${GFC_HOME:-$HOME/.gfc}"
PLUGIN_DIR="$HOME/.config/opencode/plugins"
REPO="https://github.com/jjjebli/gfc"
# Pin to a release tag or commit for reproducible installs: GFC_REF=v0.2.0
GFC_REF="${GFC_REF:-}"

if [ -n "$GFC_REF" ]; then
  [ -d "$GFC_HOME/.git" ] || git clone --quiet --depth 1 "$REPO" "$GFC_HOME"
  echo "GFC: checking out pinned ref $GFC_REF"
  git -C "$GFC_HOME" fetch --quiet --depth 1 origin "$GFC_REF"
  git -C "$GFC_HOME" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
elif [ -d "$GFC_HOME/.git" ]; then
  echo "GFC: updating existing clone at $GFC_HOME"
  git -C "$GFC_HOME" pull --ff-only
else
  echo "GFC: cloning to $GFC_HOME"
  git clone --depth 1 "$REPO" "$GFC_HOME"
fi
chmod 700 "$GFC_HOME" 2>/dev/null || true

mkdir -p "$PLUGIN_DIR"
# Symlink when possible (git pull then updates the plugin automatically),
# fall back to a copy if the filesystem or platform refuses.
if ln -sf "$GFC_HOME/gfc-plugin.ts" "$PLUGIN_DIR/gfc.ts" 2>/dev/null; then
  echo "GFC: plugin linked at $PLUGIN_DIR/gfc.ts (re-run this script to update)"
else
  cp "$GFC_HOME/gfc-plugin.ts" "$PLUGIN_DIR/gfc.ts"
  echo "GFC: plugin copied to $PLUGIN_DIR/gfc.ts (re-run this script to update)"
fi

echo
echo "GFC: installed. Restart opencode — there is nothing to configure."
echo
echo "Codex / any MCP client — add to ~/.codex/config.toml:"
echo '  [mcp_servers.GFC]'
echo '  command = "node"'
echo "  args = [\"$GFC_HOME/mcp.mjs\"]"
echo
echo "Verify (deterministic, no LLM, no network):"
echo "  cd $GFC_HOME && npm test"
