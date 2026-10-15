#!/usr/bin/env bash
# GFC installer — clones to ~/.gfc, then wires every harness it finds
# (OpenCode plugin, Claude Code hooks, Codex hooks). Safe to re-run.
#   install.sh                     auto-detect
#   install.sh --claude --codex    only these
#   install.sh --uninstall         remove GFC from all harnesses
set -euo pipefail

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "GFC needs Node.js 22 or newer (found: $(node --version 2>/dev/null || echo none))." >&2
  exit 1
fi

GFC_HOME="${GFC_HOME:-$HOME/.gfc}"
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

echo
node "$GFC_HOME/setup.mjs" "$@"
echo
echo "Restart your agent so it picks GFC up. Verify any time: cd $GFC_HOME && npm test"
