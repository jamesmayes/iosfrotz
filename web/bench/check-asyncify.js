#!/usr/bin/env node
// web/bench/check-asyncify.js: make asyncify-check. Plays every TADS
// walkthrough (bench/tads: the two test games, light and CPU-bound, and the
// two stress games) on dist/bench/tads{2,3}-check.js, the ASYNCIFY_ONLY
// builds linked with -sASSERTIONS=2, and on the plain builds
// dist/bench/tads{2,3}-sync.js, and checks that each plays to the end with
// the same transcript.
//
// With ASSERTIONS, ASYNCIFY checks after every call in a function it did
// not instrument that no unwind or rewind is under way, and aborts if one
// is. So a function wrongly left out of tads/asyncify-tads{2,3}.txt that an
// unwind goes through stops the run here (README.md, "ASYNCIFY for TADS"),
// where in the release build it would corrupt the game.

"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const web = path.join(__dirname, "..");
const RUNS = [
  ["tads2", "errand.gam", "errand"],
  ["tads2", "errand.gam", "errand-cpu"],
  ["tads2", "stress2.gam", "stress2"],
  ["tads3", "belfry.t3", "belfry"],
  ["tads3", "belfry.t3", "belfry-cpu"],
  ["tads3", "stress3.t3", "stress3"],
];

function play(engine, story, walk, build, module) {
  const args = [path.join(__dirname, "run-bench.js"), build, `bench/tads/${story}`,
    `bench/tads/${walk}.walk`, "--engine", engine];
  if (module) args.push("--module", module);
  const r = spawnSync(process.execPath, args, { cwd: web, encoding: "utf8" });
  const last = r.stdout.trim().split("\n").pop();
  let res = null;
  try { res = JSON.parse(last); } catch (e) { /* reported below */ }
  return { res, status: r.status, err: r.stderr };
}

let failed = 0;
for (const [engine, story, walk] of RUNS) {
  const plain = play(engine, story, walk, "sync", null);
  const check = play(engine, story, walk, "async", `dist/bench/${engine}-check.js`);
  const name = `${engine} ${walk}`;
  const problems = [];
  if (!plain.res || !plain.res.complete) problems.push("the plain build did not play to the end");
  if (!check.res || !check.res.complete) {
    problems.push("the ASYNCIFY_ONLY build did not play to the end");
    const msg = check.err.split("\n").filter((l) => /abort|assert|unreachable|Error/i.test(l)).slice(0, 4);
    for (const m of msg) problems.push(`  ${m.trim()}`);
  }
  if (plain.res && check.res && plain.res.hash !== check.res.hash)
    problems.push(`transcripts differ (${plain.res.hash} plain, ${check.res.hash} ASYNCIFY_ONLY)`);
  if (problems.length) {
    failed++;
    console.log(`FAIL ${name}`);
    for (const p of problems) console.log(`     ${p}`);
  } else {
    console.log(`ok   ${name}: ${check.res.turns} turns, same transcript as the plain build ` +
      `(${check.res.hash})`);
  }
}
if (failed) {
  console.log(`${failed} of ${RUNS.length} failed`);
  process.exit(1);
}
console.log(`all ${RUNS.length} passed`);
