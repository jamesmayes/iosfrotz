#!/usr/bin/env node
// web/bench/check-flags.js: a flag change, then going back, must rebuild
// every object built with the other flags, even after an interrupted build
// (web/Makefile, "Compile flags of the objects").
//
//   node bench/check-flags.js '<WEB_CFLAGS for B>'   (make check runs it)
//
// Works on two small objects that WEB_CFLAGS compiles, tads/tads_text.o and
// tads/tads_web.o, with the current flags as A and the argument as B. An
// interrupted build is two states, made here without a signal. Each is
// run both ways: A, then B, back to A; and B, then A, back to B.
//
// 1. The regression, which runs against any shape of the Makefile: an
//    object compiled with B before the build stopped
//    (make WEB_CFLAGS=B dist/obj/tads/tads_text.o). Before going back, the
//    object and its record (if the Makefile writes records) are set to one
//    identical second, 60 s ahead of the clock, and the check asserts that
//    they are. So when the rebuild rewrites the record, the new record is
//    not newer than the object as make first saw it, whatever second the
//    rebuild runs in: the case where both fall in the same whole second,
//    which GNU make 3.81 cannot tell apart. Back on A, make -n must compile
//    the object, building must compile it, and then nothing is left.
// 2. Needs the per-object records (dist/obj/<object>.o.flags), and is
//    skipped, with the reason, on a Makefile without them: an object whose
//    record was rewritten for B, but that was not compiled yet
//    (make WEB_CFLAGS=B dist/obj/tads/tads_web.o.flags). Rewriting the
//    record must remove the object; back on A, it is compiled, and then
//    nothing is left.
//
// Last, the two objects and their records are put back as they were
// (contents and mtimes), so the outputs that link them are not out of date
// after make check. Each make run inherits the caller's command-line
// variables (MAKEFLAGS), so A is whatever make check was run with. Exits 1
// if any check fails.

"use strict";

const { spawnSync } = require("child_process");
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
// How far ahead of the clock part 1 sets the object and its record.
const AHEAD = 60;

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
  const r = spawnSync("make", [...vars, ...args], { cwd: WEB, env, encoding: "utf8" });
  // make warns about the mtimes part 1 sets ahead of the clock; those
  // warnings are expected, anything else on stderr is shown.
  const err = r.stderr
    .split("\n")
    .filter((l) => l && !/modification time .* in the future|Clock skew detected/.test(l));
  if (err.length) process.stderr.write(err.join("\n") + "\n");
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`make ${[...vars, ...args].join(" ")} exited ${r.status}`);
  return r.stdout;
}
const compiles = (out) => [...out.matchAll(/ -c \S+ -o (\S+\.o)\b/g)].map((m) => m[1]);
const willCompile = (flags) =>
  compiles(make(flags, ["-n", ...OUTPUTS])).filter((o) => o === TEXT || o === TWEB);
const exists = (f) => fs.existsSync(path.join(WEB, f));
const second = (f) => Math.floor(fs.statSync(path.join(WEB, f)).mtimeMs / 1000);

// 1. The object compiled with the other flags, in the same second.
function compiledWithOther(a, b, label) {
  make(a, [TEXT, TWEB]);
  check(willCompile(a).length === 0, `${label}: nothing to compile to start with`);
  make(b, [TEXT]);
  const pinned = [TEXT, `${TEXT}.flags`].filter(exists);
  const t = Math.floor(Date.now() / 1000) + AHEAD;
  for (const f of pinned) fs.utimesSync(path.join(WEB, f), t, t);
  check(
    exists(TEXT) && pinned.every((f) => second(f) === t) && t > Date.now() / 1000,
    `${label}: the object compiled with the other flags is there, and it${pinned.length > 1 ? " and its record share" : " has"} one second, later than the clock`
  );
  const n = willCompile(a);
  check(n.includes(TEXT), `${label}: back on the first flags, the object compiled with the other flags is compiled again`);
  const did = compiles(make(a, [TEXT]));
  check(did.includes(TEXT), `${label}: and building compiles it`);
  check(willCompile(a).length === 0, `${label}: then nothing is left to compile`);
}

// 2. The record rewritten, its object not compiled yet.
function recordRewritten(a, b, label) {
  make(a, [TEXT, TWEB]);
  check(willCompile(a).length === 0, `${label}: nothing to compile to start with`);
  make(b, [`${TWEB}.flags`]);
  check(!exists(TWEB), `${label}: rewriting a record removes its object`);
  check(willCompile(a).includes(TWEB), `${label}: back on the first flags, the object whose record was rewritten is compiled`);
  const did = compiles(make(a, [TWEB]));
  check(did.includes(TWEB), `${label}: and building compiles it`);
  check(willCompile(a).length === 0, `${label}: then nothing is left to compile`);
}

// The files as they are, to put back.
const A = null;
make(A, [TEXT, TWEB]);
// Records are there if the object depends on its record: with the record
// taken as new (-W), make -n compiles the object. A record left by another
// tree, that this Makefile does not use, does not count.
const records =
  exists(`${TEXT}.flags`) &&
  compiles(make(A, ["-n", "-W", `${TEXT}.flags`, TEXT])).includes(TEXT);
const FILES = [TEXT, `${TEXT}.flags`, TWEB, `${TWEB}.flags`].filter(exists);
const saved = FILES.map((f) => {
  const p = path.join(WEB, f);
  return { p, data: fs.readFileSync(p), st: fs.statSync(p) };
});
try {
  // A to B and back; then B to A and back (B is the starting state).
  compiledWithOther(A, B, "A, B for one object, A");
  compiledWithOther(B, A, "B, A for one object, B");
  if (records) {
    recordRewritten(A, B, "A, B record before its object, A");
    recordRewritten(B, A, "B, A record before its object, B");
  } else {
    console.log("skip the rewritten-record checks: this Makefile keeps no per-object records (dist/obj/<object>.o.flags)");
  }
} finally {
  for (const { p, data, st } of saved) {
    fs.writeFileSync(p, data);
    fs.utimesSync(p, st.atime, st.mtime);
  }
}
check(willCompile(A).length === 0, "the objects are back as they were, built with A");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
