# gfc — git-for-context

<p align="center"><img src="docs/banner.svg" alt="gfc — git-for-context" width="720"></p>

**Docs site: https://jjjebli.github.io/gfc/** — the interactive version, with a live demo of a stub replacing a full re-read.

LLM coding agents re-read the same files over and over. The transcript is a
linear replay: every turn re-pays for content the model has already seen.
gfc (git-for-context) treats the transcript like git treats a working tree —
ship the model a **diff against what it already saw**, never a full re-checkout.

| What the model does | What it gets |
|---|---|
| First full read of a file | Full numbered content (always) |
| Re-reads an **unchanged** file | A tiny `[gfc] unchanged` stub (~45 tokens, hash-verifiable) |
| Re-reads a **changed** file | A unified diff of last-seen → current |
| Reads a slice (offset/limit) | The real lines — plus a change-note if the file drifted |

Zero per-turn overhead: no tools registered in OpenCode, no prompt additions.
Nothing happens unless a duplicate read was about to happen — which is exactly
where it pays.

## Measured

72-run A/B benchmark on opencode free-tier models (3 models x 4 scenarios x 3 reps,
fresh sessions, all attempts counted, no outlier removal). Full protocol in `bench/`.

| Scenario | Per-turn context (arm A → arm B) | Delta |
|---|---|---|
| Re-read 2000-line file (nemotron-3-ultra) | 66,230 → 43,410 | **−34%** |
| Edit + re-read (nemotron-3-ultra) | 66,392 → 43,597 | **−34%** |
| Re-read (step-5-preview) | 44,839 → 34,908 | **−22%** |
| Re-read (ling-3.1-flash) | 58,702 → 43,521 | **−26%** |
| Small files / first reads | unchanged | 0% (by design) |

Mechanism fired 9/9 in every valid run. Comprehension after a stub: 100%
(models answer content questions from their first read; benchmark found zero
re-fetch side-effects). Registry writes are cross-process safe (lockfile +
atomic rename; verified by a 2-process race test — 60/60 entries survive).

## How it works

1. **Content-addressed registry** (`~/.gfc/registry.json`): every full read is
   hashed (sha256) and recorded per session. If on-disk content still hashes
   to the registered value, it is byte-identical to what the model already saw.
2. **The filesystem is the store of truth** — only a small registry and
   last-seen content blobs (≤512KB each) are persisted, for diffing.
3. **Session-scoped**: models are stateless across sessions, so the first full
   read in any session always returns real content. A resumed session
   (same session id) keeps stubbing.
4. Compaction-aware: opencode's `/compact` receives the verified-file list so
   summaries don't paste file contents; post-compact re-reads still stub.

## Install

Requirements: Node ≥22 (or Bun). No npm dependencies.

### OpenCode (hard interception — plugin replaces nothing, hooks the read tool)

```sh
git clone https://github.com/jjjebli/gfc ~/.gfc
mkdir -p ~/.config/opencode/plugins
cp ~/.gfc/gfc-plugin.ts ~/.config/opencode/plugins/gfc.ts
```

(On the author's machine the plugin is a symlink into `~/.gfc` so `git pull`
updates it; a copy works identically.)

Restart opencode. Done — there is nothing to configure.

### Codex / any MCP client (advisory — the model is given a `gfc_read` tool)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.gfc]
command = "node"
args = ["/Users/you/.gfc/mcp.mjs"]
```

Recommended rule for `~/.codex/AGENTS.md`:

```md
When reading files, prefer the `gfc_read` MCP tool over cat/head/sed/tail.
A `[gfc]` stub means "unchanged since your last full read" — trust it.
```

Interactive Codex will ask to approve the tool once — choose *always allow*.
`codex exec` needs `--approve-for-me` (headless mode auto-rejects MCP calls).

## Configuration

| Knob | Effect |
|---|---|
| `GFC_HOME=/dir` | Relocate all state (and, if the clone lives there, the code) |
| `GFC_DEBUG=1` | Trace hook decisions to `~/.gfc/debug.log` |
| `rm -rf ~/.gfc` | Full reset — rebuilds on next read; costs one full read per file |

Registry entries expire after 30 days. Blobs are capped at 1000 files.
Writes are atomic (temp file + rename) and cross-process locked.

## Test

```sh
GFC_HOME=$(mktemp -d) node ~/.gfc/core.mjs   # self-test: diff, registry, lock race
node ~/.gfc/test.mjs                         # full MCP battery (stub/diff/slices/edges)
```

Both are deterministic — no LLM, no network.

## Limitations (honest)

- Diffs are single-hunk (common prefix/suffix). Scattered edits fall back to
  full content when the diff would be larger.
- Files >512KB are never diffed (full re-read on change) and binary files are
  rejected by the MCP tool.
- The OpenCode hook relies on `tool.execute.after` output mutation, verified
  on opencode 1.18.29; if a future version stops persisting mutations, the
  fallback is `experimental.chat.messages.transform` as a send-time rewriter.
- Free-tier prompt caching is nondeterministic; use per-turn context totals,
  not raw input sums, when benchmarking (see `bench/analyze.mjs`).

## License

MIT
