#!/usr/bin/env node
// GFC test.mjs — deterministic end-to-end batteries (no LLM involved).
//   1. MCP server over real stdio JSON-RPC
//   2. OpenCode plugin, driven with read output in the exact OpenCode 1.x
//      format (wrapper, "N: " rows, 2000-line / 50 KB pages, line clamping)
// State is isolated via GFC_HOME; nothing outside temp dirs is touched.
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const GFC = fs.mkdtempSync(path.join(os.tmpdir(), "gfc-test-"));
process.env.GFC_HOME = GFC;
const FX = fs.mkdtempSync(path.join(os.tmpdir(), "gfc-fx-"));
const here = (f) => new URL(f, import.meta.url).pathname;
const lines = (n, w = 0) => Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(4, "0")}${"x".repeat(w)}`).join("\n") + "\n";
let checks = 0;
const ok = (c, msg) => {
  assert.ok(c, msg);
  checks++;
};

// ------------------------------------------------------------ MCP harness
function startServer() {
  const child = spawn(process.execPath, [here("./mcp.mjs")], { env: process.env, cwd: FX });
  let idc = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.res(msg);
      }
    } catch {}
  });
  child.stderr.on("data", (b) => process.stderr.write(b));
  return {
    call(method, params, ms = 10000) {
      return new Promise((res, rej) => {
        const id = ++idc;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`timeout: ${method}`));
        }, ms);
        pending.set(id, { res, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async read(args) {
      const r = await this.call("tools/call", { name: "gfc_read", arguments: args });
      const text = r.result?.content?.[0]?.text ?? "";
      return r.result?.isError ? `__ERROR__ ${text}` : text;
    },
    kill: () => child.kill(),
  };
}

async function mcpBattery() {
  const s = startServer();
  const init = await s.call("initialize", { protocolVersion: "2025-06-18" });
  ok(init.result.protocolVersion === "2025-06-18", "protocol");
  const pkg = JSON.parse(fs.readFileSync(here("./package.json"), "utf8"));
  ok(init.result.serverInfo.version === pkg.version, "serverInfo.version matches package.json");
  ok((await s.call("tools/list", {})).result.tools[0].name === "gfc_read", "tools/list");

  // prototype-named methods must answer, not hang
  for (const m of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const r = await s.call(m, {}, 2000);
    ok(r.error?.code === -32601, `prototype method ${m} → -32601`);
  }

  const file = path.join(FX, "f.txt");
  fs.writeFileSync(file, lines(300));
  const t1 = await s.read({ path: file });
  ok(t1.startsWith("<path>") && t1.includes("300: line 0300") && t1.includes("End of file"), "first read = full");
  const t2 = await s.read({ path: file });
  ok(t2.includes("[GFC] unchanged") && t2.length < 500, "re-read = tiny stub");
  ok(t2.includes("offset=1"), "stub names the escape hatch");

  // escape hatch: offset=1 always returns the real lines
  const esc = await s.read({ path: file, offset: 1 });
  ok(esc.includes("1: line 0001") && esc.includes("300: line 0300") && !esc.includes("[GFC]"), "offset=1 = real content");
  const t3 = await s.read({ path: file, offset: 100, limit: 5 });
  ok(t3.includes("100: line 0100") && t3.includes("104: line 0104") && !t3.includes("105:") && !t3.includes("[GFC]"), "slice");

  // two scattered edits → two-hunk numbered diff, far smaller than the file
  fs.writeFileSync(file, lines(300).replace("line 0020\n", "line 0020 A\n").replace("line 0280\n", "line 0280 B\n"));
  const t5 = await s.read({ path: file, offset: 100, limit: 5 });
  ok(t5.startsWith("[GFC] note: file changed"), "slice of changed file = note");
  const t4 = await s.read({ path: file });
  ok(t4.includes("[GFC] changed") && (t4.match(/^@@ /gm) || []).length === 2, "scattered edits = 2 hunks");
  ok(t4.includes("- 20: line 0020") && t4.includes("+ 20: line 0020 A") && t4.includes("+ 280: line 0280 B"), "numbered diff");
  ok(t4.length < t1.length / 5, "diff much smaller than full");
  ok((await s.read({ path: file })).includes("[GFC] unchanged"), "after diff, unchanged = stub");

  // input validation
  for (const [args, want] of [
    [{ offset: 1.5 }, "positive integer"],
    [{ offset: 0 }, "positive integer"],
    [{ limit: -3 }, "positive integer"],
    [{ offset: 99999 }, "past the end"],
  ]) {
    const r = await s.read({ path: file, ...args });
    ok(r.startsWith("__ERROR__") && r.includes(want), `validation ${JSON.stringify(args)}`);
  }

  // edges
  const empty = path.join(FX, "empty.txt");
  fs.writeFileSync(empty, "");
  ok((await s.read({ path: empty })).includes("0 lines"), "empty file");
  ok(!(await s.read({ path: empty })).includes("[GFC] unchanged"), "tiny file never stubs");
  ok((await s.read({ path: path.join(FX, "nope.txt") })).startsWith("__ERROR__"), "missing file = error");
  const bin = path.join(FX, "img.png");
  const binBuf = Buffer.alloc(4096, 0);
  binBuf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  fs.writeFileSync(bin, binBuf);
  ok((await s.read({ path: bin })).includes("binary or undecodable"), "binary guard");

  // CRLF file: rows are shown without \r, diff still works
  const crlf = path.join(FX, "win.txt");
  fs.writeFileSync(crlf, lines(200).replace(/\n/g, "\r\n"));
  const c1 = await s.read({ path: crlf });
  ok(!c1.includes("\r"), "CR stripped from rows");
  ok((await s.read({ path: crlf })).includes("[GFC] unchanged"), "CRLF stub");

  // large file: paged at 50 KB; unchanged first page stubs; paging extends
  const big = path.join(FX, "big.txt");
  fs.writeFileSync(big, lines(50000)); // ~600 KB
  const b1 = await s.read({ path: big });
  ok(Buffer.byteLength(b1) <= 52 * 1024 && b1.includes("Use offset="), "plain read of big file is one 50 KB page");
  const next = +/Use offset=(\d+)/.exec(b1)[1];
  const b2 = await s.read({ path: big });
  ok(b2.includes("[GFC] unchanged: lines 1-") && b2.includes(`offset=${next}`), "unchanged first page = stub with continue hint");
  await s.read({ path: big, offset: next });
  ok((await s.read({ path: big })).includes("[GFC] unchanged"), "paging forward keeps first page stubbed");
  fs.writeFileSync(big, lines(50000).replace("line 0007\n", "line 0007 Y\n"));
  const b3 = await s.read({ path: big });
  ok(b3.startsWith("[GFC] note: file changed") && b3.includes("7: line 0007 Y"), "changed big file = note + real page");

  // secrets are never written to the blob store
  const env = path.join(FX, ".env");
  fs.writeFileSync(env, "API_KEY=sk-live-DO-NOT-STORE\n".repeat(100));
  await s.read({ path: env });
  ok((await s.read({ path: env })).includes("[GFC] unchanged"), "secret file still stubs");
  const leaked = fs.readdirSync(path.join(GFC, "store")).some((f) => fs.readFileSync(path.join(GFC, "store", f), "utf8").includes("DO-NOT-STORE"));
  ok(!leaked, "secret content not persisted");
  ok((fs.statSync(path.join(GFC, "store")).mode & 0o077) === 0, "store dir is private");

  // a new server process = a new session: first read is real content again
  s.kill();
  const s2 = startServer();
  await s2.call("initialize", {});
  ok(!(await s2.read({ path: file })).includes("[GFC]"), "new session = full content");
  s2.kill();
}

// --------------------------------------------------------- plugin harness
// Reproduces OpenCode 1.x's read tool output (packages/opencode/src/tool/read.ts).
function opencodeRead(filePath, { offset, limit } = {}) {
  const raw = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  if (raw.at(-1) === "") raw.pop();
  const start = (offset || 1) - 1;
  const rows = [];
  let bytes = 0;
  let cut = false;
  for (let i = start; i < raw.length && rows.length < (limit ?? 2000); i++) {
    const l = raw[i].length > 2000 ? raw[i].substring(0, 2000) + "... (line truncated to 2000 chars)" : raw[i];
    const size = Buffer.byteLength(l) + (rows.length ? 1 : 0);
    if (bytes + size > 50 * 1024) {
      cut = true;
      break;
    }
    rows.push(l);
    bytes += size;
  }
  const first = start + 1;
  const last = start + rows.length;
  let out = [`<path>${filePath}</path>`, `<type>file</type>`, "<content>\n"].join("\n");
  out += rows.map((l, i) => `${first + i}: ${l}`).join("\n");
  if (cut) out += `\n\n(Output capped at 50 KB. Showing lines ${first}-${last}. Use offset=${last + 1} to continue.)`;
  else if (last < raw.length) out += `\n\n(Showing lines ${first}-${last} of ${raw.length}. Use offset=${last + 1} to continue.)`;
  else out += `\n\n(End of file - total ${raw.length} lines)`;
  return out + "\n</content>";
}

async function pluginBattery() {
  const plugin = (await import(here("./gfc-plugin.ts"))).default;
  const hooks = await plugin({ directory: FX });
  ok(typeof hooks["tool.execute.after"] === "function", "plugin loads core and registers hooks");
  const read = async (sessionID, filePath, args = {}) => {
    const output = { title: "", output: opencodeRead(path.resolve(FX, filePath), args), metadata: {} };
    await hooks["tool.execute.after"]({ tool: "read", sessionID, callID: "c", args: { filePath, ...args } }, output);
    return output.output;
  };

  const f = path.join(FX, "p.ts");
  fs.writeFileSync(f, lines(400));
  const r1 = await read("S1", f);
  ok(r1.includes("400: line 0400") && !r1.includes("[GFC]"), "plugin: first read untouched");
  ok((await read("S1", f)).includes("[GFC] unchanged"), "plugin: re-read stubs");
  ok(!(await read("S2", f)).includes("[GFC]"), "plugin: other session gets full content");
  const esc = await read("S1", f, { offset: 1 });
  ok(esc.includes("1: line 0001") && !esc.includes("[GFC]"), "plugin: offset=1 escape hatch is real content");
  ok(!(await read("", f)).includes("[GFC]"), "plugin: sessionless reads never intercepted");

  // relative path resolves against the plugin directory
  ok((await read("S1", "p.ts")).includes("[GFC] unchanged"), "plugin: relative filePath");

  // edit → numbered diff
  fs.writeFileSync(f, lines(400).replace("line 0123\n", "line 0123 EDIT\n"));
  const d = await read("S1", f);
  ok(d.includes("[GFC] changed") && d.includes("+ 123: line 0123 EDIT") && d.length < r1.length / 5, "plugin: diff");
  ok((await read("S1", f)).includes("[GFC] unchanged"), "plugin: stub after diff");

  // race: model was shown OLD rows, file changed on disk before the hook ran
  const g = path.join(FX, "race.ts");
  fs.writeFileSync(g, lines(300));
  const stale = opencodeRead(g);
  fs.writeFileSync(g, lines(300).replace("line 0050\n", "line 0050 NEW\n"));
  const out = { title: "", output: stale, metadata: {} };
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "R", callID: "c", args: { filePath: g } }, out);
  ok(out.output === stale, "plugin: stale dump passes through untouched");
  ok(!(await read("R", g)).includes("[GFC] unchanged"), "plugin: stale dump was not registered (no false stub)");

  // long lines clamped by OpenCode still verify
  const long = path.join(FX, "min.js");
  fs.writeFileSync(long, ("z".repeat(5000) + "\n").repeat(5));
  await read("L", long);
  ok((await read("L", long)).includes("[GFC] unchanged"), "plugin: clamped long lines verify");

  // CRLF
  const w = path.join(FX, "w.ts");
  fs.writeFileSync(w, lines(200).replace(/\n/g, "\r\n"));
  await read("W", w);
  ok((await read("W", w)).includes("[GFC] unchanged"), "plugin: CRLF verifies");

  // big paged file: first page stubs, paging forward extends
  const big = path.join(FX, "big.ts");
  fs.writeFileSync(big, lines(20000, 20));
  const p1 = await read("B", big);
  ok(p1.includes("Output capped at 50 KB"), "plugin: big file is paged by OpenCode");
  const nxt = +/Use offset=(\d+)/.exec(p1)[1];
  const p1b = await read("B", big);
  ok(p1b.includes("[GFC] unchanged: lines 1-") && p1b.includes(`offset=${nxt}`), "plugin: unchanged page stubs with continue hint");
  const p2 = await read("B", big, { offset: nxt });
  ok(p2.includes(`${nxt}: `) && !p2.includes("[GFC]"), "plugin: next page real");

  // directory / error outputs pass through
  const dirOut = { title: "", output: `<path>${FX}</path>\n<type>directory</type>\n<entries>\np.ts\n</entries>`, metadata: {} };
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "S1", callID: "c", args: { filePath: FX } }, dirOut);
  ok(dirOut.output.startsWith("<path>"), "plugin: directory untouched");

  // compaction: list files, then forget the session → next read is real
  const ctx = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: "S1" }, ctx);
  ok(ctx.context.length === 1 && ctx.context[0].includes(f) && !ctx.context[0].includes("line 0001"), "plugin: compaction note lists files, no content");
  const post = await read("S1", f);
  ok(post.includes("400: line 0400") && !post.includes("[GFC]"), "plugin: after compaction, full content again");
  ok((await read("S1", f)).includes("[GFC] unchanged"), "plugin: and stubs resume afterwards");
  ok((await read("S2", f)).startsWith("[GFC]"), "plugin: compaction of S1 leaves S2's knowledge intact");
}


// ------------------------------------------------------ hook harness
// Drives gfc-hook.mjs exactly like Claude Code / Codex: PreToolUse (may
// rewrite the command) → the command really runs in bash → PostToolUse.
import { spawnSync, execFileSync } from "node:child_process";

function hookCall(ev) {
  const r = spawnSync(process.execPath, [here("./gfc-hook.mjs")], { input: JSON.stringify(ev), env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, "hook exits 0");
  return r.stdout ? JSON.parse(r.stdout) : null;
}

let toolUse = 0;
function agentRun(session_id, command, cwd, { between } = {}) {
  const tool_use_id = `toolu_${++toolUse}`;
  const pre = hookCall({ hook_event_name: "PreToolUse", session_id, cwd, tool_name: "Bash", tool_use_id, tool_input: { command } });
  if (pre) {
    const h = pre.hookSpecificOutput;
    // Codex contract: allow only together with updatedInput; never ask/approve
    assert.equal(h.permissionDecision, "allow");
    assert.ok(h.updatedInput?.command, "allow carries updatedInput");
  }
  const ran = pre?.hookSpecificOutput.updatedInput.command ?? command;
  if (between) between();
  const stdout = execFileSync("bash", ["-c", ran], { cwd, encoding: "utf8" });
  const post = hookCall({
    hook_event_name: "PostToolUse", session_id, cwd, tool_name: "Bash", tool_use_id,
    tool_input: { command: ran }, tool_response: { stdout, stderr: "", interrupted: false },
  });
  return { stdout, rewritten: !!pre, note: post?.hookSpecificOutput?.additionalContext ?? null };
}

async function hookBattery() {
  const P = fs.mkdtempSync(path.join(os.tmpdir(), "gfc-proj-"));
  const f = path.join(P, "server.ts");
  fs.writeFileSync(f, lines(300, 30));
  const run = (cmd, o) => agentRun("C1", cmd, P, o);

  // Codex-style chunked reading
  const r1 = run("sed -n '1,200p' server.ts");
  ok(!r1.rewritten && r1.stdout.includes("line 0200") && !r1.stdout.includes("line 0201"), "hook: first chunk is real");
  const r2 = run("sed -n '1,200p' server.ts");
  ok(r2.rewritten && r2.stdout.startsWith("[GFC] unchanged: lines 1-200") && r2.stdout.length < 400, "hook: repeated chunk = stub");
  ok(r2.stdout.includes("run the exact same command again"), "hook: stub names the escape hatch");
  const r3 = run("sed -n '1,200p' server.ts");
  ok(!r3.rewritten && r3.stdout.includes("line 0200"), "hook: asking again right after a stub = real output");
  ok(run("sed -n '1,200p' server.ts").stdout.startsWith("[GFC] unchanged"), "hook: …and stubs resume after that");
  ok(!run("sed -n '201,300p' server.ts").rewritten, "hook: next chunk is real");
  ok(run("cat server.ts").stdout.startsWith('[GFC] unchanged: "'), "hook: contiguous chunks count as the whole file");
  ok(run("nl -ba server.ts | sed -n '40,90p'").stdout.startsWith("[GFC] unchanged: lines 40-90"), "hook: nl|sed of seen lines = stub");
  ok(run("head -n 120 server.ts").stdout.startsWith("[GFC] unchanged"), "hook: head of seen lines = stub");

  // other session, non-read commands
  ok(!agentRun("C2", "cat server.ts", P).rewritten, "hook: other session gets real content");
  const pendingBefore = fs.readdirSync(path.join(GFC, "pending")).length;
  ok(!agentRun("C1", "ls -la", P).rewritten && !agentRun("C1", "cat server.ts > /dev/null", P).rewritten, "hook: non-read commands untouched");
  ok(fs.readdirSync(path.join(GFC, "pending")).length === pendingBefore, "hook: no bookkeeping for non-reads");

  // edits → numbered diff; same command again → full file
  fs.writeFileSync(f, lines(300, 30).replace("line 0042" + "x".repeat(30), "line 0042 EDITED").replace("line 0250" + "x".repeat(30), "line 0250 EDITED"));
  const d = run("cat server.ts");
  ok(d.rewritten && d.stdout.startsWith("[GFC] changed") && (d.stdout.match(/^@@ /gm) || []).length === 2, "hook: changed file = 2-hunk diff");
  ok(d.stdout.includes("+ 42: line 0042 EDITED") && d.stdout.length < 2000, "hook: diff is numbered and small");
  const full = run("cat server.ts");
  ok(!full.rewritten && full.stdout.includes("line 0250 EDITED") && full.stdout.includes("line 0001"), "hook: same command after a diff = whole file");
  ok(run("cat server.ts").stdout.startsWith("[GFC] unchanged"), "hook: then stubs again");

  // changed + partial read → real lines + change note
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("line 0015", "line 0015 AGAIN"));
  const part = run("sed -n '10,20p' server.ts");
  ok(!part.rewritten && part.stdout.includes("line 0015 AGAIN") && part.note?.startsWith("[GFC] note"), "hook: changed slice = real + note");

  // race: file changes while the command runs → nothing registered
  const g = path.join(P, "race.ts");
  fs.writeFileSync(g, lines(200, 30));
  agentRun("R", "cat race.ts", P, { between: () => fs.writeFileSync(g, lines(200, 30).replace("line 0100", "line 0100 X")) });
  ok(!agentRun("R", "cat race.ts", P).rewritten, "hook: changed-while-running read was not registered (no false stub)");

  // compaction (Claude Code + Codex: PreCompact; Claude Code: SessionStart compact)
  hookCall({ hook_event_name: "PreCompact", session_id: "C1", cwd: P, trigger: "auto" });
  ok(!run("cat server.ts").rewritten, "hook: after PreCompact, real content");
  ok(run("cat server.ts").stdout.startsWith("[GFC] unchanged"), "hook: stubs resume after compaction");
  hookCall({ hook_event_name: "SessionStart", session_id: "C1", cwd: P, source: "compact" });
  ok(!run("cat server.ts").rewritten, "hook: SessionStart(compact) also clears");
  ok(hookCall({ hook_event_name: "SessionStart", session_id: "C1", cwd: P, source: "startup" }) === null, "hook: SessionStart prints nothing");

  // file outside the project: stubs fine, but a diff (new content) is never printed by rewrite
  const outside = path.join(FX, "outside.ts");
  fs.writeFileSync(outside, lines(300, 30));
  agentRun("O", `cat ${outside}`, P);
  ok(agentRun("O", `cat ${outside}`, P).stdout.startsWith("[GFC] unchanged"), "hook: outside-project file still stubs");
  fs.writeFileSync(outside, lines(300, 30).replace("line 0007", "line 0007 Z"));
  const od = agentRun("O", `cat ${outside}`, P);
  ok(!od.rewritten && od.stdout.includes("line 0007 Z") && od.note, "hook: outside-project change = real output + note, no rewrite");

  // tiny files never stub; secrets never stored
  fs.writeFileSync(path.join(P, "tiny.txt"), "a\nb\n");
  agentRun("T", "cat tiny.txt", P);
  ok(!agentRun("T", "cat tiny.txt", P).rewritten, "hook: tiny file never stubs");
  fs.writeFileSync(path.join(P, ".env"), "TOKEN=hook-secret-xyz\n".repeat(200));
  agentRun("E", "cat .env", P);
  ok(agentRun("E", "cat .env", P).stdout.startsWith("[GFC] unchanged"), "hook: .env stubs");
  const leaked = fs.readdirSync(path.join(GFC, "store")).some((x) => fs.readFileSync(path.join(GFC, "store", x), "utf8").includes("hook-secret-xyz"));
  ok(!leaked, "hook: secret never written to the store");

  // Claude Code Read registers (verified) → a later cat stubs; a mismatched Read does not
  const k = path.join(P, "k.ts");
  fs.writeFileSync(k, lines(250, 30));
  const content = fs.readFileSync(k, "utf8");
  hookCall({ hook_event_name: "PostToolUse", session_id: "K", cwd: P, tool_name: "Read", tool_use_id: "r1",
    tool_input: { file_path: k }, tool_response: { type: "text", file: { filePath: k, content, numLines: 250, startLine: 1, totalLines: 250 } } });
  ok(agentRun("K", "cat k.ts", P).stdout.startsWith("[GFC] unchanged"), "hook: Read then cat = stub");
  hookCall({ hook_event_name: "PostToolUse", session_id: "K2", cwd: P, tool_name: "Read", tool_use_id: "r2",
    tool_input: { file_path: k }, tool_response: { type: "text", file: { filePath: k, content: content.replace("line 0003", "stale"), numLines: 250, startLine: 1, totalLines: 250 } } });
  ok(!agentRun("K2", "cat k.ts", P).rewritten, "hook: Read that doesn't match disk is not trusted");
  ok(hookCall({ hook_event_name: "PostToolUse", session_id: "K", cwd: P, tool_name: "Read", tool_use_id: "r3",
    tool_input: { file_path: k }, tool_response: { type: "file_unchanged", file: { filePath: k } } }) === null, "hook: native file_unchanged left alone");

  // garbage in → silent pass, exit 0
  for (const junk of ["", "not json", "{}", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} })]) {
    const r = spawnSync(process.execPath, [here("./gfc-hook.mjs")], { input: junk, encoding: "utf8" });
    ok(r.status === 0 && r.stdout === "", `hook: garbage input fails open (${JSON.stringify(junk).slice(0, 20)})`);
  }

  ok(fs.readdirSync(path.join(GFC, "pending")).length === 0, "hook: no pending files left behind");
  ok(!fs.existsSync(path.join(GFC, "out")) || fs.readdirSync(path.join(GFC, "out")).length === 0, "hook: no output files left behind");
  fs.rmSync(P, { recursive: true, force: true });
}


// ---------------------------------------------------- installer battery
async function setupBattery() {
  const { run } = await import(here("./setup.mjs"));
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "gfc-home-"));
  const env = { HOME: H, PATH: process.env.PATH };
  const quiet = () => {};
  const claudeFile = path.join(H, ".claude", "settings.json");
  const codexFile = path.join(H, ".codex", "hooks.json");
  const ocFile = path.join(H, ".config", "opencode", "plugins", "gfc.ts");

  // user already has settings + their own hooks
  fs.mkdirSync(path.join(H, ".claude"), { recursive: true });
  const mine = { model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] }] } };
  fs.writeFileSync(claudeFile, JSON.stringify(mine));
  fs.mkdirSync(path.join(H, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(H, ".config", "opencode"), { recursive: true });

  ok(run([], env, quiet) === 0, "setup: auto-detect run succeeds");
  const c = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
  ok(c.model === "opus" && c.hooks.PreToolUse.some((g) => g.hooks[0].command === "my-guard.sh"), "setup: user's settings and hooks kept");
  const gfcCmd = (groups) => (groups ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes("gfc-hook.mjs"));
  ok(gfcCmd(c.hooks.PreToolUse).length === 1 && gfcCmd(c.hooks.PostToolUse).length === 1, "setup: Claude Code Pre/Post hooks added");
  ok(c.hooks.PostToolUse.find((g) => gfcCmd([g]).length).matcher === "Bash|Read", "setup: Claude Code also registers Read");
  ok(gfcCmd(c.hooks.PreCompact).length === 1 && gfcCmd(c.hooks.SessionStart).length === 1, "setup: Claude Code compaction hooks added");
  ok(fs.existsSync(claudeFile + ".gfc-backup"), "setup: backup written");

  const x = JSON.parse(fs.readFileSync(codexFile, "utf8"));
  ok(Object.keys(x).every((k) => ["description", "hooks"].includes(k)), "setup: Codex hooks.json has only allowed top-level keys");
  ok(gfcCmd(x.hooks.PreToolUse).length === 1 && gfcCmd(x.hooks.PreCompact).length === 1 && !x.hooks.SessionStart, "setup: Codex hooks added");
  ok(fs.lstatSync(ocFile).isSymbolicLink(), "setup: OpenCode plugin linked");

  // the installed command really runs the hook
  const cmd = gfcCmd(x.hooks.PreToolUse)[0].command;
  const r = spawnSync("bash", ["-c", cmd], { input: "{}", encoding: "utf8", env: { ...process.env, GFC_HOME: GFC } });
  ok(r.status === 0 && r.stdout === "", "setup: installed hook command executes");

  // idempotent
  const snap = fs.readFileSync(claudeFile, "utf8") + fs.readFileSync(codexFile, "utf8");
  run([], env, quiet);
  ok(fs.readFileSync(claudeFile, "utf8") + fs.readFileSync(codexFile, "utf8") === snap, "setup: second run changes nothing");

  // uninstall removes only GFC
  ok(run(["--uninstall"], env, quiet) === 0, "setup: uninstall succeeds");
  const u = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
  ok(JSON.stringify(u) === JSON.stringify(mine), "setup: uninstall restores the user's exact settings");
  ok(!JSON.parse(fs.readFileSync(codexFile, "utf8")).hooks && !fs.existsSync(ocFile), "setup: Codex + OpenCode cleaned");

  // a config it can't parse is never touched
  fs.writeFileSync(claudeFile, "{ this is not json");
  ok(run(["--claude"], env, quiet) === 1 && fs.readFileSync(claudeFile, "utf8") === "{ this is not json", "setup: unparsable config left untouched");

  // dry run writes nothing; nothing detected → nothing written
  const H2 = fs.mkdtempSync(path.join(os.tmpdir(), "gfc-home-"));
  run(["--codex", "--dry-run"], { HOME: H2, PATH: process.env.PATH }, quiet);
  ok(!fs.existsSync(path.join(H2, ".codex")), "setup: dry run writes nothing");
  fs.rmSync(H, { recursive: true, force: true });
  fs.rmSync(H2, { recursive: true, force: true });
}

try {
  await mcpBattery();
  console.log(`GFC mcp battery: passed`);
  if (process.features?.typescript) {
    await pluginBattery();
    console.log(`GFC plugin battery: passed`);
  } else {
    // Loading the .ts plugin needs Node's type stripping (Node ≥22.18).
    const msg = `plugin battery SKIPPED: Node ${process.version} cannot load .ts (needs ≥22.18)`;
    if (process.env.GFC_REQUIRE_PLUGIN_TESTS) throw new Error(msg);
    console.warn(`GFC ${msg}`);
  }
  await hookBattery();
  console.log(`GFC hook battery (Claude Code + Codex): passed`);
  await setupBattery();
  console.log(`GFC installer battery: passed`);
  console.log(`GFC test.mjs: ALL ${checks} CHECKS PASSED`);
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(GFC, { recursive: true, force: true });
  fs.rmSync(FX, { recursive: true, force: true });
}
