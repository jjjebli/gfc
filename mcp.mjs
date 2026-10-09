#!/usr/bin/env node
// gfc MCP server — git-for-context (GFC) over the Model Context Protocol.
//
// One tool: gfc_read. Same registry/blob store and session-scoping semantics
// as the OpenCode plugin (~/.config/opencode/plugins/gfc.ts imports the same
// ~/.gfc/core.mjs). Session scope = this server process lifetime (Codex keeps
// one MCP process per conversation), so a server restart behaves like a new
// session: first full read returns real content.
//
// Wire format: newline-delimited JSON-RPC 2.0 over stdio (MCP). Deliberately
// hand-rolled — initialize/tools-list/tools-call is the whole surface Codex
// uses. ponytail: if a client ever needs prompts/resources/capabilities
// negotiation edge cases, swap in @modelcontextprotocol/sdk.
//
// Configure in Codex (~/.codex/config.toml):
//   [mcp_servers.gfc]
//   command = "node"
//   args = ["/Users/s.bahij/.gfc/mcp.mjs"]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as core from "./core.mjs";

const SID = "mcp_" + crypto.randomUUID();

// ------------------------------------------------------------- the tool

function numberedFull(content, total, real) {
  const lines = content.split("\n");
  const out = [`<path>${real}</path>`];
  for (let n = 1; n <= total; n++) out.push(`${n}: ${lines[n - 1]}`);
  out.push(`(End of file — total ${total} lines)`);
  return out.join("\n");
}

function gfcRead(args) {
  const p = args?.path;
  if (typeof p !== "string" || !p) throw new Error("`path` is required");
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
  const total = core.visibleLines(content);
  const hash = core.hashOf(content);

  const reg = core.loadRegistry();
  const prev = core.getEntry(reg, SID, real);
  const known = !!prev;
  const put = () => {
    core.putEntry(SID, real, { hash, lines: total, ts: Date.now() });
  };

  const offset = Number.isFinite(args?.offset) ? args.offset : null;
  const limit = Number.isFinite(args?.limit) ? args.limit : null;

  if (offset !== null || limit !== null) {
    const from = Math.max(1, Math.min(offset ?? 1, Math.max(total, 1)));
    const to = Math.min(from + Math.max(1, limit ?? 1000) - 1, Math.max(total, 1));
    const lines = content.split("\n");
    const slice = [];
    for (let n = from; n <= to; n++) slice.push(`${n}: ${lines[n - 1]}`);
    let text =
      `<path>${real}</path>\n${slice.join("\n")}\n` +
      `(Showing lines ${from}-${to} of ${total}. Use offset=${to + 1} to continue.)`;
    if (known && prev.hash !== hash) {
      text =
        `[gfc] note: file changed since the full version you saw earlier in this conversation ` +
        `(${prev.hash.slice(0, 12)} → ${hash.slice(0, 12)}). Lines below are the CURRENT content:\n${text}`;
    }
    // Registry stays untouched: partial slices never count as "seen".
    return text;
  }

  const fullText = numberedFull(content, total, real);

  if (known && prev.hash === hash) {
    if (fullText.length >= core.MIN_STUB) {
      put();
      return (
        `[gfc] unchanged: "${real}" is byte-identical to the full content already present earlier in ` +
        `this conversation (sha256 ${hash.slice(0, 12)}, ${total} lines, ${core.fmtKB(stat.size)}). Nothing new to show — ` +
        `use gfc_read with offset/limit for specific lines.`
      );
    }
    put();
    return fullText;
  }

  if (known && prev.hash !== hash) {
    const old = core.readBlob(prev.hash);
    if (old !== null) {
      const diff = core.prefixSuffixDiff(old, content);
      if (diff && diff.length < fullText.length) {
        core.saveBlob(hash, content, stat.size);
        put();
        return (
          `[gfc] changed since the full version earlier in this conversation (${prev.hash.slice(0, 12)} → ${hash.slice(0, 12)}). ` +
          `Diff of last-seen → current (file now has ${total} lines; use gfc_read with offset/limit for any region):\n${diff}`
        );
      }
    }
    core.saveBlob(hash, content, stat.size);
    put();
    return `[gfc] note: file changed since the full version earlier in this conversation. Full current content:\n${fullText}`;
  }

  // First full read in this server's session.
  core.saveBlob(hash, content, stat.size);
  put();
  return fullText;
}

// -------------------------------------------------------- json-rpc layer

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "gfc_read",
    description:
      "Read a file with git-for-context dedup: re-reading an unchanged file returns a short [gfc] stub, and a changed file returns a diff vs what you last saw. Prefer this over cat/head/sed/tail for reading files. Returns 1-based numbered lines.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        offset: { type: "number", description: "1-based first line to show (optional)" },
        limit: { type: "number", description: "Max lines to show (optional)" },
      },
      required: ["path"],
    },
  },
];

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function respondErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const methods = {
  initialize: (id, params) => {
    const requested = params?.protocolVersion;
    const version = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
    respond(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "gfc", version: "1.0.0" } });
  },
  ping: (id) => respond(id, {}),
  "tools/list": (id) => respond(id, { tools: TOOLS }),
  "tools/call": (id, params) => {
    if (params?.name !== "gfc_read") {
      respondErr(id, -32602, `unknown tool: ${params?.name}`);
      return;
    }
    try {
      const text = gfcRead(params.arguments ?? {});
      respond(id, { content: [{ type: "text", text }] });
    } catch (e) {
      respond(id, { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true });
    }
  },
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const hasId = msg && (typeof msg.id === "string" || typeof msg.id === "number");
  if (!hasId) return; // notifications get no response
  const fn = methods[msg.method];
  if (!fn) {
    respondErr(msg.id, -32601, `method not found: ${msg.method}`);
    return;
  }
  try {
    fn(msg.id, msg.params);
  } catch (e) {
    respondErr(msg.id, -32603, String(e?.message ?? e));
  }
});
