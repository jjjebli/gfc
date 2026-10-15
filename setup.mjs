#!/usr/bin/env node
// GFC setup — wires GFC into every harness it finds, safely and idempotently.
//
//   node setup.mjs                 auto-detect OpenCode, Claude Code, Codex
//   node setup.mjs --claude --codex   only these
//   node setup.mjs --uninstall     remove GFC from all of them
//   node setup.mjs --dry-run       show what would change
//
// Rules: never overwrite a config it can't parse; back up every file before
// changing it; only ever add/remove entries whose command runs gfc-hook.mjs,
// so the user's own hooks are untouched; running twice changes nothing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const MARK = "gfc-hook.mjs";

const q = (s) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

export function hookCommand(env = process.env) {
  const cmd = `${q(process.execPath)} ${q(path.join(HERE, MARK))}`;
  return env.GFC_HOME ? `GFC_HOME=${q(env.GFC_HOME)} ${cmd}` : cmd;
}

const isGfc = (h) => typeof h?.command === "string" && h.command.includes(MARK);

/** Remove GFC handlers from a hooks map (keeps everything else). */
export function stripGfc(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hs = g.hooks.filter((h) => !isGfc(h));
      if (hs.length) kept.push({ ...g, hooks: hs });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

/** The GFC hook set for a harness. */
export function gfcHooks(harness, command) {
  const h = (timeout) => [{ type: "command", command, timeout }];
  const base = {
    PreToolUse: [{ matcher: "Bash", hooks: h(10) }],
    PostToolUse: [{ matcher: harness === "claude" ? "Bash|Read" : "Bash", hooks: h(10) }],
    PreCompact: [{ hooks: h(10) }],
  };
  if (harness === "claude") base.SessionStart = [{ matcher: "compact|clear", hooks: h(10) }];
  return base;
}

export function mergeHooks(existing, add) {
  const out = stripGfc(existing);
  for (const [event, groups] of Object.entries(add)) out[event] = [...(out[event] ?? []), ...groups];
  return out;
}

// ------------------------------------------------------------- targets

function home() {
  return process.env.HOME || os.homedir();
}

function onPath(bin) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function targets(env = process.env) {
  const h = env.HOME || os.homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(h, ".claude");
  const codexDir = env.CODEX_HOME || path.join(h, ".codex");
  const opencodeDir = path.join(env.XDG_CONFIG_HOME || path.join(h, ".config"), "opencode");
  return {
    opencode: { name: "OpenCode", dir: opencodeDir, file: path.join(opencodeDir, "plugins", "gfc.ts"), bin: "opencode" },
    claude: { name: "Claude Code", dir: claudeDir, file: path.join(claudeDir, "settings.json"), bin: "claude" },
    codex: { name: "Codex", dir: codexDir, file: path.join(codexDir, "hooks.json"), bin: "codex" },
  };
}

function readJson(file) {
  if (!fs.existsSync(file)) return { data: {}, existed: false };
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return { data: {}, existed: true };
  const data = JSON.parse(raw); // throws → caller refuses to touch the file
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("top level is not a JSON object");
  return { data, existed: true };
}

function writeJson(file, data, existed, dry) {
  if (dry) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existed) fs.copyFileSync(file, `${file}.gfc-backup`);
  const tmp = `${file}.gfc-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function applyHooksFile(t, harness, uninstall, dry, command) {
  const { data, existed } = readJson(t.file);
  if (!existed && uninstall) return "nothing to remove";
  const before = JSON.stringify(data.hooks ?? {});
  const hooks = uninstall ? stripGfc(data.hooks) : mergeHooks(data.hooks, gfcHooks(harness, command));
  if (JSON.stringify(hooks) === before) return uninstall ? "nothing to remove" : "already up to date";
  const next = { ...data };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  writeJson(t.file, next, existed, dry);
  return uninstall ? `removed GFC hooks from ${t.file}` : `added GFC hooks to ${t.file}`;
}

function applyOpencode(t, uninstall, dry) {
  const src = path.join(HERE, "gfc-plugin.ts");
  let current = null;
  try {
    current = fs.lstatSync(t.file);
  } catch {}
  if (uninstall) {
    if (!current) return "nothing to remove";
    if (!dry) fs.unlinkSync(t.file);
    return `removed ${t.file}`;
  }
  if (current?.isSymbolicLink() && fs.readlinkSync(t.file) === src) return "already up to date";
  if (!dry) {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    if (current) fs.unlinkSync(t.file);
    try {
      fs.symlinkSync(src, t.file);
    } catch {
      fs.copyFileSync(src, t.file);
    }
  }
  return `plugin linked at ${t.file}`;
}

// ---------------------------------------------------------------- main

export function run(argv, env = process.env, log = console.log) {
  const flags = new Set(argv);
  const uninstall = flags.has("--uninstall");
  const dry = flags.has("--dry-run");
  const all = targets(env);
  const picked = ["opencode", "claude", "codex"].filter((k) => flags.has(`--${k}`));
  const auto = picked.length === 0;
  const chosen = auto ? Object.keys(all).filter((k) => uninstall || fs.existsSync(all[k].dir) || onPath(all[k].bin)) : picked;
  const command = hookCommand(env);
  let failed = 0;

  if (!chosen.length) log("GFC: no OpenCode, Claude Code or Codex found. Use --opencode / --claude / --codex to force.");
  for (const k of chosen) {
    const t = all[k];
    try {
      const msg = k === "opencode" ? applyOpencode(t, uninstall, dry) : applyHooksFile(t, k, uninstall, dry, command);
      log(`GFC ${dry ? "(dry run) " : ""}${t.name}: ${msg}`);
      if (!uninstall && k === "codex" && !msg.startsWith("already")) {
        log(`    Codex runs new hooks only after you trust them: start codex, type /hooks, and trust the GFC hooks.`);
      }
    } catch (e) {
      failed++;
      log(`GFC ${t.name}: NOT changed — ${t.file} could not be parsed (${e.message}). Fix it, or add the hooks by hand (see README).`);
    }
  }
  if (!uninstall) {
    log("");
    log("Other MCP clients (Cursor, Gemini CLI, Windsurf…): add a stdio server");
    log(`    command: ${process.execPath}   args: ["${path.join(HERE, "mcp.mjs")}"]`);
  }
  return failed ? 1 : 0;
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = run(process.argv.slice(2));
