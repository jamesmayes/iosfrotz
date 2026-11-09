#!/usr/bin/env node
// web/bench/check-malformed.js: git_web.c must refuse damaged story files
// with a message instead of handing them to git.
//
//   make bench && node bench/check-malformed.js
//
// Builds small Blorb files around the Glulx game inside
// ../git/test/Alabaster.gblorb (FORM IFRS, an RIdx with one Exec entry, the
// GLUL chunk), damages them in the ways a hostile or truncated file would,
// and runs each through the plain Node build of git (dist/bench/git-sync.js)
// in a fresh instance. A damaged file passes if the game exits with
// git_web.c's message in the story window and never reaches input; the
// undamaged controls pass if they reach their first input request. Exits 1
// if any case fails.

"use strict";

const fs = require("fs");
const path = require("path");

const createGit = require(path.join(__dirname, "..", "dist", "bench", "git-sync.js"));

const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const put32 = (b, i, v) => { b[i] = v >>> 24; b[i + 1] = (v >>> 16) & 255; b[i + 2] = (v >>> 8) & 255; b[i + 3] = v & 255; };
const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const ascii = (s) => Buffer.from(s, "latin1");
const u32 = (v) => { const b = Buffer.alloc(4); put32(b, 0, v); return b; };

// The GLUL chunk's payload in Alabaster.gblorb.
function glulxImage() {
  const b = fs.readFileSync(path.join(__dirname, "..", "..", "git", "test", "Alabaster.gblorb"));
  for (let pos = 12; pos + 8 <= b.length;) {
    const size = be32(b, pos + 4);
    if (tag(b, pos) === "GLUL") return b.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  throw new Error("no GLUL chunk in Alabaster.gblorb");
}

// FORM IFRS { RIdx (count, Exec 0 -> GLUL), GLUL }. Offsets: FORM 0,
// RIdx chunk 12, GLUL chunk 12 + 8 + 16 = 36.
function blorb(glul, ridxPayload) {
  const ridx = ridxPayload || Buffer.concat([u32(1), ascii("Exec"), u32(0), u32(36)]);
  const pad = (b) => (b.length & 1 ? Buffer.concat([b, Buffer.alloc(1)]) : b);
  const chunk = (id, body) => pad(Buffer.concat([ascii(id), u32(body.length), body]));
  const body = Buffer.concat([ascii("IFRS"), chunk("RIdx", ridx), chunk("GLUL", glul)]);
  return Buffer.concat([ascii("FORM"), u32(body.length), body]);
}

const image = glulxImage();
const good = blorb(image);
const GLUL_AT = 12 + 8 + 16;

const cases = [];
const add = (name, bytes, expect) => cases.push({ name, bytes, expect });

add("valid Blorb (control)", good, "input");
add("bare Glulx image (control)", image, "input");

// 1. Truncated FORM: the file ends halfway through the GLUL chunk.
add("truncated FORM", good.subarray(0, good.length >> 1), /claims more bytes/);

// 2. Oversized GLUL: the chunk claims 1 MB more than the file has, with the
//    FORM length raised to match, so gi_blorb.c's own walk would accept it
//    and git would copy the declared length out of a short image.
{
  const b = Buffer.from(good);
  put32(b, GLUL_AT + 4, be32(b, GLUL_AT + 4) + 0x100000);
  put32(b, 4, be32(b, 4) + 0x100000);
  add("oversized GLUL (FORM raised too)", b, /claims more bytes/);
}
{
  const b = Buffer.from(good);
  put32(b, GLUL_AT + 4, 0xfffffff0); // wraps 32-bit position arithmetic
  add("oversized GLUL (size near 4 GB)", b, /claims more bytes/);
}

// 3. Short RIdx: two bytes of payload, too few for the count.
add("short RIdx", blorb(image, Buffer.from([0, 1])), /claims more bytes/);
// ... and a count whose entries do not fit (count * 12 overflows 32 bits).
add("RIdx count too large", blorb(image, Buffer.concat([u32(0x15555556), ascii("Exec"), u32(0), u32(36)])),
  /claims more bytes/);

// A Glulx header whose memory map is larger than the image.
{
  const b = Buffer.from(image.subarray(0, 4096));
  add("bare Glulx with EXTSTART past the end", b, /header does not match/);
}

async function run(c) {
  let out = "";
  let reachedInput = false;
  const glkWeb = {
    metrics: () => [800, 600, 9, 18, 9, 24, 4, 2, 16, 8],
    layout() {},
    text(id, s) { out += s.replace(/\x01./g, ""); },
    grid() {},
    inputsBegin() {},
    input() {},
    wait() { reachedInput = true; throw new Error("STOP"); },
    cancelLine: () => "",
    cancelChar() {},
    pollArrange: () => false,
    loadFile() {},
    persistFile() {},
    deleteFile() {},
    setStory() {},
    exit() {},
  };
  const Module = await createGit({ glkWeb, print() {}, printErr() {} });
  Module.FS.mkdir("/games");
  Module.FS.writeFile("/games/story.gblorb", c.bytes);
  try {
    Module.callMain(["/games/story.gblorb"]);
  } catch (e) {
    if (!(e && (e.name === "ExitStatus" || e.message === "STOP"))) return { ok: false, why: String(e) };
  }
  if (c.expect === "input")
    return reachedInput ? { ok: true } : { ok: false, why: `did not reach input: ${out.trim()}` };
  if (reachedInput) return { ok: false, why: "reached input" };
  return c.expect.test(out) ? { ok: true, why: out.trim() } : { ok: false, why: `message was: ${out.trim()}` };
}

(async () => {
  let failed = 0;
  for (const c of cases) {
    const r = await run(c);
    if (!r.ok) failed++;
    console.log(`${r.ok ? "ok  " : "FAIL"} ${c.name}${r.why ? ` — ${r.why}` : ""}`);
  }
  console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
