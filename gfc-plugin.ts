// GFC — git-for-context for OpenCode (verified against the shipped 1.x read
// tool: "<path>/<type>/<content>" wrapper, "N: line" rows, 2000-line /
// 50 KB pages, long lines clamped with "... (line truncated to N chars)").
//
// The transcript is a linear replay: re-reading an unchanged file re-pays the
// same tokens every turn. This plugin rewrites read-tool results BEFORE they
// enter the transcript. Semantics live in core.decide (shared with the MCP
// server and unit-tested there):
//   - plain re-read of content the model already has → tiny stub
//     (works per page, so large paged files benefit too)
//   - plain full re-read of a changed file → numbered diff (when smaller)
//   - explicit offset/limit → ALWAYS the real lines (the escape hatch),
//     with a change-note if the file drifted
//
// Safety rules:
//   - nothing is registered unless the rows the model was shown match the
//     file on disk right now (closes the read→hash race window)
//   - compaction clears the session: after it, the next read is real content
//   - sessionless calls are never intercepted
//
// Zero per-turn overhead: no tools registered, no system-prompt additions.

import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import type { Hooks } from "@opencode-ai/plugin";

const DEBUG = !!process.env.GFC_DEBUG;
function debug(msg: string) {
  try {
    const dir = process.env.GFC_HOME || path.join(os.homedir(), ".gfc");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, "debug.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

let core: any; // core.mjs, loaded in the plugin init below
let directory = process.cwd();

const CLAMP = /\.\.\.(?: \(line truncated to \d+ chars\))?$/;

/** Does a displayed row faithfully show this disk line? (tolerates clamping, CR) */
function rowMatches(shown: string, disk: string | undefined): boolean {
  if (disk === undefined) return false;
  if (disk.endsWith("\r")) disk = disk.slice(0, -1);
  if (shown === disk) return true;
  const m = CLAMP.exec(shown);
  return !!m && shown.length - m[0].length > 0 && disk.startsWith(shown.slice(0, m.index)) && disk.length > m.index;
}

/**
 * Extract the contiguous numbered rows of a read output and verify them
 * against the disk lines. Returns {from,to} or null if this isn't a faithful
 * file dump of the current disk content.
 */
function verifiedRange(text: string, diskLines: string[]): { from: number; to: number } | null {
  let from: number | null = null;
  let expect = 0;
  for (const line of text.split("\n")) {
    const n = core.lineNoOf(line);
    if (n === null) {
      if (from !== null && expect > from) break; // rows ended; trailers follow
      continue;
    }
    if (from === null) {
      from = n;
      expect = n;
    }
    if (n !== expect) return null;
    if (!rowMatches(line.slice(String(n).length + 2), diskLines[n - 1])) return null;
    expect++;
  }
  return from === null ? null : { from, to: expect - 1 };
}

function interceptRead(input: any, output: any) {
  const text = typeof output.output === "string" ? output.output : "";
  const sid = typeof input.sessionID === "string" ? input.sessionID : "";
  const filePath = input.args?.filePath;
  if (DEBUG) debug(`intercept sid=${sid} args=${JSON.stringify(input.args)} len=${text.length}`);
  if (!text || !sid || typeof filePath !== "string" || !filePath) return;

  const abs = path.resolve(directory, filePath);
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {}
  let stat: fs.Stats;
  let content: string;
  try {
    stat = fs.statSync(real);
    if (!stat.isFile()) return;
    content = fs.readFileSync(real, "utf8");
  } catch {
    return;
  }

  const range = verifiedRange(text, content.split("\n"));
  if (!range) {
    if (DEBUG) debug(`not a verified dump of current disk content — pass-through`);
    return;
  }

  const total = core.visibleLines(content);
  const hash = core.hashOf(content);
  const explicit = input.args?.offset != null || input.args?.limit != null;
  const prev = core.getEntry(core.loadRegistry(), sid, real);
  const { action, upto } = core.decide({ ...range, prev, hash, total, explicit, outputLength: text.length });
  if (DEBUG) debug(`decide ${real} ${range.from}-${range.to}/${total} explicit=${explicit} → ${action} upto=${upto}`);

  if (upto !== null) {
    if (upto >= total) core.saveBlob(hash, content, stat.size, real, directory);
    core.putEntry(sid, real, { hash, lines: total, upto, ts: Date.now() });
  }

  if (action === "stub") {
    output.output = core.stubText(real, hash, total, range.to, stat.size, "read it with offset=1");
  } else if (action === "diff") {
    const old = core.readBlob(prev.hash);
    const diff = old === null ? null : core.lineDiff(old, content);
    output.output = core.diffWorthIt(diff, text.length)
      ? core.diffText(prev.hash, hash, total, diff)
      : core.changeNote(prev.hash, hash) + text;
  } else if (action === "note") {
    output.output = core.changeNote(prev.hash, hash) + text;
  }
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
    if (!core?.decide) throw new Error("core.mjs not found (or outdated — re-run install.sh)");
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

    // Compaction removes earlier tool output from the model's context. Keep
    // the summary lean (no pasted file bodies), then forget the session so
    // the next read of any file returns real content instead of a stub that
    // points at text the model no longer has.
    "experimental.session.compacting": async (input: any, output: any) => {
      try {
        const sid = typeof input?.sessionID === "string" ? input.sessionID : "";
        if (!sid) return;
        const seen = Object.entries(core.loadRegistry().entries?.[sid] ?? {})
          .sort((x: any, y: any) => y[1].ts - x[1].ts)
          .slice(0, 40);
        core.clearSession(sid);
        if (DEBUG) debug(`compaction: sid=${sid} cleared ${seen.length} files`);
        if (seen.length === 0 || !Array.isArray(output?.context)) return;
        output.context.push(
          "[GFC] These files were read earlier in this session. Do NOT paste their contents into the summary — " +
            "after compaction, reading a file again returns its full current content:\n" +
            seen.map(([p, e]: any) => `- ${p} (${e.lines} lines)`).join("\n"),
        );
      } catch {}
    },
  };
};
