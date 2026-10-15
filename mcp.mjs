#!/usr/bin/env node
// GFC MCP server — git-for-context over the Model Context Protocol.
//
// One tool: gfc_read. Same registry/blob store and session-scoping semantics
// as the OpenCode plugin (both import core.mjs). Session scope = this server
// process lifetime (Codex keeps one MCP process per conversation), so a
// server restart behaves like a new session: first full read is real content.
//
// Contract the model can rely on (semantics live in core.decide):
//   - plain read: first page (≤2000 lines / 50 KB). Unchanged since seen →
//     stub; changed full file → numbered diff; otherwise real lines.
//   - explicit range (offset and/or limit): ALWAYS real lines. offset=1 is
//     the escape hatch for "I no longer have it" (e.g. after the client
//     compacted the conversation, which an MCP server cannot observe).
//   - paging forward with offset extends what counts as seen.
//
// Wire format: newline-delimited JSON-RPC 2.0 over stdio (MCP). Deliberately
// hand-rolled — initialize/tools-list/tools-call is the whole surface used.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as core from "./core.mjs";

const SID = "mcp_" + crypto.randomUUID();
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();
const PAGE_LINES = 2000; // same page shape as OpenCode's read tool
const PAGE_BYTES = 50 * 1024;
const MAX_LINE = 2000;
const clamp = (l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + `... (line truncated to ${MAX_LINE} chars)` : l);

// ------------------------------------------------------------- the tool

function posInt(v, name) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw new Error(`\`${name}\` must be a positive integer (got ${JSON.stringify(v)})`);
  return v;
}

function gfcRead(args) {
  const p = args?.path;
  if (typeof p !== "string" || !p) throw new Error("`path` is required");
  const offset = posInt(args.offset, "offset");
  const limit = posInt(args.limit, "limit");
  const explicit = offset !== null || limit !== null;

  const abs = path.resolve(process.cwd(), p);
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {}
  const stat = fs.statSync(real); // throws to caller on missing file
  if (!stat.isFile()) throw new Error(`not a file: ${real}`);

  const buf = fs.readFileSync(real);
  // binary guard: undecodable content should not enter the transcript
  const probe = buf.subarray(0, 4096);
  let bad = 0;
  for (const b of probe) {
    if (b < 9 || (b > 13 && b < 32) || b === 127) bad++;
  }
  if (probe.length > 0 && bad / probe.length > 0.1) throw new Error(`binary or undecodable file (not useful as text): ${real}`);

  const content = buf.toString("utf8");
  const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const total = core.visibleLines(content);
  const hash = core.hashOf(content);

  // ---- choose the page: from offset, ≤ limit lines, ≤ PAGE_BYTES
  const from = offset ?? 1;
  if (total > 0 && from > total) throw new Error(`offset ${from} is past the end of the file (${total} lines): ${real}`);
  const maxTo = Math.min(total, from + (limit ?? PAGE_LINES) - 1);
  const body = [];
  let bytes = 0;
  let to = from - 1;
  for (let n = from; n <= maxTo; n++) {
    const row = `${n}: ${clamp(lines[n - 1])}`;
    const size = Buffer.byteLength(row) + 1;
    if (bytes + size > PAGE_BYTES && body.length > 0) break;
    body.push(row);
    bytes += size;
    to = n;
  }
  const trailer =
    total === 0
      ? "(File is empty — 0 lines)"
      : to < total
        ? `(Showing lines ${from}-${to} of ${total}. Use offset=${to + 1} to continue.)`
        : `(End of file — total ${total} lines)`;
  const output = [`<path>${real}</path>`, ...body, trailer].join("\n");

  const prev = core.getEntry(core.loadRegistry(), SID, real);
  const { action, upto } = core.decide({ prev, hash, total, from, to, explicit, outputLength: output.length });
  if (upto !== null) {
    if (upto >= total) core.saveBlob(hash, content, stat.size, real, process.cwd()); // full content seen → diffable later
    core.putEntry(SID, real, { hash, lines: total, upto, ts: Date.now() });
  }

  if (action === "stub") return core.stubText(real, hash, total, to, stat.size, "call gfc_read with offset=1");
  if (action === "diff") {
    const old = core.readBlob(prev.hash);
    const diff = old === null ? null : core.lineDiff(old, content);
    if (core.diffWorthIt(diff, output.length)) return core.diffText(prev.hash, hash, total, diff);
    return core.changeNote(prev.hash, hash) + output;
  }
  if (action === "note") return core.changeNote(prev.hash, hash) + output;
  return output;
}

// -------------------------------------------------------- json-rpc layer

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "gfc_read",
    description:
      "Read a text file with git-for-context dedup. Re-reading an unchanged file returns a short [GFC] stub " +
      "(the content you already read is still valid); a changed file returns a numbered diff against what you last saw. " +
      "Passing offset and/or limit ALWAYS returns the real lines — use offset=1 to get the content again if you " +
      "no longer have it. Large files are paged (≤2000 lines / 50 KB per call); continue with the offset given. " +
      "Prefer this over cat/head/sed/tail. Returns 1-based numbered lines.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to the server's working directory)" },
        offset: { type: "integer", minimum: 1, description: "1-based first line to show (optional)" },
        limit: { type: "integer", minimum: 1, description: `Max lines to show (optional; pages are at most ${PAGE_LINES} lines / 50 KB)` },
      },
      required: ["path"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}
const respond = (id, result) => send({ id, result });
const respondErr = (id, code, message) => send({ id, error: { code, message } });

const methods = {
  initialize: (id, params) => {
    const requested = params?.protocolVersion;
    const version = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
    respond(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "GFC", version: VERSION } });
  },
  ping: (id) => respond(id, {}),
  "tools/list": (id) => respond(id, { tools: TOOLS }),
  "tools/call": (id, params) => {
    if (params?.name !== "gfc_read") {
      respondErr(id, -32602, `unknown tool: ${params?.name}`);
      return;
    }
    try {
      respond(id, { content: [{ type: "text", text: gfcRead(params.arguments ?? {}) }] });
    } catch (e) {
      respond(id, { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true });
    }
  },
};

core.gcBlobs();

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const hasId = msg && (typeof msg.id === "string" || typeof msg.id === "number");
  if (!hasId) return; // notifications get no response
  // Object.hasOwn: "constructor", "toString"… must not resolve to prototype functions.
  if (typeof msg.method !== "string" || !Object.hasOwn(methods, msg.method)) {
    respondErr(msg.id, -32601, `method not found: ${msg.method}`);
    return;
  }
  try {
    methods[msg.method](msg.id, msg.params);
  } catch (e) {
    respondErr(msg.id, -32603, String(e?.message ?? e));
  }
});
