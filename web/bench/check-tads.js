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
//     in the story window;
//   - text crosses the port in the game's character set (web/tads/
//     tads_text.c): bench/tads/utf8.t3 (TADS 3, UTF-8) prints non-ASCII
//     text and reports each typed line's characters and code points, a
//     timed line keeps its non-ASCII text when it is resumed, and an
//     over-long line is cut at a whole character; bench/tads/cp1252.gam
//     (TADS 2, Windows-1252) prints its text and gets a typed line back in
//     Windows-1252.
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
  let partial = null;
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
    input(id, kind, initial) {
      inputs.push({ id, kind });
      if (kind === 1 && initial) calls.push(["initial", initial]);
    },
    wait(timeoutMs) {
      const line = inputs.find((i) => i.kind === 1);
      const ch = inputs.find((i) => i.kind === 2);
      // { timer: text }: the timer fires with `text` typed so far.
      const cmd = commands[next];
      if (line && cmd && typeof cmd === "object" && timeoutMs >= 0) {
        next++;
        partial = cmd.timer;
        calls.push(["timer", cmd.timer]);
        // The Glk library returns the timer once it is due (glk_web.c's
        // timer_due), so let the interval pass first.
        const end = Date.now() + timeoutMs + 1;
        while (Date.now() < end) { /* wait */ }
        return { type: 1 };
      }
      if (line && next < commands.length) {
        calls.push(["line", commands[next]]);
        return { type: 3, win: line.id, text: commands[next++] };
      }
      if (ch) return { type: 2, win: ch.id, val1: 32 };
      if (timeoutMs >= 0) return { type: 1 };
      throw new Error("done");
    },
    cancelLine() {
      const t = partial || "";
      partial = null;
      return t;
    },
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

  // Text encoding.
  {
    const long = "é".repeat(300);
    const r = await play("tads3", path.join(WEB, "bench", "tads", "utf8.t3"),
      ["café ☕ 😀", "timed", { timer: "Grüße" }, "Grüße, Welt", long, "a😀".repeat(100), "quit"]);
    ok(r.text.includes("Grüße aus Zürich: café, naïve, Ελληνικά, 日本語, ☕."),
      "TADS 3: UTF-8 output is shown as its characters");
    ok(r.text.includes("Display charset utf-8."), "TADS 3: the game is told the display is UTF-8");
    ok(r.text.includes("got [café ☕ \ufffd] 8: 63 61 66 E9 20 2615 20 FFFD"),
      "TADS 3: a typed non-ASCII line reaches the game as its characters (U+FFFD past U+FFFF)");
    const initial = r.calls.findIndex((c) => c[0] === "initial");
    ok(initial > r.calls.findIndex((c) => c[0] === "timer") && r.calls[initial][1] === "Grüße",
      "TADS 3: a timed line is resumed with its non-ASCII text");
    ok(r.text.includes("timed 2 then 6") && r.text.includes("first [Grüße] 5: 47 72 FC DF 65") &&
       r.text.includes("then [Grüße, Welt] 11: 47 72 FC DF 65 2C 20 57 65 6C 74"),
      "TADS 3: the timed-out and resumed lines reach the game intact");
    const got = [...r.text.matchAll(/got \[(é*)\] (\d+):/g)].filter((m) => m[1].length > 10)[0];
    ok(got && got[1].length === Number(got[2]) && got[1].length === 127,
      `TADS 3: a 300-character "é" line is cut at a whole character (${got ? got[2] : "none"} of 255 bytes)`);
    // "a😀" x 100 reaches the game as "a\ufffd" x 100, 4 bytes a pair: 63
    // pairs and an "a" fill 253 of the 255 bytes.
    const cut = [...r.text.matchAll(/got \[((?:a\ufffd)+a?)\] (\d+):/g)][0];
    ok(cut && cut[1].length === 127 && Number(cut[2]) === 127,
      `TADS 3: a line of 3-byte characters is cut at a whole character (${cut ? cut[2] : "none"} characters)`);
    ok(!/Ã|ߘ/.test(r.text), "TADS 3: nothing is mis-decoded");
  }
  {
    const r = await play("tads2", path.join(WEB, "bench", "tads", "cp1252.gam"), ["café “x”", "quit"]);
    ok(r.text.includes("Café naïve, € 5, “quoted”."), "TADS 2: Windows-1252 output is shown as its characters");
    ok(r.text.includes("got [café “x”] 8 bytes"), "TADS 2: a typed line reaches the game in Windows-1252");
  }

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
