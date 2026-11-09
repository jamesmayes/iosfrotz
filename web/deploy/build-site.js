#!/usr/bin/env node
// web/deploy/build-site.js: assemble the static site (`make dist`).
//
//   node deploy/build-site.js [out]   (run from web/; out defaults to dist-site)
//
// Writes exactly what a static host needs:
//
//   index.html             the start page, pointing at the hashed scripts
//   glulx.html             redirect for old Glulx links
//   manifest.webmanifest, icon-512.png
//   assets/<name>.<hash>.<ext>
//                          saves.js, ui.js, main.js, app.js, glk.js and the
//                          two interpreters (frotz.js/.wasm, git.js/.wasm),
//                          each named by the first 10 hex digits of its
//                          SHA-256, so they can be cached for good
//   games/stories.json, the stories it lists, games/LICENSES.md
//
// index.html gets an inline `self.WebFrotzAssets` map from each source path
// to its hashed file; ui.js (asset, locateFile) reads it, so main.js loads
// the hashed interpreter and Emscripten fetches the hashed .wasm. Without
// the map (serving web/ directly) every path is used as it is.
//
// Needs `make` (dist/) first. Exits 1 if a file is missing or index.html no
// longer has a script tag this expects.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WEB = path.join(__dirname, "..");
const OUT = path.resolve(WEB, process.argv[2] || "dist-site");

const HASHED = [
  "saves.js", "ui.js", "main.js", "app.js", "glk.js",
  "dist/frotz.js", "dist/frotz.wasm", "dist/git.js", "dist/git.wasm",
];
// Loaded by index.html itself; the rest are loaded through the asset map.
const PAGE_SCRIPTS = ["saves.js", "ui.js", "main.js"];
const PLAIN = ["glulx.html", "manifest.webmanifest", "icon-512.png", "games/stories.json", "games/LICENSES.md"];

function fail(msg) {
  console.error(`build-site: ${msg}`);
  process.exit(1);
}

function read(rel) {
  const p = path.join(WEB, rel);
  if (!fs.existsSync(p)) fail(`${rel} is missing${rel.startsWith("dist/") ? " (run make first)" : ""}`);
  return fs.readFileSync(p);
}

function write(rel, bytes) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return bytes.length;
}

fs.rmSync(OUT, { recursive: true, force: true });
const written = [];

// Hashed assets.
const map = {};
for (const rel of HASHED) {
  const bytes = read(rel);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const ext = path.extname(rel);
  const name = `assets/${path.basename(rel, ext)}.${hash}${ext}`;
  map[rel] = name;
  written.push([name, write(name, bytes)]);
}

// The start page.
let html = read("index.html").toString("utf8");
for (const rel of PAGE_SCRIPTS) {
  const tag = `<script src="${rel}"></script>`;
  if (html.split(tag).length !== 2) fail(`index.html must have exactly one ${tag}`);
  html = html.replace(tag, `<script src="${map[rel]}"></script>`);
}
const first = `<script src="${map[PAGE_SCRIPTS[0]]}"></script>`;
html = html.replace(first, `<script>self.WebFrotzAssets = ${JSON.stringify(map)};</script>\n  ${first}`);
written.push(["index.html", write("index.html", Buffer.from(html, "utf8"))]);

// Everything else, under its own name.
for (const rel of PLAIN) written.push([rel, write(rel, read(rel))]);

// The bundled stories: exactly those the catalogue lists.
let stories;
try {
  stories = JSON.parse(read("games/stories.json").toString("utf8"));
} catch (e) {
  fail(`games/stories.json: ${e.message}`);
}
for (const s of stories) {
  if (!s.file || s.file.includes("/") || !["zcode", "glulx"].includes(s.format))
    fail(`games/stories.json: bad entry ${JSON.stringify(s)}`);
  written.push([`games/${s.file}`, write(`games/${s.file}`, read(`games/${s.file}`))]);
}

let total = 0;
for (const [name, n] of written) {
  total += n;
  console.log(`${String(n).padStart(9)}  ${name}`);
}
console.log(`${String(total).padStart(9)}  total, ${written.length} files in ${path.relative(WEB, OUT) || OUT}/`);
