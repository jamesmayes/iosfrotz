#!/usr/bin/env node
// web/bench/measure.js: ASYNCIFY vs plain build of git, same stories, same
// commands. Each run is its own Node process (fresh JIT and heap); the two
// builds alternate so drift hits both alike.
//
//   make bench && node bench/measure.js [--runs N]
//
// Prints a Markdown table: medians over the runs of startup (callMain to the
// first input wait), all turns, the mean turn, the slowest turn, and the
// ASYNCIFY/plain ratio of the turn time, and the most of the Asyncify buffer
// one unwind used (the ASYNCIFY_STACK_SIZE actually needed).

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const web = path.join(__dirname, "..");
const runsIdx = process.argv.indexOf("--runs");
const RUNS = runsIdx > 0 ? parseInt(process.argv[runsIdx + 1], 10) : 7;

const STORIES = [
  { name: "Advent.ulx (Inform 6)", story: "games/Advent.ulx", walk: "bench/advent.walk" },
  { name: "Alabaster.gblorb (Inform 7)", story: "../git/test/Alabaster.gblorb",
    walk: "../git/test/Alabaster.walk" },
];

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
  const hashes = new Set([...res.async, ...res.sync].map((r) => r.hash));
  const sum = {};
  for (const b of ["sync", "async"]) {
    const r = res[b];
    sum[b] = {
      turns: r[0].turns,
      startup: median(r.map((x) => x.startupMs)),
      turnsMs: median(r.map((x) => x.turnsMs)),
      mean: median(r.map((x) => x.turnsMs / x.turns)),
      max: median(r.map((x) => Math.max(...x.perTurnMs))),
      total: median(r.map((x) => x.totalMs)),
      stack: Math.max(...r.map((x) => x.asyncifyMaxBytes || 0)),
    };
  }
  rows.push({ st, sum, same: hashes.size === 1 });
}

const size = (f) => fs.statSync(path.join(web, f)).size;
console.log(`Runs per build and story: ${RUNS} (medians). Node ${process.version}.\n`);
console.log("| Story | Build | Turns | Startup ms | All turns ms | Mean turn ms | Slowest turn ms | Total ms | Turn time vs plain | Asyncify buffer used |");
console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const { st, sum, same } of rows) {
  for (const b of ["sync", "async"]) {
    const s = sum[b];
    const ratio = b === "async" ? `${fmt(s.turnsMs / sum.sync.turnsMs, 3)}×` : "1×";
    console.log(`| ${st.name} | ${b === "async" ? "(a) ASYNCIFY" : "(b) plain"} | ${s.turns} | ` +
      `${fmt(s.startup, 1)} | ${fmt(s.turnsMs, 1)} | ${fmt(s.mean, 3)} | ${fmt(s.max, 1)} | ` +
      `${fmt(s.total, 1)} | ${ratio} | ${b === "async" ? s.stack + " B" : "–"} |`);
  }
  if (!same) console.log(`| ${st.name} | **transcripts differ between runs or builds** | | | | | | | | |`);
}
console.log("\n| File | Bytes |\n|---|---:|");
for (const f of ["dist/bench/git-async.wasm", "dist/bench/git-sync.wasm", "dist/git.wasm",
                 "dist/git.js", "dist/frotz.wasm"])
  if (fs.existsSync(path.join(web, f))) console.log(`| ${f} | ${size(f)} |`);
