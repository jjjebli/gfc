#!/usr/bin/env node
// GFC hook — git-for-context for Claude Code and Codex.
//
// Both harnesses speak the same hook protocol (JSON on stdin, JSON on
// stdout) and both call their shell tool "Bash" with { command }. Models
// constantly re-read files through the shell — Codex almost exclusively
// (`sed -n '1,200p' f`, `nl -ba f | sed -n …`, `cat f`) — and those reads
// get no dedup from the harness. This hook gives them the same treatment
// the OpenCode plugin gives the read tool. Semantics live in core.decide.
//
//   PreToolUse  Bash  recognised read-only command of one text file:
//                     unchanged lines already seen → command is rewritten to
//                     print a short stub; changed file fully seen before →
//                     rewritten to print a numbered diff; otherwise untouched.
//   PostToolUse Bash  registers what the model was actually shown (only if
//                     the file did not change while the command ran); adds a
//                     change-note when a changed file passed through.
//   PostToolUse Read  (Claude Code) registers verified Read results, so a
//                     later `cat` of an unchanged file stubs too. Read output
//                     itself is never touched — Claude Code dedups it natively.
//   PreCompact /
//   SessionStart      compaction or /clear forgets the session, so the next
//   (compact|clear)   read is real content.
//
// Escape hatch: running the exact same command again right after a stub (or
// diff) always prints the real output. Every stub says so.
//
// Fail-open everywhere: any doubt, error or unsupported shape → no output,
// and the harness runs the original command unchanged.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.mjs";

const MAX_FILE = 4 * 1024 * 1024; // larger files pass through (hashing cost, never useful to stub huge dumps anyway)
const PENDING_DIR = path.join(core.GFC_HOME, "pending");
const OUT_DIR = path.join(core.GFC_HOME, "out");

// ------------------------------------------------------- command parsing

/** Strict shell tokenizer: plain words, '…', "…" (no expansions), and a single '|'. */
export function tokenize(cmd) {
  if (typeof cmd !== "string" || cmd.length > 4096) return null;
  const out = [];
  let cur = null;
  let i = 0;
  const push = () => {
    if (cur !== null) out.push(cur);
    cur = null;
  };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === " " || c === "\t") {
      push();
      i++;
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return null;
      cur = (cur ?? "") + cmd.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const j = cmd.indexOf('"', i + 1);
      if (j < 0) return null;
      const body = cmd.slice(i + 1, j);
      if (/[$`\\!]/.test(body)) return null; // would expand — not a plain read
      cur = (cur ?? "") + body;
      i = j + 1;
    } else if (c === "|") {
      if (cmd[i + 1] === "|") return null;
      push();
      out.push({ pipe: true });
      i++;
    } else if (/[;&<>$`(){}*?[\]~!#\\\n\r]/.test(c)) {
      return null; // anything that could make this more than a plain read
    } else {
      cur = (cur ?? "") + c;
      i++;
    }
  }
  push();
  return out;
}

const RANGE = /^(\d+)(?:,(\d+|\$))?p$/;

function sedRange(script) {
  const m = RANGE.exec(script);
  if (!m) return null;
  const from = +m[1];
  const to = m[2] === undefined ? from : m[2] === "$" ? Infinity : +m[2];
  return from >= 1 && to >= from ? { from, to } : null;
}

/**
 * Recognise a read-only command of exactly one file. Returns
 * { file, from, to, numbered } (to may be Infinity) or null.
 *   cat F | cat -n F | nl -ba F | head [-n N | -N | -nN] F |
 *   sed -n 'A[,B|$]p' F | nl -ba F | sed -n 'A,Bp' | cat -n F | sed -n 'A,Bp'
 */
export function parseRead(cmd) {
  const toks = tokenize(cmd);
  if (!toks || toks.length === 0) return null;
  const pipes = toks.filter((t) => typeof t === "object").length;
  if (pipes > 1) return null;
  const [left, right] = pipes ? splitPipe(toks) : [toks, null];
  if (left.some((t) => t === "" || t.startsWith("--"))) return null;

  const single = (args) => {
    if (args.length !== 1 || args[0].startsWith("-")) return null;
    return args[0];
  };

  let base = null;
  const [cmd0, ...args] = left;
  if (cmd0 === "cat") {
    const numbered = args[0] === "-n";
    const file = single(numbered ? args.slice(1) : args);
    if (file) base = { file, from: 1, to: Infinity, numbered };
  } else if (cmd0 === "nl") {
    if (args[0] === "-ba") {
      const file = single(args.slice(1));
      if (file) base = { file, from: 1, to: Infinity, numbered: true };
    }
  } else if (cmd0 === "head") {
    let n = 10;
    let rest = args;
    if (rest[0] === "-n" && /^\d+$/.test(rest[1] ?? "")) {
      n = +rest[1];
      rest = rest.slice(2);
    } else if (/^-n\d+$/.test(rest[0] ?? "")) {
      n = +rest[0].slice(2);
      rest = rest.slice(1);
    } else if (/^-\d+$/.test(rest[0] ?? "")) {
      n = +rest[0].slice(1);
      rest = rest.slice(1);
    }
    const file = single(rest);
    if (file && n >= 1) base = { file, from: 1, to: n, numbered: false };
  } else if (cmd0 === "sed" && !right) {
    if (args.length === 3 && args[0] === "-n") {
      const r = sedRange(args[1]);
      const file = single(args.slice(2));
      if (r && file) base = { file, ...r, numbered: false };
    }
  }
  if (!base) return null;
  if (!right) return base;

  // `nl -ba F | sed -n 'A,Bp'` / `cat -n F | sed -n 'A,Bp'`
  if (!base.numbered || base.to !== Infinity) return null;
  if (right.length !== 3 || right[0] !== "sed" || right[1] !== "-n") return null;
  const r = sedRange(right[2]);
  return r ? { ...base, ...r } : null;
}

function splitPipe(toks) {
  const i = toks.findIndex((t) => typeof t === "object");
  return [toks.slice(0, i), toks.slice(i + 1)];
}

// ------------------------------------------------------------ helpers

function sq(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

function inside(child, parent) {
  if (!parent) return false;
  let p = parent;
  try {
    p = fs.realpathSync(parent);
  } catch {}
  const rel = path.relative(p, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Load a text file the hook is allowed to reason about, or null. */
function loadFile(file, base) {
  try {
    let real = path.resolve(base || process.cwd(), file);
    real = fs.realpathSync(real);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    const buf = fs.readFileSync(real);
    const probe = buf.subarray(0, 4096);
    let bad = 0;
    for (const b of probe) if (b < 9 || (b > 13 && b < 32) || b === 127) bad++;
    if (probe.length && bad / probe.length > 0.1) return null;
    const content = buf.toString("utf8");
    return { real, stat, content, total: core.visibleLines(content), hash: core.hashOf(content) };
  } catch {
    return null;
  }
}

function writePrivate(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, name);
  fs.writeFileSync(p, data, { mode: 0o600 });
  return p;
}

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);

function sweep(dir, maxAgeMs) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

function outputSize(lines, from, to, numbered) {
  let n = 0;
  for (let i = from; i <= to; i++) n += (lines[i - 1]?.length ?? 0) + 1 + (numbered ? 8 : 0);
  return n;
}

const preDecision = (toolInput, command, reason) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: reason,
    updatedInput: { ...toolInput, command },
  },
});

// ------------------------------------------------------------- events

function preBash(ev) {
  const sid = ev.session_id;
  const input = ev.tool_input ?? {};
  const r = parseRead(input.command);
  if (!r || !sid || !ev.tool_use_id) return null;
  const f = loadFile(r.file, input.workdir || ev.cwd);
  if (!f || f.total === 0 || r.from > f.total) return null;

  const from = r.from;
  const to = Math.min(r.to, f.total);
  const lines = f.content.split("\n");
  const key = `${from}-${to}`;
  const prev = core.getEntry(core.loadRegistry(), sid, f.real);
  let { action, upto } = core.decide({
    prev,
    hash: f.hash,
    total: f.total,
    from,
    to,
    explicit: false,
    outputLength: outputSize(lines, from, to, r.numbered),
  });

  // Escape hatch: the same range asked again right after a stub/diff → real output.
  if ((action === "stub" || action === "diff") && prev?.lastStub === key && prev.hash === f.hash) action = "pass";
  if (action === "stub" && prev?.lastStub === key && prev.hash !== f.hash) action = "note";

  let rewrite = null;
  let text = null;
  if (action === "stub") {
    const what = from === 1 && to === f.total ? `"${f.real}"` : `lines ${from}-${to} of "${f.real}" (${f.total} lines total)`;
    text =
      `[GFC] unchanged: ${what} is identical to what you already read earlier in this conversation ` +
      `(sha256 ${f.hash.slice(0, 12)}, ${core.fmtKB(f.stat.size)}). Nothing new to show. ` +
      `If that earlier output is no longer in your context, run the exact same command again and it will print in full.`;
  } else if (action === "diff") {
    // A diff reveals new file content: only for files inside the project, so a
    // rewrite can never print something the original command needed approval for.
    const old = inside(f.real, ev.cwd) ? core.readBlob(prev.hash) : null;
    const diff = old === null ? null : core.lineDiff(old, f.content);
    if (core.diffWorthIt(diff, outputSize(lines, from, to, r.numbered))) {
      text =
        core.diffText(prev.hash, f.hash, f.total, diff) +
        `\n(To see the whole current file instead, run the exact same command again.)`;
    } else action = "note";
  }
  if (text !== null) {
    sweep(OUT_DIR, 3600_000);
    rewrite = writePrivate(OUT_DIR, safeId(ev.tool_use_id) + ".txt", text + "\n");
  }

  if (!rewrite && upto === null && action === "pass") return null;
  sweep(PENDING_DIR, 3600_000);
  writePrivate(
    PENDING_DIR,
    safeId(ev.tool_use_id) + ".json",
    JSON.stringify({ sid, file: f.real, hash: f.hash, total: f.total, size: f.stat.size, upto, action, key, prevHash: prev?.hash ?? null, out: rewrite }),
  );

  if (!rewrite) return null;
  return preDecision(
    input,
    `cat ${sq(rewrite)}`,
    action === "stub" ? "GFC: file unchanged since the model last read it" : "GFC: showing a diff of what changed",
  );
}

function postBash(ev) {
  const p = path.join(PENDING_DIR, safeId(ev.tool_use_id ?? "") + ".json");
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(p, "utf8"));
    fs.unlinkSync(p);
  } catch {
    return null;
  }
  if (pending.out) {
    try {
      fs.unlinkSync(pending.out);
    } catch {}
  }
  if (pending.sid !== ev.session_id) return null;
  const f = loadFile(pending.file, "/");
  if (!f || f.hash !== pending.hash) return null; // changed while running: register nothing

  if (pending.upto !== null) {
    if (pending.upto >= f.total) core.saveBlob(f.hash, f.content, f.stat.size, f.real, ev.cwd);
    const entry = { hash: f.hash, lines: f.total, upto: pending.upto, ts: Date.now() };
    if (pending.action === "stub" || pending.action === "diff") entry.lastStub = pending.key;
    core.putEntry(pending.sid, f.real, entry);
  } else if (pending.action === "stub") {
    const prev = core.getEntry(core.loadRegistry(), pending.sid, f.real);
    if (prev) core.putEntry(pending.sid, f.real, { ...prev, lastStub: pending.key, ts: Date.now() });
  }

  if (pending.action === "note" && pending.prevHash) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `[GFC] note: "${f.real}" changed since you last read it in this conversation ` +
          `(${pending.prevHash.slice(0, 12)} → ${f.hash.slice(0, 12)}). The output above is the CURRENT content.`,
      },
    };
  }
  return null;
}

/** Claude Code Read: register what the model was shown (never modify it). */
function postRead(ev) {
  const resp = ev.tool_response;
  const file = resp?.file;
  if (!ev.session_id || resp?.type !== "text" || !file || typeof file.content !== "string") return null;
  const f = loadFile(file.filePath ?? ev.tool_input?.file_path, ev.cwd);
  if (!f || f.total === 0) return null;
  const from = Number(file.startLine) || 1;
  const shown = file.content === "" ? [] : file.content.replace(/\n$/, "").split("\n");
  const to = from + shown.length - 1;
  if (to < from || to > f.total) return null;
  const disk = f.content.split("\n");
  for (let i = 0; i < shown.length; i++) {
    let d = disk[from - 1 + i];
    if (d?.endsWith("\r")) d = d.slice(0, -1);
    const s = shown[i];
    // exact, or a long line the harness truncated for display
    if (s !== d && !(d !== undefined && s.length >= 1000 && d.startsWith(s.slice(0, 1000)))) return null;
  }
  const prev = core.getEntry(core.loadRegistry(), ev.session_id, f.real);
  const explicit = ev.tool_input?.offset != null || ev.tool_input?.limit != null;
  const { upto } = core.decide({ prev, hash: f.hash, total: f.total, from, to, explicit, outputLength: 0 });
  if (upto === null) return null;
  if (upto >= f.total) core.saveBlob(f.hash, f.content, f.stat.size, f.real, ev.cwd);
  core.putEntry(ev.session_id, f.real, { hash: f.hash, lines: f.total, upto, ts: Date.now() });
  return null;
}

export function handle(ev) {
  if (!ev || typeof ev !== "object") return null;
  const name = ev.hook_event_name;
  if (name === "PreCompact" || (name === "SessionStart" && (ev.source === "compact" || ev.source === "clear"))) {
    if (ev.session_id) core.clearSession(ev.session_id);
    return null;
  }
  if (name === "PreToolUse" && ev.tool_name === "Bash") return preBash(ev);
  if (name === "PostToolUse" && ev.tool_name === "Bash") return postBash(ev);
  if (name === "PostToolUse" && ev.tool_name === "Read") return postRead(ev);
  return null;
}

// --------------------------------------------------------------- main

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      if (process.platform === "win32") return; // shell forms below are POSIX
      const out = handle(JSON.parse(raw));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (e) {
      if (process.env.GFC_DEBUG) process.stderr.write(`GFC hook error: ${e?.stack ?? e}\n`);
    }
  });
}
