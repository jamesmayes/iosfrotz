#!/usr/bin/env node
// web/bench/run-bench.js: play one story headlessly through a Node build
// of an interpreter on the browser Glk (git: make bench; TADS: make
// bench-tads) and time every turn.
//
//   node bench/run-bench.js async|sync STORY WALK [--engine git|tads2|tads3]
//                           [--transcript FILE]
//
// --engine picks dist/bench/<engine>-<build>.js; the default is git.
//
// "async" loads dist/bench/git-async.js (built with -sASYNCIFY: every
// glk_select unwinds and rewinds the C stack through an awaited Promise,
// exactly as in the browser). "sync" loads dist/bench/git-sync.js (no
// ASYNCIFY; glk_select gets its event from a plain function call). Both
// are the same objects; only glk_web.c's bridge differs (-DGLK_WEB_SYNC).
//
// Input comes from WALK, one command per line, fed to each line request
// as soon as the game asks. Char requests get a space. When the commands
// run out the run ends. Date.now is pinned, so git seeds its random number
// generator the same way in both builds and they play the same game; the
// transcript hash printed at the end lets the two be compared.
//
// Prints one JSON line: { engine, build, reason, turns, moduleMs, startupMs,
// mainStartupMs, totalMs, perTurnMs[], commandsUsed, commandsTotal,
// complete, asyncifyMaxBytes, hash }. moduleMs is the module factory (compiling
// and instantiating the wasm); startupMs runs from before the factory to the
// first input wait, so it includes moduleMs; mainStartupMs is callMain to
// the first wait. complete is true when every command was fed and the run
// ended normally (commands ran out, or the game exited after the last). asyncifyMaxBytes is the most of the Asyncify
// buffer any one unwind used (async build only; see glk_web.c).
// Timing uses performance.now(): a turn is the time from one glk_select
// wait to the next, which includes the unwind and rewind under ASYNCIFY.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [build, storyPath, walkPath, ...rest] = process.argv.slice(2);
if (!["async", "sync"].includes(build) || !storyPath || !walkPath) {
  console.error("usage: run-bench.js async|sync STORY WALK [--transcript FILE]");
  process.exit(2);
}
const tIdx = rest.indexOf("--transcript");
const transcriptPath = tIdx >= 0 ? rest[tIdx + 1] : null;
const eIdx = rest.indexOf("--engine");
const engine = eIdx >= 0 ? rest[eIdx + 1] : "git";
if (!["git", "tads2", "tads3"].includes(engine)) {
  console.error(`run-bench.js: unknown engine ${engine}`);
  process.exit(2);
}

const commands = fs.readFileSync(walkPath, "utf8").split(/\r?\n/)
  .filter((l) => l.trim() !== "" && !l.startsWith("#"));

// Pin the clock git seeds its RNG from (time(NULL) -> Date.now()).
const FIXED_NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
Date.now = () => FIXED_NOW;

const createModule = require(path.join(__dirname, "..", "dist", "bench", `${engine}-${build}.js`));

const texts = new Map(); // window id -> text
let lastGrid = "";
const inputs = [];
let nextCmd = 0;
const marks = [];
let tModule = 0; // before the module factory
let moduleMs = null;
let t0 = 0;      // callMain
let finished = false;
let asyncifyMax = 0; // most bytes of the Asyncify buffer one unwind used

function report(reason) {
  if (finished) return;
  finished = true;
  const per = [];
  for (let i = 1; i < marks.length; i++) per.push(marks[i] - marks[i - 1]);
  const all = [...texts.values()].join("\n---\n");
  if (transcriptPath) fs.writeFileSync(transcriptPath, all + "\n--- grid ---\n" + lastGrid);
  const out = {
    engine,
    build,
    reason,
    turns: per.length,
    moduleMs,
    startupMs: marks.length ? marks[0] - tModule : null,
    mainStartupMs: marks.length ? marks[0] - t0 : null,
    totalMs: marks.length ? marks[marks.length - 1] - tModule : null,
    turnsMs: per.reduce((a, b) => a + b, 0),
    perTurnMs: per,
    commandsUsed: nextCmd,
    commandsTotal: commands.length,
    complete: nextCmd === commands.length && (reason === "walkthrough done" || reason === "game exited"),
    asyncifyMaxBytes: build === "async" ? asyncifyMax : null,
    hash: crypto.createHash("sha256").update(all).digest("hex").slice(0, 16),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

const glkWeb = {
  metrics: () => [800, 600, 9, 18, 9, 24, 4, 2, 16, 8],
  layout() {},
  text(id, s, clear) {
    // Drop the style markers (0x01 + style letter).
    const plain = s.replace(/\x01./g, "");
    // A clear is kept as a marker, so the transcript holds the whole game.
    texts.set(id, (texts.get(id) || "") + (clear ? "\n[clear]\n" : "") + plain);
  },
  grid(id, cols, rows, ch) {
    let s = "";
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) s += String.fromCodePoint(ch[r * cols + c] || 32);
      s += "\n";
    }
    lastGrid = s;
  },
  inputsBegin() { inputs.length = 0; },
  input(id, kind) { inputs.push({ id, kind }); },
  wait(timeoutMs) {
    marks.push(performance.now());
    const line = inputs.find((i) => i.kind === 1);
    const ch = inputs.find((i) => i.kind === 2);
    let ev;
    if (line) {
      if (nextCmd >= commands.length) {
        report("walkthrough done");
        process.exit(0);
      }
      ev = { type: 3, win: line.id, text: commands[nextCmd++] };
    } else if (ch) {
      ev = { type: 2, win: ch.id, val1: 32 };
    } else if (timeoutMs >= 0) {
      ev = { type: 1 };
    } else {
      report("no input requested");
      process.exit(1);
    }
    return build === "async" ? Promise.resolve(ev) : ev;
  },
  cancelLine: () => "",
  cancelChar() {},
  pollArrange: () => false,
  loadFile() {},
  persistFile() {},
  deleteFile() {},
  setStory() {},
  exit() { report("game exited"); },
  asyncifyUsed(n) { if (n > asyncifyMax) asyncifyMax = n; },
};

(async () => {
  const story = fs.readFileSync(storyPath);
  tModule = performance.now();
  const Module = await createModule({
    glkWeb,
    print: (t) => process.stderr.write(`[${engine}] ${t}\n`),
    printErr: (t) => process.stderr.write(`[${engine}] ${t}\n`),
  });
  moduleMs = performance.now() - tModule;
  Module.FS.mkdir("/games");
  const name = path.basename(storyPath);
  Module.FS.writeFile(`/games/${name}`, story);
  t0 = performance.now();
  try {
    Module.callMain([`/games/${name}`]);
  } catch (e) {
    if (!(e && e.name === "ExitStatus")) throw e;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
