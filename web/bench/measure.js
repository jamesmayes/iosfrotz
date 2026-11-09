#!/usr/bin/env node
// web/bench/measure.js: ASYNCIFY vs plain build of git, same stories, same
// commands. Each run is its own Node process (fresh JIT and heap); the two
// builds alternate so drift hits both alike.
//
//   make bench && node bench/measure.js [--runs N]
//
// Prints a Markdown table: medians over the runs of module load (compiling
// and instantiating the wasm), startup (from before module load to the first
// input wait, so module load included), all turns, the mean turn, the
// slowest turn, and the ASYNCIFY/plain ratio of the turn time, and the most
// of the Asyncify buffer one unwind used (the ASYNCIFY_STACK_SIZE actually
// needed).
//
// The run fails (exit 1, after the table) if, for any story, the transcripts
// differ between runs or builds, the turn counts differ, or a run did not
// play every command of its walkthrough to a normal end.
//
// Adventure is not shipped in web/ (games/LICENSES.md, "Available after
// clearance"); put the IF Archive's advent.ulx at bench/local/Advent.ulx
// (SHA-256 264236f2...387f8) to include it. Without it, only Alabaster runs.
//
// These figures are for git under Node. glulxe and TADS have their own
// interpreter loops and Glk use, and need their own measurement, in Safari,
// before their architecture is fixed.

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const web = path.join(__dirname, "..");
const runsIdx = process.argv.indexOf("--runs");
const RUNS = runsIdx > 0 ? parseInt(process.argv[runsIdx + 1], 10) : 7;

const ALL_STORIES = [
  { name: "Advent.ulx (Inform 6)", story: "bench/local/Advent.ulx", walk: "bench/advent.walk",
    optional: true },
  { name: "Alabaster.gblorb (Inform 7)", story: "../git/test/Alabaster.gblorb",
    walk: "../git/test/Alabaster.walk" },
];
const STORIES = ALL_STORIES.filter((st) => {
  if (fs.existsSync(path.join(web, st.story))) return true;
  console.log(`Skipping ${st.name}: ${st.story} is not there (see the comment at the top).`);
  return false;
});

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function runOnce(build, st) {
  const out = execFileSync(process.execPath,
    [path.join(__dirname, "run-bench.js"), build, st.story, st.walk],
    { cwd: web, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out.trim().split("\n").pop());
}

const fmt = (x, d = 2) => x.toFixed(d);
const rows = [];
for (const st of STORIES) {
  const res = { async: [], sync: [] };
  for (let i = 0; i < RUNS; i++)
    for (const b of i % 2 ? ["sync", "async"] : ["async", "sync"]) res[b].push(runOnce(b, st));
  const all = [...res.async, ...res.sync];
  const hashes = new Set(all.map((r) => r.hash));
  const turnCounts = new Set(all.map((r) => r.turns));
  const incomplete = all.filter((r) => !r.complete);
  const sum = {};
  for (const b of ["sync", "async"]) {
    const r = res[b];
    sum[b] = {
      turns: r[0].turns,
      module: median(r.map((x) => x.moduleMs)),
      startup: median(r.map((x) => x.startupMs)),
      turnsMs: median(r.map((x) => x.turnsMs)),
      mean: median(r.map((x) => x.turnsMs / x.turns)),
      max: median(r.map((x) => Math.max(...x.perTurnMs))),
      total: median(r.map((x) => x.totalMs)),
      stack: Math.max(...r.map((x) => x.asyncifyMaxBytes || 0)),
    };
  }
  rows.push({ st, sum, same: hashes.size === 1, sameTurns: turnCounts.size === 1, incomplete });
}

const size = (f) => fs.statSync(path.join(web, f)).size;
console.log(`Runs per build and story: ${RUNS} (medians). Node ${process.version}.\n`);
console.log("| Story | Build | Turns | Module load ms | Startup ms | All turns ms | Mean turn ms | Slowest turn ms | Total ms | Turn time vs plain | Asyncify buffer used |");
console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
const problems = [];
for (const { st, sum, same, sameTurns, incomplete } of rows) {
  for (const b of ["sync", "async"]) {
    const s = sum[b];
    const ratio = b === "async" ? `${fmt(s.turnsMs / sum.sync.turnsMs, 3)}×` : "1×";
    console.log(`| ${st.name} | ${b === "async" ? "(a) ASYNCIFY" : "(b) plain"} | ${s.turns} | ` +
      `${fmt(s.module, 1)} | ${fmt(s.startup, 1)} | ${fmt(s.turnsMs, 1)} | ${fmt(s.mean, 3)} | ${fmt(s.max, 1)} | ` +
      `${fmt(s.total, 1)} | ${ratio} | ${b === "async" ? s.stack + " B" : "–"} |`);
  }
  if (!same) problems.push(`${st.name}: transcripts differ between runs or builds`);
  if (!sameTurns) problems.push(`${st.name}: turn counts differ between runs or builds`);
  for (const r of incomplete)
    problems.push(`${st.name}: a ${r.build} run ended "${r.reason}" after ` +
      `${r.commandsUsed} of ${r.commandsTotal} commands`);
}
console.log("\n| File | Bytes |\n|---|---:|");
for (const f of ["dist/bench/git-async.wasm", "dist/bench/git-sync.wasm", "dist/git.wasm",
                 "dist/git.js", "dist/frotz.wasm"])
  if (fs.existsSync(path.join(web, f))) console.log(`| ${f} | ${size(f)} |`);
if (problems.length) {
  console.log("\n**The measurement is not valid:**");
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}

