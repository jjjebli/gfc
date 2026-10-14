// GFC core — git-for-context shared logic. Registry v2.
//
// Single source of truth for the on-disk contract used by BOTH the OpenCode
// plugin (~/.config/opencode/plugins/gfc.ts) and the MCP server (~/.gfc/mcp.mjs):
//   Registry: $GFC_HOME/registry.json
//     { version: 2, entries: { [sessionID]: { [absPath]: {hash,lines,ts} } } }
// Entry existence ≡ "model saw this hash as a full read in that session".
//   Blobs:    $GFC_HOME/store/<hash>  (last-seen content ≤512KB, for diffing)
//
// "seen" is SESSION-SCOPED: models are stateless, so the first full read in
// any session always returns real content. Entries are nested per-session —
// parallel sessions on the same file no longer clobber each other (v1 bug,
// measured during the GFC-bench matrix).
//
// Write safety: atomic rename + cross-process lockfile around the
// read-modify-write. ponytail: on 3s lock timeout we proceed unlocked
// (last-write-wins = one missed stub, never corruption); stale locks break
// after 5s.
//
// GFC_HOME env var relocates state — used for test/bench isolation.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GFC_HOME = process.env.GFC_HOME || path.join(os.homedir(), ".gfc");
export const REGISTRY_PATH = path.join(GFC_HOME, "registry.json");
export const STORE_DIR = path.join(GFC_HOME, "store");
export const MAX_BLOB = 512 * 1024; // files larger than this are never diffed (full re-read on change)
export const MIN_STUB = 2000; // outputs smaller than this aren't worth stubbing
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

/**
 * Single-hunk unified diff via common prefix/suffix.
 * ponytail: single-hunk only — scattered edits become one big hunk (falls
 * back to full content upstream if bigger); upgrade to Myers only if that
 * measurably hurts.
 */
export function prefixSuffixDiff(oldText, newText) {
  const context = 3;
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  if (s === ea && s === eb) return ""; // identical
  const cs = Math.max(0, s - context);
  const ce = Math.min(a.length, ea + context);
  const head = `@@ -${cs + 1},${ea - cs} +${cs + 1},${eb - cs} @@`;
  return [
    head,
    ...a.slice(cs, s).map((l) => "  " + l),
    ...a.slice(s, ea).map((l) => "- " + l),
    ...b.slice(s, eb).map((l) => "+ " + l),
    ...a.slice(ea, ce).map((l) => "  " + l),
  ].join("\n");
}

export const fmtKB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

// ------------------------------------------------------------- storage

function withLock(fn) {
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
  fs.mkdirSync(GFC_HOME, { recursive: true });
  const tmp = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, entries: reg.entries }));
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

export function saveBlob(hash, content, size) {
  try {
    if (size > MAX_BLOB) return;
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const p = path.join(STORE_DIR, hash);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content);
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
    if (names.length <= GC_MAX_BLOBS) return;
    const st = names
      .map((f) => ({ f, m: fs.statSync(path.join(STORE_DIR, f)).mtimeMs }))
      .sort((x, y) => x.m - y.m);
    for (let i = 0; i < st.length - GC_MAX_BLOBS; i++) fs.unlinkSync(path.join(STORE_DIR, st[i].f));
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

if (import.meta.main) {
  const assert = (await import("node:assert")).strict;

  // diff: single-line change with context
  const d = prefixSuffixDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  assert(d.startsWith("@@ -1,3 +1,3 @@"));
  assert(d.includes("- c") && d.includes("+ X"));
  assert(!d.includes("- b") && !d.includes("+ b") && !d.includes("- d"));

  // diff: pure append
  const app = prefixSuffixDiff("a\nb", "a\nb\nc");
  assert(app.startsWith("@@ -1,2 +1,3 @@"));
  assert(app.includes("+ c") && !app.includes("- "));

  // diff: identical → ""
  assert(prefixSuffixDiff("x\ny", "x\ny") === "");

  // diff: middle-insert, no delete
  const mix = prefixSuffixDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n10", "1\n2\n3\n4\nNEW\n5\n6\n7\n8\n9\n10");
  assert(mix.includes("+ NEW") && !mix.includes("- "));

  // lineNoOf / visibleLines / hashOf
  assert(lineNoOf("1: foo") === 1);
  assert(lineNoOf("300: ") === 300);
  assert(lineNoOf("garbage") === null);
  assert(visibleLines("a\nb\n") === 2);
  assert(visibleLines("a\nb") === 2);
  assert(visibleLines("") === 0);
  assert(hashOf("abc") === hashOf("abc"));
  assert(hashOf("abc") !== hashOf("abd"));

  // registry round-trip + cross-process lock race
  // (only when GFC_HOME is set, so the production registry is never touched)
  if (process.env.GFC_HOME) {
    const { spawn } = await import("node:child_process");
    const now = () => Date.now();

    putEntry("t1", "/f/a", { hash: "h1", lines: 1, ts: now() });
    putEntry("t2", "/f/a", { hash: "h2", lines: 1, ts: now() });
    const reg = loadRegistry();
    assert(getEntry(reg, "t1", "/f/a").hash === "h1");
    assert(getEntry(reg, "t2", "/f/a").hash === "h2"); // no clobber: same file, two sessions

    // cross-process race: 2 children × 30 distinct paths + 20 writes to one shared path
    const self = process.argv[1];
    const kids = [0, 1].map((i) => {
      const k = spawn(process.execPath, [self], { env: { ...process.env, GFC_CHILD_RACE: String(i) } });
      k.stderr.on("data", (b) => process.stderr.write(b));
      return new Promise((res) => k.on("exit", res));
    });
    await Promise.all(kids);
    const after = loadRegistry();
    for (let n = 0; n < 30; n++) {
      assert(getEntry(after, "child0", `/race/0/${n}`), `child0 /race/0/${n} lost`);
      assert(getEntry(after, "child1", `/race/1/${n}`), `child1 /race/1/${n} lost`);
    }
    assert(getEntry(after, "child0", "/race/shared") || getEntry(after, "child1", "/race/shared"));
    console.log("GFC core self-test: all assertions passed (incl. registry v2 round-trip, cross-process lock race)");
  } else {
    console.log("GFC core self-test: pure assertions passed (set GFC_HOME to include registry tests)");
  }
}
