# GFC — git-for-context

<p align="center"><img src="docs/banner.svg" alt="GFC — git-for-context" width="720"></p>

<p align="center">
  <a href="https://github.com/jjjebli/gfc/actions/workflows/ci.yml"><img src="https://github.com/jjjebli/gfc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#measured"><img src="https://img.shields.io/badge/measured-%E2%88%9234%25%20context%2Fturn-52C489?style=flat-square" alt="measured −34% context/turn"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/dependencies-0-111413?style=flat-square" alt="zero dependencies"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-111413?style=flat-square" alt="node ≥22">
  <img src="https://img.shields.io/badge/license-MIT-111413?style=flat-square" alt="MIT">
</p>

**Docs site: https://jjjebli.github.io/gfc/** — the interactive version: scrolly chapters that walk the mechanism, an A/B read simulator (with vs without GFC), and animated benchmark bars.

LLM coding agents re-read the same files over and over. The transcript is a
linear replay: every turn re-pays for content the model has already seen.
**GFC treats the transcript like git treats a working tree — ship the model a
diff against what it already saw, never a full re-checkout.**

| What the model does | What it gets |
|---|---|
| First read of a file | Full numbered content (always) |
| Re-reads an **unchanged** file — or an unchanged *page* of a large one | A tiny `[GFC] unchanged` stub (~70 tokens, hash-verifiable) |
| Re-reads a **changed** file | A numbered multi-hunk diff of last-seen → current |
| Reads with offset/limit | **Always** the real lines — plus a change-note if the file drifted |
| Reads anything after **compaction** | Real content again (GFC forgets what was compacted away) |

The guarantee GFC is built around: **a stub never points at content the
model doesn't have.** If the model is ever unsure, `offset=1` is an escape
hatch that always returns the real lines — and every stub says so.

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
them. A 2000-line file re-read twice costs ~3× in tokens; with GFC it costs
~1.05×.

*The A/B numbers above were measured on v0.1.* v0.2 extends the mechanism to
cases v0.1 passed through untouched — re-reads of files over 50 KB (which
OpenCode pages) and multi-site edits (which v0.1 re-sent in full). On a
deterministic replay of OpenCode 1.19's read output (a 40 KB file re-read and
edited in two places, plus a 95 KB file re-read twice), context drops 33% with
v0.1 and 62% with v0.2. Re-run `bench/` for model-level numbers.

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
[mcp_servers.GFC]
command = "node"
args = ["/Users/you/.GFC/mcp.mjs"]
```

Recommended rule for `~/.codex/AGENTS.md`:

```md
When reading files, prefer the `gfc_read` MCP tool over cat/head/sed/tail.
A `[GFC]` stub means "unchanged since your last full read" — trust it.
```

Interactive Codex will ask to approve the tool once — choose *always allow*.
`codex exec` needs `--approve-for-me` (headless mode auto-rejects MCP calls).

Pin a release instead of tracking `master`:

```sh
curl -fsSL https://raw.githubusercontent.com/jjjebli/gfc/master/install.sh | GFC_REF=v0.2.0 bash
```

### Verify

Deterministic, no LLM, no network — CI runs both on every push:

```sh
cd ~/.gfc && npm test
# core.mjs: diff (incl. 300 randomized apply-round-trips), decide(), registry, privacy, lock race
# test.mjs: MCP server over stdio + OpenCode plugin against 1.x read-tool output (Node ≥22.18)
```

## How it works

1. **Content-addressed registry** (`~/.gfc/registry.json`): per session and
   file, GFC records the sha256 of the content and how far (`upto`) the model
   has read it. If on-disk content still hashes to the registered value, the
   lines the model saw are byte-identical to what's on disk now. Paging forward
   through a large file extends `upto`.
2. **Verified before trusted**: the OpenCode plugin only registers a read after
   checking that the rows the model was shown match the file on disk, so an
   edit landing between the read and the hook can't produce a false stub.
3. **One decision procedure**: the plugin and the MCP server share
   `core.decide()`, so both front-ends have identical, unit-tested semantics.
4. **Session-scoped**: models are stateless across sessions, so the first read
   in any session always returns real content. A resumed session (same
   session id) keeps stubbing.
5. **Compaction-aware**: on OpenCode's `/compact`, the summary is told not to
   paste file contents, and the session's registry is cleared — the next read
   of any file returns its real content.
6. **Diffs built for the reader**: Myers line diff, multiple hunks, every line
   numbered (old numbers on `-` lines, current numbers on context and `+`
   lines) so the model can edit straight from the diff. Used only when it's
   under 80% of the full output; otherwise the full content is sent.

## Configuration

| Knob | Effect |
|---|---|
| `GFC_HOME=/dir` | Relocate all state (and, if the clone lives there, the code) |
| `GFC_REF=<tag>` | (install.sh) pin the install to a tag or commit |
| `GFC_DEBUG=1` | Trace hook decisions to `~/.gfc/debug.log` |
| `rm -rf ~/.gfc` | Full reset — rebuilds on next read; costs one full read per file |

Registry entries and blobs expire after 30 days; blobs are also capped at 1000
files (least-recently-used first). Writes are atomic (temp file + rename) and
cross-process locked.

### Privacy

To diff a changed file, GFC must remember the last version the model saw, so
**it stores copies of file contents** (≤512 KB each) in `~/.gfc/store`. These
are written owner-only (`0600` in a `0700` directory). Files that look like
secrets — `.env*`, `*.pem`/`*.key`/keystores, `id_rsa`-style keys, `.npmrc`,
`.netrc`, anything named `*secret*` or `*credential*` — are **never stored**:
they still stub when unchanged, but a change returns full content instead of
a diff. `rm -rf ~/.gfc` erases everything.

## Limitations (honest)

- Edits beyond ~1000 changed lines are treated as a rewrite (full content).
- Files >512KB are never diffed (full re-read on change) and binary files are
  rejected by the MCP tool.
- Diffs apply only when the model had seen the whole previous file; a changed
  file that was only partly read returns real lines with a change-note.
- The MCP server can't observe client-side compaction. Its stubs tell the
  model to use `offset=1` if the content is gone; the OpenCode plugin handles
  compaction automatically.
- The OpenCode hook relies on `tool.execute.after` output mutation and the 1.x
  read-tool format, checked against the opencode 1.19.0 source (end-to-end on
  1.18.29). If the format changes, verification fails closed: output passes
  through untouched and nothing is stubbed. OpenCode's unreleased 2.x rewrite
  has a new plugin API; when it ships, GFC will need a port (or
  `experimental.chat.messages.transform` as a send-time rewriter).
- Free-tier prompt caching is nondeterministic; use per-turn context totals,
  not raw input sums, when benchmarking (see `bench/analyze.mjs`).

## License

MIT

---

If GFC cut your context bills, a ⭐ helps other agents' humans find it.
