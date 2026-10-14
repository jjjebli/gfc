# gfc — git-for-context

<p align="center"><img src="docs/banner.svg" alt="gfc — git-for-context" width="720"></p>

<p align="center">
  <a href="https://github.com/jjjebli/gfc/actions/workflows/ci.yml"><img src="https://github.com/jjjebli/gfc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#measured"><img src="https://img.shields.io/badge/measured-%E2%88%9234%25%20context%2Fturn-52C489?style=flat-square" alt="measured −34% context/turn"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/dependencies-0-111413?style=flat-square" alt="zero dependencies"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-111413?style=flat-square" alt="node ≥22">
  <img src="https://img.shields.io/badge/license-MIT-111413?style=flat-square" alt="MIT">
</p>

**Docs site: https://jjjebli.github.io/gfc/** — the interactive version, where the page itself is a numbered file being read, with a live demo of a stub replacing a full re-read.

LLM coding agents re-read the same files over and over. The transcript is a
linear replay: every turn re-pays for content the model has already seen.
**gfc treats the transcript like git treats a working tree — ship the model a
diff against what it already saw, never a full re-checkout.**

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

72-run A/B benchmark on opencode free-tier models (3 models × 4 scenarios × 3 reps,
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

The win scales with the size of your files and how often the agent re-reads
them. A 2000-line file re-read twice costs ~3× in tokens; with gfc it costs
~1.05×.

## Install

One command (OpenCode):

```sh
curl -fsSL https://raw.githubusercontent.com/jjjebli/gfc/master/install.sh | bash
```

That clones to `~/.gfc`, links the plugin, and prints the MCP config if you
want Codex too. Re-run it any time to update. Manual equivalent:

```sh
git clone https://github.com/jjjebli/gfc ~/.gfc
mkdir -p ~/.config/opencode/plugins
ln -s ~/.gfc/gfc-plugin.ts ~/.config/opencode/plugins/gfc.ts   # or cp
```

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

### Verify

Deterministic, no LLM, no network — CI runs both on every push:

```sh
GFC_HOME=$(mktemp -d) node ~/.gfc/core.mjs   # diff, registry v2, lock race
node ~/.gfc/test.mjs                         # full MCP battery
```

## How it works

1. **Content-addressed registry** (`~/.gfc/registry.json`): every full read is
   hashed (sha256) and recorded per session. If on-disk content still hashes
   to the registered value, it is byte-identical to what the model already saw.
2. **The filesystem is the store of truth** — only a small registry and
   last-seen content blobs (≤512KB each) are persisted, for diffing.
3. **Session-scoped**: models are stateless across sessions, so the first full
   read in any session always returns real content. A resumed session
   (same session id) keeps stubbing.
4. **Compaction-aware**: opencode's `/compact` receives the verified-file list so
   summaries don't paste file contents; post-compact re-reads still stub.

## Configuration

| Knob | Effect |
|---|---|
| `GFC_HOME=/dir` | Relocate all state (and, if the clone lives there, the code) |
| `GFC_DEBUG=1` | Trace hook decisions to `~/.gfc/debug.log` |
| `rm -rf ~/.gfc` | Full reset — rebuilds on next read; costs one full read per file |

Registry entries expire after 30 days. Blobs are capped at 1000 files.
Writes are atomic (temp file + rename) and cross-process locked.

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

---

If gfc cut your context bills, a ⭐ helps other agents' humans find it.
