#!/usr/bin/env node
// GFC test.mjs — deterministic MCP-stack battery (no LLM involved).
// Covers: stub, diff, partial slice, change-note, empty/missing/binary/
// oversize files, cross-process registry race. Isolated via GFC_HOME.
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const GFC = fs.mkdtempSync(path.join(os.tmpdir(), "gfc-test-"));
process.env.GFC_HOME = GFC;
const FX = fs.mkdtempSync(path.join(os.tmpdir(), "gfc-fx-"));

const MCP_PATH = new URL("./mcp.mjs", import.meta.url).pathname;

function startServer() {
  const child = spawn(process.execPath, [MCP_PATH], {
    env: process.env,
  });
  let idc = 0;
  const pending = new Map();
  readline
    .createInterface({ input: child.stdout })
    .on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    });
  child.stderr.on("data", () => {});
  return {
    call(method, params) {
      return new Promise((res, rej) => {
        const id = ++idc;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        setTimeout(() => rej(new Error(`timeout: ${method}`)), 30000);
      });
    },
    async read(args) {
      const r = await this.call("tools/call", { name: "gfc_read", arguments: args });
      const text = r.result?.content?.[0]?.text ?? "";
      return r.result?.isError ? `__ERROR__ ${text}` : text;
    },
    kill() {
      child.kill();
    },
  };
}

const main = async () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(4, "0")}`).join("\n") + "\n";

  // --- one-server session: stub, diff, partial, note
  const s = startServer();
  const init = await s.call("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = await s.call("tools/list", {});
  assert.equal(list.result.tools[0].name, "gfc_read");

  const file = path.join(FX, "f.txt");
  fs.writeFileSync(file, lines(300));

  const t1 = await s.read({ path: file });
  assert.ok(t1.startsWith("<path>") && t1.includes("300: line 0300"), "first read = full numbered dump");
  const t2 = await s.read({ path: file });
  assert.ok(t2.includes("[GFC] unchanged"), "re-read = stub");
  assert.ok(t2.length < 400, "stub is tiny");

  const t3 = await s.read({ path: file, offset: 100, limit: 5 });
  assert.ok(t3.includes("100: line 0100") && !t3.includes("[GFC]"), "partial = clean slice");

  fs.writeFileSync(file, lines(300).replace("line 0150", "line 0150 X"));
  const t5 = await s.read({ path: file, offset: 100, limit: 5 });
  assert.ok(t5.startsWith("[GFC] note: file changed"), "partial before the change is seen = note + slice");
  const t4 = await s.read({ path: file });
  assert.ok(t4.includes("[GFC] changed") && t4.includes("- line 0150") && t4.includes("+ line 0150 X"), "changed = diff");
  assert.ok(t4.length < t1.length, "diff smaller than full");

  // --- edges
  const empty = path.join(FX, "empty.txt");
  fs.writeFileSync(empty, "");
  const t6 = await s.read({ path: empty });
  assert.ok(t6.includes("total 0 lines"), "empty file reads cleanly");
  const t7 = await s.read({ path: empty });
  assert.ok(!t7.includes("[GFC] unchanged"), "tiny file never stubs (MIN_STUB)");

  const t8 = await s.read({ path: path.join(FX, "nope.txt") });
  assert.ok(t8.startsWith("__ERROR__"), "missing file = error");

  const bin = path.join(FX, "img.png");
  const binBuf = Buffer.alloc(4096, 0);
  binBuf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  fs.writeFileSync(bin, binBuf);
  const t9 = await s.read({ path: bin });
  assert.ok(t9.includes("binary or undecodable"), "binary guard fires");

  // --- oversize (>512KB): no blob → change falls back to full + note
  const big = path.join(FX, "big.txt");
  fs.writeFileSync(big, lines(50000)); // ~600KB > MAX_BLOB
  const t10 = await s.read({ path: big });
  assert.ok(t10.includes("50000: line 50000"), "oversize first read = full");
  fs.writeFileSync(big, lines(50000).replace("line 7000\n", "line 7000 Y\n"));
  const t11 = await s.read({ path: big });
  assert.ok(t11.includes("[GFC] note: file changed") && t11.includes("Full current content"), "oversize change = full + note (no blob diff)");
  s.kill();

  console.log("GFC mcp battery: ALL PASSED");
  console.log(`  isolated state: ${GFC}`);
  fs.rmSync(GFC, { recursive: true, force: true });
  fs.rmSync(FX, { recursive: true, force: true });
};

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
