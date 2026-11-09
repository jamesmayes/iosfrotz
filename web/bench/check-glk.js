#!/usr/bin/env node
// web/bench/check-glk.js: run bench/glk-check.c (built by `make check`)
// against a scripted Module.glkWeb and report its checks. The C side checks
// what the game sees; this side answers its input requests and records what
// reached the page (layout rectangles, input limits, echoed text, waits,
// file calls) for the C side to query through Module.glkCheck.
//
//   make check   (builds dist/bench/glk-check.js and runs this)
//
// Exits 1 if any check fails.

"use strict";

const path = require("path");
const createCheck = require(path.join(__dirname, "..", "dist", "bench", "glk-check.js"));

const rects = new Map(); // window id -> [left, top, width, height]
const counts = new Map();
const bump = (k, n = 1) => counts.set(k, (counts.get(k) || 0) + n);
let mark = "";
let inputs = [];
let lines = [];
let rootWidth = 800; // narrowed and widened by the "shrink"/"grow" marks

const glkCheck = {
  rect: (id) => rects.get(id) || null,
  count: (k) => counts.get(k) || 0,
  mark(m) { mark = m; },
};

const glkWeb = {
  metrics: () => [rootWidth, 600, 9, 18, 9, 24, 6, 2, 16, 8],
  layout(recs, n) {
    rects.clear();
    for (let i = 0; i < n; i++) {
      const r = recs.slice(i * 6, i * 6 + 6);
      rects.set(r[0], [r[2], r[3], r[4], r[5]]);
    }
  },
  text(id, s) {
    const plain = s.replace(/\x01./g, "");
    for (const w of ["xyzzy", "plugh"]) if (plain.includes(w)) bump(`echoed-${w}`);
  },
  grid(id, cols, rows, ch) {
    lines = [];
    for (let r = 0; r < rows; r++) {
      let t = "";
      for (let c = 0; c < cols; c++) t += String.fromCodePoint(ch[r * cols + c] || 32);
      lines.push(t);
    }
    if (lines.length > 1 && lines[0].endsWith("abcde") && lines[1].trim() === "")
      bump("grid-row1-blank");
    if (lines.length > 1 && lines[0].endsWith(" ab") && lines[1].trim() === "")
      bump("grid-echo-ab");
  },
  inputsBegin() { inputs = []; },
  input(id, kind, initial, maxlen) {
    inputs.push({ id, kind, initial, maxlen });
    if (mark.startsWith("grid") && kind === 1) counts.set("grid-maxlen", maxlen);
  },
  wait(ms) {
    bump("wait");
    if (ms === 0) bump("wait0");
    const line = inputs.find((i) => i.kind === 1);
    const ch = inputs.find((i) => i.kind === 2);
    const m = mark;
    if (m === "shrink" || m === "grow") {
      mark = "";
      rootWidth += m === "shrink" ? -27 : 27; // 3 grid columns of 9 px
      return { type: 5 }; // Arrange
    }
    if (line && m) {
      mark = "";
      const text = m.startsWith("grid") ? "abcdefghijklmnopqrst" : m === "echo" ? "xyzzy" : "plugh";
      return { type: 3, win: line.id, text };
    }
    if (ch && m === "timers") {
      mark = "";
      return { type: 2, win: ch.id, val1: 32 };
    }
    if (ms >= 0) return { type: 1 };
    throw new Error(`no answer for a wait (mark "${m}")`);
  },
  cancelLine() { bump("cancelLine"); return ""; },
  cancelChar() {},
  pollArrange: () => false,
  loadFile() {},
  persistFile(p) { bump(`persist:${p}`); },
  deleteFile(p) { bump(`delete:${p}`); },
  setStory() {},
  exit() {},
};

(async () => {
  let out = "";
  const Module = await createCheck({
    glkWeb,
    glkCheck,
    print: (t) => { out += t + "\n"; console.log(t); },
    printErr: (t) => console.error(t),
  });
  let status = 0;
  try {
    status = Module.callMain([]);
  } catch (e) {
    if (!(e && e.name === "ExitStatus")) throw e;
    status = e.status;
  }
  process.exit(status || !/PASSED/.test(out) ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
