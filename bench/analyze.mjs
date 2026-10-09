#!/usr/bin/env node
// analyze.mjs — parse gfc-bench jsonl runs into absolute metrics.
// No smoothing, no outlier removal: every attempt counted, valid-runs filter
// reported separately from raw attempt counts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(os.homedir(), "gfc-bench", "results");

function parseRun(file) {
  const m = {
    calls: 0, fresh_input: 0, cache_read: 0, cache_write: 0, output: 0,
    read_calls: 0, stubs: 0, diffs: 0, notes: 0, other_tool_calls: 0,
    final_text: "", valid: false, result: null, degenerate_reason: "",
  };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const t = d.type;
    if (t === "step_finish") {
      const tk = d.part?.tokens;
      if (tk) {
        m.calls++;
        m.fresh_input += tk.input || 0;
        m.output += tk.output || 0;
        m.cache_read += tk.cache?.read || 0;
        m.cache_write += tk.cache?.write || 0;
      }
    } else if (t === "tool_use") {
      const p = d.part || {};
      const out = p.state?.output || "";
      if (p.tool === "read") {
        m.read_calls++;
        if (out.includes("[gfc] unchanged")) m.stubs++;
        if (out.includes("[gfc] changed")) m.diffs++;
        if (out.includes("[gfc] note")) m.notes++;
      } else m.other_tool_calls++;
    } else if (t === "text") {
      m.final_text = d.part?.text || "";
    }
  }
  const txt = m.final_text;
  if (txt.includes("<|close|>") || txt.includes("<|open|>")) m.degenerate_reason = "token-soup markers";
  const nonAscii = (txt.match(/[^\x20-\x7E\s]/g) || []).length;
  if (txt.length > 0 && nonAscii / txt.length > 0.3) m.degenerate_reason = m.degenerate_reason || "high non-ascii";
  const rm = /<RESULT>([\s\S]*?)<\/RESULT>/i.exec(txt);
  if (!rm) m.degenerate_reason = m.degenerate_reason || "no <RESULT> tags";
  m.result = rm ? rm[1].trim() : null;
  m.valid = !m.degenerate_reason;
  return m;
}

function correctness(sc, arm, r) {
  if (r.result === null) return false;
  const res = r.result.toLowerCase();
  if (sc === "s1") return /line 0150/.test(res);
  if (sc === "s3") return /2000/.test(res);
  if (sc === "s5") return /small line 5/.test(res);
  if (sc === "s2") {
    // answer's claim must match the mechanism events of THAT run
    const t = r.result.toLowerCase();
    const claimsFull = /not a diff/.test(t) || (/full/.test(t) && !/(a|the) diff/.test(t) && !/summary notice|unchanged|stub/.test(t));
    const claimsNonFull = !claimsFull && (/diff/.test(t) || /summary notice|unchanged|stub/.test(t));
    if (r.diffs > 0) return claimsNonFull;
    if (r.stubs > 0) return claimsNonFull;
    return claimsFull;
  }
  return false;
}

const rows = [];
for (const model of fs.readdirSync(ROOT)) {
  const mdir = path.join(ROOT, model);
  if (!fs.statSync(mdir).isDirectory()) continue;
  for (const arm of fs.readdirSync(mdir)) {
    const adir = path.join(mdir, arm);
    for (const f of fs.readdirSync(adir)) {
      if (!f.endsWith(".jsonl")) continue;
      const [sc, rep] = f.replace(".jsonl", "").split("_");
      const r = parseRun(path.join(adir, f));
      rows.push({ model, arm, sc, rep: parseInt(rep, 10), ...r, correct: correctness(sc, arm, r) });
    }
  }
}

// aggregate per model|arm|sc
const groups = {};
for (const r of rows) {
  const k = `${r.model}|${r.arm}|${r.sc}`;
  (groups[k] ||= []).push(r);
}
const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / (s.length || 1);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { mean: Math.round(mean), median, min: s[0], max: s[s.length - 1] };
};

console.log("## Absolute results (all attempts, no retries, no outlier removal)\n");
for (const k of Object.keys(groups).sort()) {
  const [model, arm, sc] = k.split("|");
  const g = groups[k];
  const valid = g.filter((r) => r.valid);
  const fi = stat(valid.map((r) => r.fresh_input));
  const ctx = stat(valid.map((r) => r.fresh_input + r.cache_read));
  const out = stat(valid.map((r) => r.output));
  const reads = stat(g.map((r) => r.read_calls));
  const corr = valid.length ? valid.filter((r) => r.correct).length + "/" + valid.length : "-";
  console.log(
    `${model} arm${arm} ${sc}: attempts=${g.length} valid=${valid.length} ` +
    `degenerate=${g.length - valid.length} | fresh_input mean=${fi.mean} median=${fi.median} (${fi.min}-${fi.max}) ` +
    `| context_in mean=${ctx.mean} | output mean=${out.mean} | reads mean=${reads.mean} ` +
    `| stubs=${g.reduce((a, r) => a + r.stubs, 0)} diffs=${g.reduce((a, r) => a + r.diffs, 0)} ` +
    `| correct=${corr}`
  );
}

// headline deltas per model/sc: armB vs armA on valid runs
console.log("\n## Deltas (armB − armA, valid runs, fresh input)\n");
for (const model of [...new Set(rows.map((r) => r.model))]) {
  for (const sc of [...new Set(rows.map((r) => r.sc))]) {
    const A = groups[`${model}|A|${sc}`]?.filter((r) => r.valid) || [];
    const B = groups[`${model}|B|${sc}`]?.filter((r) => r.valid) || [];
    if (!A.length || !B.length) { console.log(`${model} ${sc}: incomplete`); continue; }
    const ma = stat(A.map((r) => r.fresh_input)).mean;
    const mb = stat(B.map((r) => r.fresh_input)).mean;
    const ca = stat(A.map((r) => r.fresh_input + r.cache_read)).mean;
    const cb = stat(B.map((r) => r.fresh_input + r.cache_read)).mean;
    const pct = ma ? Math.round(((mb - ma) / ma) * 100) : 0;
    console.log(
      `${model} ${sc}: A mean=${ma} B mean=${mb} delta=${mb - ma} (${pct}%) | context: A=${ca} B=${cb} (${Math.round(((cb - ca) / (ca || 1)) * 100)}%)`
    );
  }
}

fs.writeFileSync(path.join(os.homedir(), "gfc-bench", "analysis.json"), JSON.stringify(rows, null, 1));
console.log("\nraw rows → ~/gfc-bench/analysis.json");
