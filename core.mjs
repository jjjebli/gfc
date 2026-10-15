// GFC core — git-for-context shared logic. Registry v2.
//
// Single source of truth for the on-disk contract used by BOTH the OpenCode
// plugin (~/.config/opencode/plugins/gfc.ts) and the MCP server (~/.gfc/mcp.mjs):
//   Registry: $GFC_HOME/registry.json
//     { version: 2, entries: { [sessionID]: { [absPath]: {hash,lines,ts} } } }
// Entry existence ≡ "the full content with this hash is in that session's
// live context". Anything that removes content from context (compaction)
// must clear the session's entries — see clearSession().
//   Blobs:    $GFC_HOME/store/<hash>  (last-seen content ≤512KB, for diffing)
//
// Privacy: blobs are file contents. They are written 0600 inside 0700 dirs,
// and files that look like secrets (.env, keys, credentials…) are NEVER
// stored — they still stub when unchanged, but a change returns full content.
//
// Write safety: atomic rename + cross-process lockfile around the
// read-modify-write. On 3s lock timeout we proceed unlocked (last-write-wins
// = one missed stub, never corruption); stale locks break after 5s.
//
// GFC_HOME env var relocates state — used for test/bench isolation.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GFC_HOME = process.env.GFC_HOME || path.join(os.homedir(), ".gfc");
export const REGISTRY_PATH = path.join(GFC_HOME, "registry.json");
export const STORE_DIR = path.join(GFC_HOME, "store");
export const MAX_BLOB = 512 * 1024; // files larger than this are never diffed (full re-read on change)
export const MIN_STUB = 2000; // outputs smaller than this aren't worth stubbing
export const MAX_DIFF_RATIO = 0.8; // a diff ≥80% of the full dump is worse than the dump itself
export const MAX_EDITS = 1000; // Myers edit-distance cap; beyond this the file was rewritten → full
export const GC_DAYS = 30;
export const GC_MAX_BLOBS = 1000;

// ---------------------------------------------------------------- pure

export function hashOf(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/** Number of lines a numbered dump of this content would show. */
export function visibleLines(content) {
  if (content === "") return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

/** "123: foo" → 123; anything else → null. */
export function lineNoOf(s) {
  const m = /^(\d+): /.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

const SENSITIVE = [
  /^\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|tfstate)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /secret/i,
  /credential/i,
];

/** Paths whose contents must never be persisted to the blob store. */
export function isSensitive(filePath) {
  const base = path.basename(filePath);
  return SENSITIVE.some((r) => r.test(base));
}

/** Split into lines; a trailing newline does not create a phantom empty line. */
function toLines(text) {
  if (text === "") return [];
  const l = text.split("\n");
  if (text.endsWith("\n")) l.pop();
  return l;
}

/**
 * Myers O(ND) shortest edit script between line arrays a and b.
 * Returns an array of '=', '-', '+' or null if the edit distance exceeds maxD.
 * Memory is O(D²) (one snapshot of the [-d,d] diagonal band per step).
 */
function myers(a, b, maxD) {
  const N = a.length;
  const M = b.length;
  const max = Math.min(N + M, maxD);
  const O = max + 1;
  const v = new Int32Array(2 * max + 3);
  v[O + 1] = 0;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(O - d - 1, O + d + 2)); // k = -d-1 … d+1  →  local k+d+1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[O + k - 1] < v[O + k + 1]) ? v[O + k + 1] : v[O + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[O + k] = x;
      if (x >= N && y >= M) return backtrack(trace, N, M);
    }
  }
  return null;
}

function backtrack(trace, N, M) {
  const ops = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const g = (k) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && g(k - 1) < g(k + 1)) ? k + 1 : k - 1;
    const prevX = g(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/**
 * Multi-hunk line diff, rendered for a model to read and act on:
 *   @@ -148,7 +148,8 @@
 *     148: unchanged       ← context and '+' lines carry CURRENT line numbers
 *   - 150: old line         ← '-' lines carry the line number they HAD
 *   + 150: new line
 * Hunk headers follow unified-diff counting (context included).
 * Returns "" when the line sequences are identical, null when the edit
 * distance exceeds maxEdits (caller should send full content).
 */
export function lineDiff(oldText, newText, { context = 3, maxEdits = MAX_EDITS } = {}) {
  const a = toLines(oldText);
  const b = toLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  if (pre === a.length && pre === b.length) return "";

  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), maxEdits);
  if (!mid) return null;

  // Full op list with absolute indices. For '+' ai = old insertion point;
  // for '-' bi = new position.
  const ops = [];
  let ai = 0;
  let bi = 0;
  const push = (t) => {
    ops.push({ t, ai, bi });
    if (t !== "+") ai++;
    if (t !== "-") bi++;
  };
  for (let i = 0; i < pre; i++) push("=");
  for (const t of mid) push(t);
  for (let i = 0; i < suf; i++) push("=");

  const changes = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].t !== "=") changes.push(i);

  const out = [];
  for (let i = 0; i < changes.length; i++) {
    const start = Math.max(0, changes[i] - context);
    let last = changes[i];
    while (i + 1 < changes.length && changes[i + 1] - last - 1 <= 2 * context) last = changes[++i];
    const end = Math.min(ops.length - 1, last + context);
    const h = ops.slice(start, end + 1);
    const oldCount = h.filter((o) => o.t !== "+").length;
    const newCount = h.filter((o) => o.t !== "-").length;
    const oldStart = oldCount ? h[0].ai + 1 : h[0].ai;
    const newStart = newCount ? h[0].bi + 1 : h[0].bi;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of h) {
      if (o.t === "=") out.push(`  ${o.bi + 1}: ${b[o.bi]}`);
      else if (o.t === "-") out.push(`- ${o.ai + 1}: ${a[o.ai]}`);
      else out.push(`+ ${o.bi + 1}: ${b[o.bi]}`);
    }
  }
  return out.join("\n");
}

/**
 * The single decision procedure shared by the OpenCode plugin and the MCP
 * server, so both front-ends have identical, tested semantics.
 *
 * Knowledge model: per session and file we record the content hash and
 * `upto` — the model has seen lines 1..upto of exactly that content.
 * Paging forward through a big file extends `upto`; anything else that
 * starts at line 1 resets it. Entries from before `upto` existed were
 * always full reads, so a missing `upto` means "whole file".
 *
 *   prev          registry entry or null
 *   hash, total   current file
 *   from, to      1-based line range this read actually shows (to ≥ from-1)
 *   explicit      the caller asked for a range (offset/limit). Explicit
 *                 reads ALWAYS return real lines — the escape hatch.
 *   outputLength  length of the normal tool output (tiny outputs never stub)
 *
 * Returns { action, upto }:
 *   action: "stub"  — replace output with an unchanged-stub
 *           "diff"  — try a diff vs the stored blob (caller falls back to "note")
 *           "note"  — real output, prefixed with a file-changed note
 *           "pass"  — real output, untouched
 *   upto:   new `upto` to register for the current hash, or null = leave as is
 */
export function decide({ prev, hash, total, from, to, explicit, outputLength }) {
  const same = !!prev && prev.hash === hash;
  const prevUpto = prev ? (prev.upto ?? prev.lines) : 0;
  const prevFull = !!prev && prevUpto >= prev.lines;

  let upto = null;
  if (same && from <= prevUpto + 1) upto = Math.max(prevUpto, to);
  else if (from === 1) upto = to;

  let action = "pass";
  if (!explicit && same && prevUpto >= to && to >= 1 && outputLength >= MIN_STUB) action = "stub";
  else if (prev && !same && !explicit && prevFull && from === 1 && to === total) action = "diff";
  else if (prev && !same) action = "note";
  return { action, upto };
}

/** Stub text. `to < total` means only the first page was (re-)requested. */
export function stubText(file, hash, total, to, size, rangeHint) {
  const what = to >= total ? `"${file}"` : `lines 1-${to} of "${file}" (${total} lines total)`;
  const more = to < total ? ` To continue past what you've seen, read with offset=${to + 1}.` : "";
  return (
    `[GFC] unchanged: ${what} is identical to what you read earlier in this conversation ` +
    `(sha256 ${hash.slice(0, 12)}, ${total} lines, ${fmtKB(size)}). ` +
    `If that earlier content is no longer in your context, ${rangeHint} to get the real lines again.${more}`
  );
}

export function changeNote(prevHash, hash) {
  return (
    `[GFC] note: file changed since you last read it in this conversation ` +
    `(${prevHash.slice(0, 12)} → ${hash.slice(0, 12)}). Lines below are the CURRENT content:\n`
  );
}

export function diffText(prevHash, hash, total, diff) {
  return (
    `[GFC] changed since the full version earlier in this conversation (${prevHash.slice(0, 12)} → ${hash.slice(0, 12)}). ` +
    `Diff of last-seen → current; file now has ${total} lines ${DIFF_LEGEND}\n${diff}`
  );
}

/** Use the diff only when it is clearly smaller than the full output. */
export const diffWorthIt = (diff, fullLength) => !!diff && diff.length < fullLength * MAX_DIFF_RATIO;

export const DIFF_LEGEND = "('-' lines show their old line number; context and '+' lines show current line numbers.)";

export const fmtKB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

// ------------------------------------------------------------- storage

function ensureHome() {
  fs.mkdirSync(GFC_HOME, { recursive: true, mode: 0o700 });
}

function withLock(fn) {
  ensureHome();
  const lock = REGISTRY_PATH + ".lock";
  const deadline = Date.now() + 3000;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx");
    } catch {
      try {
        const s = fs.statSync(lock);
        if (Date.now() - s.mtimeMs > 5000) fs.unlinkSync(lock);
      } catch {}
      if (Date.now() > deadline) return fn(); // give up → last-write-wins ceiling
      const w = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(w, 0, 0, 20 + Math.floor(Math.random() * 40));
      continue;
    }
    fs.closeSync(fd);
    try {
      return fn();
    } finally {
      try {
        fs.unlinkSync(lock);
      } catch {}
    }
  }
}

function gc(reg) {
  const cutoff = Date.now() - GC_DAYS * 86400000;
  const entries = {};
  for (const [sid, files] of Object.entries(reg.entries ?? {})) {
    if (!files || typeof files !== "object") continue;
    const kept = {};
    for (const [p, e] of Object.entries(files)) {
      if (p && e && typeof e.ts === "number" && e.ts >= cutoff) kept[p] = e;
    }
    if (Object.keys(kept).length) entries[sid] = kept;
  }
  return { version: 2, entries };
}

export function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    if (raw?.version !== 2) return { version: 2, entries: {} }; // stale format → fresh cache
    return gc(raw);
  } catch {
    return { version: 2, entries: {} };
  }
}

function saveRegistryUnlocked(reg) {
  ensureHome();
  const tmp = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, entries: reg.entries }), { mode: 0o600 });
  fs.renameSync(tmp, REGISTRY_PATH); // atomic on POSIX
}

export function getEntry(reg, sid, file) {
  return reg?.entries?.[sid]?.[file] ?? null;
}

/** Locked read-modify-write: parallel sessions can no longer erase each other. */
export function putEntry(sid, file, entry) {
  withLock(() => {
    const reg = loadRegistry();
    (reg.entries ||= {})[sid] ||= {};
    reg.entries[sid][file] = entry;
    saveRegistryUnlocked(reg);
  });
}

/**
 * Forget everything a session has "seen". Call whenever earlier tool output
 * may have left the model's context (compaction, summarisation): the next
 * full read then returns real content instead of a stub pointing at nothing.
 */
export function clearSession(sid) {
  withLock(() => {
    const reg = loadRegistry();
    if (reg.entries?.[sid]) {
      delete reg.entries[sid];
      saveRegistryUnlocked(reg);
    }
  });
}

export function saveBlob(hash, content, size, filePath = "") {
  try {
    if (size > MAX_BLOB) return;
    if (filePath && isSensitive(filePath)) return;
    ensureHome();
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    const p = path.join(STORE_DIR, hash);
    if (fs.existsSync(p)) {
      const t = new Date();
      fs.utimesSync(p, t, t); // keep recently-used blobs alive under LRU gc
    } else fs.writeFileSync(p, content, { mode: 0o600 });
  } catch {}
}

export function readBlob(hash) {
  try {
    return fs.readFileSync(path.join(STORE_DIR, hash), "utf8");
  } catch {
    return null;
  }
}

export function gcBlobs() {
  try {
    const names = fs.readdirSync(STORE_DIR);
    const cutoff = Date.now() - GC_DAYS * 86400000;
    const st = names.map((f) => ({ f, m: fs.statSync(path.join(STORE_DIR, f)).mtimeMs })).sort((x, y) => x.m - y.m);
    const excess = st.length - GC_MAX_BLOBS;
    st.forEach((e, i) => {
      if (i < excess || e.m < cutoff) fs.unlinkSync(path.join(STORE_DIR, e.f));
    });
  } catch {}
}

// ------------------------------------------------------------ self-test

// child helper for the cross-process lock race test (spawned with env flag)
if (process.env.GFC_CHILD_RACE) {
  const i = process.env.GFC_CHILD_RACE;
  for (let n = 0; n < 30; n++) putEntry("child" + i, "/race/" + i + "/" + n, { hash: "h" + n, lines: 1, ts: Date.now() });
  for (let n = 0; n < 20; n++) putEntry("child" + i, "/race/shared", { hash: "s" + i + "_" + n, lines: 1, ts: Date.now() });
  process.exit(0);
}

// Run the self-test when executed directly. Not import.meta.main: it is
// absent on older Node 22.x, where the test block would silently not run
// and CI would pass with zero assertions.
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain && !process.env.GFC_CHILD_RACE) {
  const assert = (await import("node:assert")).strict;
  let checks = 0;
  const ok = (cond, msg) => {
    assert(cond, msg);
    checks++;
  };

  /** Header counts must equal the lines actually present in each hunk. */
  const headersConsistent = (d) => {
    const hunks = d.split(/\n(?=@@ )/);
    return hunks.every((h) => {
      const [head, ...body] = h.split("\n");
      const m = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(head);
      if (!m) return false;
      const o = body.filter((l) => !l.startsWith("+ ")).length;
      const n = body.filter((l) => !l.startsWith("- ")).length;
      return o === +m[1] && n === +m[2];
    });
  };

  // single change with context on both sides — header counts include context
  const d = lineDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  ok(d.startsWith("@@ -1,5 +1,5 @@"), "header counts context: " + d.split("\n")[0]);
  ok(d.includes("- 3: c") && d.includes("+ 3: X") && d.includes("  2: b") && d.includes("  4: d"), "numbered lines");
  ok(headersConsistent(d), "consistent headers");

  // pure append
  const app = lineDiff("a\nb\n", "a\nb\nc\n");
  ok(app.startsWith("@@ -1,2 +1,3 @@") && app.includes("+ 3: c") && !app.includes("- "), "append: " + app);
  ok(!/\d+: $/m.test(app), "no phantom empty line from trailing newline");

  // identical → ""
  ok(lineDiff("x\ny", "x\ny") === "", "identical");

  // middle insert, no delete; numbering after the insert is current
  const mix = lineDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n10", "1\n2\n3\n4\nNEW\n5\n6\n7\n8\n9\n10");
  ok(mix.includes("+ 5: NEW") && !mix.includes("- ") && mix.includes("  6: 5"), "insert: " + mix);
  ok(headersConsistent(mix), "insert headers");

  // two scattered edits → two hunks, not one giant one
  const base = Array.from({ length: 200 }, (_, i) => `L${i + 1}`);
  const edited = base.slice();
  edited[9] = "EDIT-A";
  edited[189] = "EDIT-B";
  const two = lineDiff(base.join("\n") + "\n", edited.join("\n") + "\n");
  ok((two.match(/^@@ /gm) || []).length === 2, "two hunks");
  ok(two.length < 400, "scattered diff stays small: " + two.length);
  ok(headersConsistent(two), "two-hunk headers");

  // nearby edits merge into one hunk
  const near = base.slice();
  near[50] = "X";
  near[55] = "Y";
  const merged = lineDiff(base.join("\n"), near.join("\n"));
  ok((merged.match(/^@@ /gm) || []).length === 1 && headersConsistent(merged), "merged hunk");

  // delete-only hunk at file start, with lines shifting
  const del = lineDiff("a\nb\nc\nd\n", "c\nd\n");
  ok(del.includes("- 1: a") && del.includes("- 2: b") && del.includes("  1: c") && headersConsistent(del), "delete: " + del);

  // edit distance cap → null (caller sends full)
  const rewrite = lineDiff(base.join("\n"), base.map((l) => l + "!").join("\n"), { maxEdits: 50 });
  ok(rewrite === null, "rewrite beyond cap → null");

  // randomized round-trip: applying the diff to old must yield new
  const apply = (oldT, diff) => {
    const a = toLines(oldT);
    const out = [];
    let ai = 0;
    for (const line of diff.split("\n")) {
      const h = /^@@ -(\d+),(\d+)/.exec(line);
      if (h) {
        const s = +h[2] === 0 ? +h[1] : +h[1] - 1;
        while (ai < s) out.push(a[ai++]);
        continue;
      }
      const body = line.slice(2).replace(/^\d+: /, "");
      if (line.startsWith("  ")) {
        out.push(body);
        ai++;
      } else if (line.startsWith("- ")) ai++;
      else if (line.startsWith("+ ")) out.push(body);
    }
    while (ai < a.length) out.push(a[ai++]);
    return out;
  };
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let t = 0; t < 300; t++) {
    const len = rnd(40);
    const A = Array.from({ length: len }, () => "w" + rnd(6));
    const B = A.slice();
    for (let e = rnd(6); e > 0; e--) {
      const op = rnd(3);
      if (op === 0 && B.length) B.splice(rnd(B.length), 1);
      else if (op === 1) B.splice(rnd(B.length + 1), 0, "n" + rnd(6));
      else if (B.length) B[rnd(B.length)] = "m" + rnd(6);
    }
    const oldT = A.join("\n") + "\n";
    const newT = B.join("\n") + "\n";
    const df = lineDiff(oldT, newT, { context: rnd(4) });
    if (df === "") ok(A.join("\n") === B.join("\n"), "empty diff only when identical");
    else {
      ok(headersConsistent(df), `random headers #${t}`);
      ok(JSON.stringify(apply(oldT, df)) === JSON.stringify(B), `random round-trip #${t}`);
    }
  }


  // decide(): the shared semantics
  const P = (o) => decide({ prev: null, hash: "H", total: 100, from: 1, to: 100, explicit: false, outputLength: 5000, ...o });
  const full = { hash: "H", lines: 100, upto: 100 };
  ok(P({}).action === "pass" && P({}).upto === 100, "first read: pass + register");
  ok(P({ prev: full }).action === "stub", "unchanged re-read: stub");
  ok(P({ prev: full, outputLength: 100 }).action === "pass", "tiny output never stubs");
  ok(P({ prev: full, explicit: true }).action === "pass", "explicit range never stubs (escape hatch)");
  ok(P({ prev: { hash: "H", lines: 100 } }).action === "stub", "legacy entry without upto = full");
  ok(P({ prev: { ...full, hash: "OLD" } }).action === "diff", "changed full re-read: diff");
  ok(P({ prev: { ...full, hash: "OLD" }, explicit: true, from: 10, to: 20 }).action === "note", "changed slice: note");
  ok(P({ prev: { ...full, hash: "OLD" }, explicit: true, from: 10, to: 20 }).upto === null, "changed partial slice: no register");
  // paging a large file
  const page1 = P({ total: 5000, to: 1800 });
  ok(page1.action === "pass" && page1.upto === 1800, "first page registers upto");
  const pg = { hash: "H", lines: 5000, upto: 1800 };
  ok(P({ prev: pg, total: 5000, to: 1800 }).action === "stub", "re-reading unchanged first page: stub");
  const page2 = P({ prev: pg, total: 5000, from: 1801, to: 3600, explicit: true });
  ok(page2.action === "pass" && page2.upto === 3600, "paging forward extends upto");
  ok(P({ prev: pg, total: 5000, from: 3000, to: 3100, explicit: true }).upto === null, "non-contiguous slice: no extend");
  ok(P({ prev: { ...pg, hash: "OLD" }, total: 5000, to: 1800 }).action === "note", "changed partial-seen file: note, no diff");
  ok(P({ prev: { hash: "OLD", lines: 100, upto: 50 } }).action === "note", "prev only partially seen: never diff");
  ok(P({ prev: { ...full, hash: "OLD" }, from: 5 }).action === "note", "changed read not starting at line 1: note, never diff");

  // lineNoOf / visibleLines / hashOf / isSensitive
  ok(lineNoOf("1: foo") === 1 && lineNoOf("300: ") === 300 && lineNoOf("garbage") === null, "lineNoOf");
  ok(visibleLines("a\nb\n") === 2 && visibleLines("a\nb") === 2 && visibleLines("") === 0, "visibleLines");
  ok(hashOf("abc") === hashOf("abc") && hashOf("abc") !== hashOf("abd"), "hashOf");
  ok(isSensitive("/x/.env") && isSensitive("/x/.env.local") && isSensitive("/k/id_ed25519") && isSensitive("/c/server.pem"), "sensitive");
  ok(!isSensitive("/x/src/env.ts") && !isSensitive("/x/README.md"), "not sensitive");

  // registry round-trip + clearSession + cross-process lock race
  // (only when GFC_HOME is set, so the production registry is never touched)
  if (process.env.GFC_HOME) {
    const { spawn } = await import("node:child_process");
    const now = () => Date.now();

    putEntry("t1", "/f/a", { hash: "h1", lines: 1, ts: now() });
    putEntry("t2", "/f/a", { hash: "h2", lines: 1, ts: now() });
    let reg = loadRegistry();
    ok(getEntry(reg, "t1", "/f/a").hash === "h1", "t1 entry");
    ok(getEntry(reg, "t2", "/f/a").hash === "h2", "no clobber: same file, two sessions");
    clearSession("t1");
    reg = loadRegistry();
    ok(getEntry(reg, "t1", "/f/a") === null && getEntry(reg, "t2", "/f/a") !== null, "clearSession is scoped");
    ok((fs.statSync(REGISTRY_PATH).mode & 0o077) === 0, "registry is private (0600)");

    saveBlob("secretblob", "TOKEN=1", 7, "/p/.env");
    ok(readBlob("secretblob") === null, "sensitive file never stored");
    saveBlob("plainblob", "hello", 5, "/p/a.txt");
    ok(readBlob("plainblob") === "hello" && (fs.statSync(path.join(STORE_DIR, "plainblob")).mode & 0o077) === 0, "blob private");

    const self = process.argv[1];
    const kids = [0, 1].map((i) => {
      const k = spawn(process.execPath, [self], { env: { ...process.env, GFC_CHILD_RACE: String(i) } });
      k.stderr.on("data", (b) => process.stderr.write(b));
      return new Promise((res) => k.on("exit", res));
    });
    await Promise.all(kids);
    const after = loadRegistry();
    for (let n = 0; n < 30; n++) {
      ok(getEntry(after, "child0", `/race/0/${n}`), `child0 /race/0/${n} lost`);
      ok(getEntry(after, "child1", `/race/1/${n}`), `child1 /race/1/${n} lost`);
    }
    ok(getEntry(after, "child0", "/race/shared") || getEntry(after, "child1", "/race/shared"), "shared");
    console.log(`GFC core self-test: ${checks} assertions passed (incl. registry, privacy, cross-process lock race)`);
  } else {
    console.log(`GFC core self-test: ${checks} pure assertions passed (set GFC_HOME to include registry tests)`);
  }
}
