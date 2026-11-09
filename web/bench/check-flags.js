#!/usr/bin/env node
// web/bench/check-flags.js: a flag change, then going back, must rebuild
// every object built with the other flags, even after an interrupted build
// (web/Makefile, "Compile flags of the objects").
//
//   node bench/check-flags.js '<WEB_CFLAGS for B>'   (make check runs it)
//
// Works on two small objects that WEB_CFLAGS compiles, tads/tads_text.o and
// tads/tads_web.o, with the current flags as A and the argument as B. An
// interrupted build is two states, made here without a signal:
//   - an object compiled with B before the build stopped
//     (make WEB_CFLAGS=B dist/obj/tads/tads_text.o);
//   - an object whose record was rewritten for B, but that was not compiled
//     yet (make WEB_CFLAGS=B dist/obj/tads/tads_web.o.flags).
// Then, back on A (in the same second, which GNU make 3.81's whole-second
// mtimes cannot tell apart), make -n must compile both, and once they are
// built, nothing. The same in reverse: starting from B, A for one object,
// back to B. Last, the two objects and their records are put back as they
// were (contents and mtimes), so the outputs that link them are not out of
// date after make check. Each
// make run inherits the caller's command-line variables (MAKEFLAGS), so A
// is whatever make check was run with. Exits 1 if any case fails.

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..");
const B = process.argv[2];
if (!B) {
  console.error("usage: check-flags.js '<WEB_CFLAGS for B>'");
  process.exit(2);
}
const TEXT = "dist/obj/tads/tads_text.o";
const TWEB = "dist/obj/tads/tads_web.o";
// What make -n over the outputs that link them would compile.
const OUTPUTS = ["dist/tads2.js", "dist/tads3.js", "dist/bench/glk-check.js"];

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
}

// make with WEB_CFLAGS set to flags, or as the caller had it if null.
function make(flags, args) {
  const vars = flags === null ? [] : [`WEB_CFLAGS=${flags}`];
  // MAKELEVEL and the jobserver of the make check run must not leak in
  // (a -n or -j there would change these runs).
  const env = { ...process.env };
  delete env.MAKELEVEL;
  delete env.MFLAGS;
  if (env.MAKEFLAGS) {
    // Keep only the command-line variables: they are A.
    const m = env.MAKEFLAGS.match(/(?:^| )-- (.*)$/);
    env.MAKEFLAGS = m ? `-- ${m[1]}` : "";
  }
  return execFileSync("make", [...vars, ...args], { cwd: WEB, env, encoding: "utf8" });
}
const compiles = (out) => [...out.matchAll(/ -c \S+ -o (\S+\.o)\b/g)].map((m) => m[1]);
const willCompile = (flags) =>
  compiles(make(flags, ["-n", ...OUTPUTS])).filter((o) => o === TEXT || o === TWEB);
const exists = (f) => fs.existsSync(path.join(WEB, f));

function interrupted(a, b, label) {
  make(a, [TEXT, TWEB]);
  check(willCompile(a).length === 0, `${label}: nothing to compile to start with`);
  make(b, [TEXT]);
  make(b, [`${TWEB}.flags`]);
  check(!exists(TWEB), `${label}: rewriting a record removes its object`);
  const n = willCompile(a);
  check(n.includes(TEXT), `${label}: back on the first flags, the object compiled with the other flags is compiled again`);
  check(n.includes(TWEB), `${label}: back on the first flags, the object whose record was rewritten is compiled`);
  const did = compiles(make(a, [TEXT, TWEB]));
  check(did.includes(TEXT) && did.includes(TWEB), `${label}: and building compiles both`);
  check(willCompile(a).length === 0, `${label}: then nothing is left to compile`);
}

// The files as they are, to put back.
const A = null;
make(A, [TEXT, TWEB]);
const FILES = [TEXT, `${TEXT}.flags`, TWEB, `${TWEB}.flags`];
const saved = FILES.map((f) => {
  const p = path.join(WEB, f);
  return { p, data: fs.readFileSync(p), st: fs.statSync(p) };
});
try {
  // A to B and back; then B to A and back (B is the starting state).
  interrupted(A, B, "A, B interrupted, A");
  interrupted(B, A, "B, A interrupted, B");
} finally {
  for (const { p, data, st } of saved) {
    fs.writeFileSync(p, data);
    fs.utimesSync(p, st.atime, st.mtime);
  }
}
check(willCompile(A).length === 0, "the objects are back as they were, built with A");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
