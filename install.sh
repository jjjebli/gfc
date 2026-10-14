#!/usr/bin/env bash
# gfc installer — clones to ~/.gfc and wires the OpenCode plugin.
# Safe to re-run: updates an existing clone instead of clobbering it.
set -euo pipefail

GFC_HOME="${GFC_HOME:-$HOME/.gfc}"
PLUGIN_DIR="$HOME/.config/opencode/plugins"
REPO="https://github.com/jjjebli/gfc"

if [ -d "$GFC_HOME/.git" ]; then
  echo "gfc: updating existing clone at $GFC_HOME"
  git -C "$GFC_HOME" pull --ff-only
else
  echo "gfc: cloning to $GFC_HOME"
  git clone --depth 1 "$REPO" "$GFC_HOME"
fi

mkdir -p "$PLUGIN_DIR"
# Symlink when possible (git pull then updates the plugin automatically),
# fall back to a copy if the filesystem or platform refuses.
if ln -sf "$GFC_HOME/gfc-plugin.ts" "$PLUGIN_DIR/gfc.ts" 2>/dev/null; then
  echo "gfc: plugin linked at $PLUGIN_DIR/gfc.ts (re-run this script to update)"
else
  cp "$GFC_HOME/gfc-plugin.ts" "$PLUGIN_DIR/gfc.ts"
  echo "gfc: plugin copied to $PLUGIN_DIR/gfc.ts (re-run this script to update)"
fi

echo
echo "gfc: installed. Restart opencode — there is nothing to configure."
echo
echo "Codex / any MCP client — add to ~/.codex/config.toml:"
echo '  [mcp_servers.gfc]'
echo '  command = "node"'
echo "  args = [\"$GFC_HOME/mcp.mjs\"]"
echo
echo "Verify (deterministic, no LLM, no network):"
echo "  GFC_HOME=\$(mktemp -d) node $GFC_HOME/core.mjs && node $GFC_HOME/test.mjs"
