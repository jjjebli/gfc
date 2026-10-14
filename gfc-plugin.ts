// GFC — git-for-context for OpenCode.
//
// Problem: the transcript is a linear replay. Re-reading an unchanged file
// re-pays the same tokens every turn. This plugin intercepts read-tool
// results BEFORE they enter the transcript:
//   - full re-read of an unchanged file → tiny hash-verifiable stub
//   - full read of a changed file       → unified-style diff vs what the
//                                         model last saw (when smaller)
//   - partial reads (offset/limit)      → pass-through, with a change-note
//                                         header prepended if file changed
//
// Shared logic + on-disk contract live in ~/.gfc/core.mjs (also used by the
// MCP server for Codex). The filesystem is the store of truth: if on-disk
// content still hashes to the registered hash, it is byte-identical to what
// the model already saw.
//
// "seen" is SESSION-SCOPED: models are stateless across sessions, so the
// first full read in any session always returns real content. Persisted
// sid lets a resumed session (opencode -c, same sessionID) keep stubbing.
//
// Zero per-turn overhead: no tools registered, no system-prompt additions.
// ponytail: tool.execute.after output mutation is persisted into the session
// part (verified by e2e test); if that ever breaks, fall back to
// experimental.chat.messages.transform as a send-time rewriter.

import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import type { Hooks } from "@opencode-ai/plugin";

const DEBUG = !!process.env.GFC_DEBUG;
function debug(msg: string) {
  try {
    const dir = path.join(os.homedir(), ".gfc");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "debug.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

let core: any; // ~/.gfc/core.mjs, loaded in the plugin init below
let directory = process.cwd();

function interceptRead(input: any, output: any) {
  const text = typeof output.output === "string" ? output.output : "";
  if (DEBUG) debug(`intercept tool=${input.tool} args=${JSON.stringify(input.args)} textLen=${text.length} textHead=${JSON.stringify(text.slice(0, 60))}`);
  if (!text) return;
  const filePath = input.args?.filePath;
  if (typeof filePath !== "string" || !filePath) return;
  if (DEBUG) debug(`intercept proceeding filePath=${filePath}`);
  const abs = path.resolve(directory, filePath);
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {}

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return;
  }
  if (!stat.isFile()) return;

  // Only intercept numbered file dumps ("N: content") — dirs, errors,
  // images and attachments pass through untouched.
  const lines = text.split("\n");
  // Skip leading wrapper lines (<path>…, <type>…, etc.) and trailing notes.
  let firstNo: number | null = null;
  for (let i = 0; i < lines.length && firstNo === null; i++) firstNo = core.lineNoOf(lines[i]);
  let lastNo: number | null = null;
  for (let i = lines.length - 1; i >= 0 && lastNo === null; i--) lastNo = core.lineNoOf(lines[i]);
  if (firstNo === null || lastNo === null) {
    if (DEBUG) debug(`not a numbered dump (first=${firstNo} last=${lastNo}) — pass-through`);
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(real, "utf8");
  } catch {
    return;
  }
  const total = core.visibleLines(content);
  const hash = core.hashOf(content);

  const reg = core.loadRegistry();
  const sid = typeof input.sessionID === "string" ? input.sessionID : "";
  // In-session knowledge only: a previous session's read never entered THIS
  // transcript, so it can't be stubbed or diffed against.
  const prev = core.getEntry(reg, sid, real);
  const known = !!prev;
  const isFull = firstNo === 1 && lastNo >= total;
  const put = () => {
    core.putEntry(sid, real, { hash, lines: total, ts: Date.now() });
  };

  if (!isFull) {
    // Targeted slice: the model explicitly wants these lines. Pass through,
    // but always warn if the file drifted from the full version in this
    // conversation — this is correctness info, no size threshold.
    // Registry stays untouched: partial slices never count as "seen".
    if (known && prev!.hash !== hash) {
      output.output =
        `[GFC] note: file changed since the full version you saw earlier in this conversation ` +
        `(${prev!.hash.slice(0, 12)} → ${hash.slice(0, 12)}). Lines below are the CURRENT content:\n${text}`;
    }
    return;
  }

  if (known && prev!.hash === hash && text.length >= core.MIN_STUB) {
    put();
    output.output =
      `[GFC] unchanged: "${real}" is byte-identical to the full content already present earlier in ` +
      `this conversation (sha256 ${hash.slice(0, 12)}, ${total} lines, ${core.fmtKB(stat.size)}). Nothing new to show — ` +
      `use read with offset/limit if you need specific lines again.`;
    return;
  }

  if (known && prev!.hash !== hash) {
    const old = core.readBlob(prev!.hash);
    if (old !== null) {
      const diff = core.prefixSuffixDiff(old, content);
      if (diff && diff.length < text.length) {
        core.saveBlob(hash, content, stat.size);
        put();
        output.output =
          `[GFC] changed since the full version earlier in this conversation (${prev!.hash.slice(0, 12)} → ${hash.slice(0, 12)}). ` +
          `Diff of last-seen → current (file now has ${total} lines; use read with offset/limit for any region):\n${diff}`;
        return;
      }
    }
    // No blob, or diff larger than the full text: fall back to full + note.
    core.saveBlob(hash, content, stat.size);
    put();
    output.output = `[GFC] note: file changed since the full version earlier in this conversation. Full current content:\n${text}`;
    return;
  }

  // First full read: pass through, register + store blob for future diffing.
  core.saveBlob(hash, content, stat.size);
  put();
}

export default async ({ directory: dir }: { directory?: string } = {}): Promise<Hooks> => {
  if (dir) directory = dir;
  try {
    // Find core.mjs next to this plugin's real location (handles symlinks and
    // relocated clones), fall back to the canonical ~/.gfc install.
    const self = fs.realpathSync(new URL(import.meta.url).pathname);
    for (const c of [path.dirname(self), path.join(os.homedir(), ".gfc")]) {
      try {
        core = await import(pathToFileURL(path.join(c, "core.mjs")).href);
        break;
      } catch {}
    }
    if (!core) throw new Error("core.mjs not found");
    fs.mkdirSync(core.STORE_DIR, { recursive: true });
    core.gcBlobs();
  } catch (e: any) {
    console.error(`GFC: failed to load core.mjs — plugin disabled (${e?.message ?? e})`);
    return {};
  }

  return {
    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool !== "read") return;
      try {
        interceptRead(input, output);
      } catch (e: any) {
        if (DEBUG) debug(`intercept ERROR: ${e?.stack ?? e}`);
      }
    },

    // Post-compaction, the model must still know which files are verified.
    "experimental.session.compacting": async (input: any, output: any) => {
      try {
        const reg = core.loadRegistry();
        const sid = typeof input?.sessionID === "string" ? input.sessionID : "";
        const seen = Object.entries(reg.entries?.[sid] ?? {})
          .sort((x: any, y: any) => y[1].ts - x[1].ts)
          .slice(0, 40);
        if (DEBUG) debug(`compaction hook: sid=${sid} seen_files=${seen.length} pushed=${seen.length > 0}`);
        if (seen.length === 0) return;
        output.context.push(
          "[GFC] These files were fully read earlier in this session (sha256 of full content given). " +
            "Do NOT paste their contents into the summary; if a specific region is needed later, " +
            "re-read it with the read tool (offset/limit):\n" +
            seen.map(([p, e]) => `- ${p} (${e.lines} lines, hash ${e.hash.slice(0, 12)})`).join("\n"),
        );
      } catch {}
    },
  };
};
