#!/usr/bin/env node
// web/bench/check-tads.js: the TADS builds on the browser Glk, in Node.
//
//   node bench/check-tads.js   (part of `make check`; needs make bench-tads)
//
// Runs the plain (non-ASYNCIFY) Node builds dist/bench/tads2-sync.js and
// tads3-sync.js with a scripted Module.glkWeb, on the test games in
// bench/tads, and checks:
//   - each game starts, plays a few commands and shows its status line;
//   - SAVE goes through browser storage: TADS writes the file with stdio
//     (osansi1.c, renamed to web/tads/tads_web.c's wrappers), and the page
//     is asked to load the file before it is opened and to store it after
//     the write-mode close, by its /saves path (<story>.glksave, from the
//     Glk file prompt); the file is the interpreter's own save format;
//   - RESTORE asks the page to load the file before it is read, and works;
//   - a file without the interpreter's signature is refused with a message
//     in the story window.
// Exits 1 if any check fails.

"use strict";

const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..");
let failed = 0;
let total = 0;
const ok = (c, what) => {
  total++;
  console.log(`${c ? "ok  " : "FAIL"} ${what}`);
  if (!c) failed++;
};

// Play `commands` on `story` with the plain build of `engine`. Returns the
// window text, the last status grid, the storage calls in order, the save
// files left in MEMFS, and whether the game exited.
async function play(engine, story, commands) {
  const create = require(path.join(WEB, "dist", "bench", `${engine}-sync.js`));
  const texts = new Map();
  let grid = "";
  const inputs = [];
  const calls = [];
  let next = 0;
  let exited = false;
  let Module = null;
  const glkWeb = {
    metrics: () => [800, 600, 9, 18, 9, 24, 4, 2, 16, 8],
    layout() {},
    text(id, s, clear) {
      texts.set(id, (texts.get(id) || "") + (clear ? "\n" : "") + s.replace(/\x01./g, ""));
    },
    grid(id, cols, rows, ch) {
      let s = "";
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) s += String.fromCodePoint(ch[r * cols + c] || 32);
        s += "\n";
      }
      grid = s;
    },
    inputsBegin() { inputs.length = 0; },
    input(id, kind) { inputs.push({ id, kind }); },
    wait(timeoutMs) {
      const line = inputs.find((i) => i.kind === 1);
      const ch = inputs.find((i) => i.kind === 2);
      if (line && next < commands.length) {
        calls.push(["line", commands[next]]);
        return { type: 3, win: line.id, text: commands[next++] };
      }
      if (ch) return { type: 2, win: ch.id, val1: 32 };
      if (timeoutMs >= 0) return { type: 1 };
      throw new Error("done");
    },
    cancelLine: () => "",
    cancelChar() {},
    pollArrange: () => false,
    loadFile(p) {
      let size = null;
      try { size = Module.FS.stat(p).size; } catch (e) { /* absent */ }
      calls.push(["load", p, size]);
    },
    persistFile(p) {
      let head = "";
      try { head = Buffer.from(Module.FS.readFile(p).slice(0, 16)).toString("latin1"); } catch (e) { /* absent */ }
      calls.push(["persist", p, head]);
    },
    deleteFile(p) { calls.push(["delete", p]); },
    setStory() {},
    exit() { exited = true; },
  };
  Module = await create({ glkWeb, print() {}, printErr() {} });
  Module.FS.mkdir("/games");
  const name = path.basename(story);
  Module.FS.writeFile(`/games/${name}`, fs.readFileSync(story));
  try {
    Module.callMain([`/games/${name}`]);
  } catch (e) {
    if (!(e && (e.name === "ExitStatus" || e.message === "done"))) throw e;
  }
  let saves = [];
  try { saves = Module.FS.readdir("/saves").filter((f) => f !== "." && f !== ".."); } catch (e) { /* none */ }
  return { text: [...texts.values()].join("\n"), grid, calls, saves, exited };
}

// The storage calls for one path between two commands.
const between = (calls, from, to) => {
  const a = calls.findIndex((c) => c[0] === "line" && c[1] === from);
  const b = calls.findIndex((c, i) => i > a && c[0] === "line" && c[1] === to);
  return calls.slice(a + 1, b < 0 ? calls.length : b);
};

async function checkGame(engine, file, sig, setup, label) {
  const story = path.join(WEB, "bench", "tads", file);
  const stem = file.replace(/\..*$/, "");
  const save = `/saves/${stem}.glksave`;
  const cmds = [...setup, "save", "look", "restore", "look"];
  const r = await play(engine, story, cmds);
  ok(r.grid.trim().length > 0, `${label}: the status line is drawn`);
  const atSave = between(r.calls, "save", "look");
  const load = atSave.findIndex((c) => c[0] === "load" && c[1] === save);
  const persist = atSave.findIndex((c) => c[0] === "persist" && c[1] === save);
  ok(load >= 0 && persist > load, `${label}: SAVE loads ${save} before opening it and stores it after closing`);
  ok(persist >= 0 && atSave[persist][2].startsWith(sig),
    `${label}: the stored file is a ${JSON.stringify(sig)} save`);
  ok(atSave.filter((c) => c[0] === "persist").length === 1, `${label}: SAVE stores the file once`);
  const atRestore = between(r.calls, "restore", "look");
  ok(atRestore.some((c) => c[0] === "load" && c[1] === save && c[2] > 0),
    `${label}: RESTORE loads ${save} before reading it`);
  ok(!atRestore.some((c) => c[0] === "persist"), `${label}: RESTORE stores nothing`);
  ok(/Restored/.test(r.text), `${label}: RESTORE succeeds`);
  ok(r.saves.includes(`${stem}.glksave`), `${label}: the save is in MEMFS /saves`);
}

(async () => {
  await checkGame("tads2", "errand.gam", "TADS2 save", ["open drawer", "take key"], "TADS 2");
  await checkGame("tads3", "belfry.t3", "T3-state-v", ["e", "take lantern"], "TADS 3");

  // The wrong file for each interpreter.
  const glulx = path.join(WEB, "games", "glulxercise.ulx");
  for (const [engine, label, what] of [["tads2", "TADS 2", "TADS 2"], ["tads3", "TADS 3", "TADS 3"]]) {
    const r = await play(engine, glulx, []);
    ok(r.text.includes(`This is not a ${what} story file.`) && r.exited,
      `${label}: a Glulx file is refused with a message`);
  }
  const r = await play("tads2", path.join(WEB, "bench", "tads", "belfry.t3"), []);
  ok(r.text.includes("This is not a TADS 2 story file."), "TADS 2: a TADS 3 image is refused");

  console.log(failed ? `${failed} of ${total} FAILED` : `all ${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
