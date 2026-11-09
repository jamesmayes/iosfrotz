#!/usr/bin/env node
// web/bench/asyncify-list.js: turn emcc's -sASYNCIFY_ADVISE output into an
// -sASYNCIFY_ONLY list (make asyncify-lists; README.md, "ASYNCIFY for TADS").
//
//   node bench/asyncify-list.js ADVISE_OUTPUT LIST_FILE HEADER_LINE...
//
// ADVISE_OUTPUT is what emcc printed when linking with -sASYNCIFY_ADVISE.
// Every function it names as one that "can change the state" or "is in the
// add-list" goes into LIST_FILE, one per line, sorted, after the HEADER_LINEs
// (each written as a # comment, which emcc skips). Imports are left out:
// they are not functions of the module.
//
// emcc reads a '.' in an ASYNCIFY list entry as a space (its escape for
// shells), so a name with a '.' in it (a C variadic "...", or a numbered
// duplicate such as "f.1") would never match. Each run of '.' is written as
// the wildcard '*' instead, which still matches that name.

"use strict";

const fs = require("fs");

const [advisePath, listPath, ...header] = process.argv.slice(2);
if (!advisePath || !listPath) {
  console.error("usage: asyncify-list.js ADVISE_OUTPUT LIST_FILE HEADER_LINE...");
  process.exit(2);
}

const names = new Set();
for (const line of fs.readFileSync(advisePath, "utf8").split("\n")) {
  if (/ is an import /.test(line)) continue;
  const m = line.match(/^\[asyncify\] (.+?) (can change the state|is in the add-list)/);
  if (m) names.add(m[1].replace(/\.+/g, "*"));
}
if (names.size === 0) {
  console.error(`asyncify-list.js: no functions in ${advisePath} (was it linked with -sASYNCIFY_ADVISE?)`);
  process.exit(1);
}
const out = header.map((h) => `# ${h}`.trimEnd()).concat([...names].sort());
fs.writeFileSync(listPath, out.join("\n") + "\n");
console.log(`${listPath}: ${names.size} functions`);
