#!/usr/bin/env node
// web/bench/check-page.js: checks of the page side of the Glulx client
// (glk.js on a small fake DOM) and of web/saves.js across tabs (two save
// sessions on one small fake IndexedDB, each with its own fake MEMFS).
//
//   node bench/check-page.js   (part of `make check`; needs no build)
//
// Covered: no path hands an input method's uncommitted (preedit) text to a
// char or line request, including a wait that starts after a timer or an
// Arrange event ended the previous one; a line limit lowered under a pending
// request trims the bar; cancelling a char request during a composition, or
// a blur, leaves the next request able to take keys; a file deleted in another tab is removed from a
// tab's clean MEMFS copy (tombstone, or no record at all), while a copy with
// changes this tab could not store is kept and flagged. Exits 1 if any
// check fails.

"use strict";

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const WEB = path.join(__dirname, "..");
const Saves = require(path.join(WEB, "saves.js"));

let failed = 0;
let total = 0;
const ok = (c, what) => {
  total++;
  console.log(`${c ? "ok  " : "FAIL"} ${what}`);
  if (!c) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

// ---- fake DOM, enough for glk.js ----

class El {
  constructor(tag, id) {
    this.tag = tag; this.id = id; this.children = []; this.parent = null;
    this.dataset = {}; this.style = {}; this.listeners = {}; this._text = "";
    this.value = ""; this.className = ""; this.attrs = {}; this.open = false;
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0]; }
  set textContent(t) { this.children = []; this._text = t; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  appendChild(c) {
    if (c.tag === "#frag") { for (const k of c.children) this.appendChild(k); c.children = []; return c; }
    c.parent = this; this.children.push(c); return c;
  }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t, ev = {}) {
    ev.target = ev.target || this;
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    for (const f of this.listeners[t] || []) f(ev);
    return ev;
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  matches() { return true; }
  focus() {}
  setSelectionRange() {}
  showModal() { this.open = true; }
  getBoundingClientRect() { return { width: 450, height: 20 }; }
  get clientWidth() { return this.id === "glk-root" ? rootWidth : 800; }
  get clientHeight() { return 600; }
  closest() { let e = this; while (e) { if (e.className.includes("glk-win")) return e; e = e.parent; } return null; }
}

let rootWidth = 800;
const ids = {};
for (const id of ["glk-root", "command-form", "command", "saves-button", "saves-dialog", "saves-list",
  "import-save", "import-note", "picker", "story-list", "open-story", "stories-button", "story-title",
  "picker-status"])
  ids[id] = new El("div", id);
const windowListeners = {};
const document = {
  getElementById: (id) => ids[id],
  createElement: (t) => new El(t),
  createDocumentFragment: () => new El("#frag"),
  documentElement: { style: { setProperty() {} } },
  body: new El("body"),
  title: "",
};
let glkWeb = null;
const ctx = {
  document, console, setTimeout, clearTimeout, Promise, Uint8Array, URL, Blob: class {},
  navigator: {},
  window: {
    addEventListener: (t, f) => { (windowListeners[t] = windowListeners[t] || []).push(f); },
    getSelection: () => ({ toString: () => "" }),
    indexedDB: null,
    innerHeight: 600,
  },
  location: { hash: "#story=x", pathname: "/glulx.html", search: "", reload() {}, replace() {} },
  history: { replaceState() {} },
  fetch: async (u) => (u.endsWith(".json")
    ? { ok: true, json: async () => [{ file: "x.ulx", title: "X", author: "A" }] }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
  WebFrotzSaves: Saves,
  createGit: async (opts) => {
    glkWeb = opts.glkWeb;
    return { FS: { mkdir() {}, writeFile() {}, readdir: () => [], stat() { throw new Error("no"); } }, callMain() {} };
  },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(WEB, "glk.js"), "utf8"), ctx);

const input = ids.command;
const form = ids["command-form"];

// Resolves to the event, or "pending" if the wait has not ended by then.
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => "pending")]);

async function pageChecks() {
  for (let i = 0; i < 20 && !glkWeb; i++) await tick();
  ok(!!glkWeb, "page started a (fake) game");
  glkWeb.layout([1, 3, 0, 0, 800, 500, 2, 4, 0, 500, 800, 100], 2);
  glkWeb.metrics(); // the page records its size, for the resize check

  // 1. A timer ends a char wait during a composition: the next wait must
  //    not take the preedit text; the committed text answers it.
  glkWeb.inputsBegin();
  glkWeb.input(2, 2, null, 0, []);
  let p = glkWeb.wait(5);
  input.fire("compositionstart", {});
  input.value = "e"; // preedit
  input.fire("input", { isComposing: true });
  let ev = await p;
  ok(ev.type === 1, "a timer ends the char wait during a composition");
  glkWeb.inputsBegin();
  glkWeb.input(2, 2, null, 0, []);
  p = glkWeb.wait(-1);
  ok((await within(p, 20)) === "pending" && input.value === "e",
    "the next char wait does not take the preedit text");
  input.value = "é";
  input.fire("compositionend", {});
  ev = await p;
  ok(ev.type === 2 && ev.val1 === 0xe9, "the committed text answers the char request");

  // 2. The same after an Arrange event (the page was resized).
  glkWeb.inputsBegin();
  glkWeb.input(2, 2, null, 0, []);
  p = glkWeb.wait(-1);
  input.fire("compositionstart", {});
  input.value = "k";
  input.fire("input", { isComposing: true });
  rootWidth = 700;
  for (const f of windowListeners.resize || []) f();
  ev = await within(p, 400);
  ok(ev && ev.type === 5, "a resize ends the char wait during a composition");
  glkWeb.metrics();
  glkWeb.inputsBegin();
  glkWeb.input(2, 2, null, 0, []);
  p = glkWeb.wait(-1);
  ok((await within(p, 20)) === "pending", "after Arrange the preedit text is not taken either");
  input.value = "ka";
  input.fire("compositionend", {});
  ev = await p;
  ok(ev.type === 2 && ev.val1 === 0x6b && input.value === "a",
    "the committed text answers it; the rest is kept");
  input.value = "";

  // 3. Return during a composition commits it; it does not submit a line.
  glkWeb.inputsBegin();
  glkWeb.input(1, 1, "", 20, []);
  p = glkWeb.wait(-1);
  input.fire("compositionstart", {});
  input.value = "nihon";
  form.fire("submit");
  input.fire("keydown", { key: "Enter", isComposing: false });
  ok((await within(p, 20)) === "pending", "a submit during a composition is ignored");
  input.value = "日本";
  input.fire("compositionend", {});
  form.fire("submit");
  ev = await p;
  ok(ev.type === 3 && ev.text === "日本", "after compositionend the line is submitted");

  // 4. A line limit lowered under a pending request (a grid narrowed by a
  //    resize) trims what is in the bar.
  glkWeb.inputsBegin();
  glkWeb.input(3, 1, "", 5, []);
  p = glkWeb.wait(-1);
  input.value = "abcde";
  input.fire("input", {});
  glkWeb.inputsBegin();
  glkWeb.input(3, 1, null, 2, []);
  ok(input.value === "ab", "a lowered line limit trims the bar");
  form.fire("submit");
  ev = await p;
  ok(ev.type === 3 && ev.text === "ab", "the line respects the new limit");

  // 5. The game cancels a char request during a composition that never
  //    gets a compositionend: the next request must still take keys.
  glkWeb.inputsBegin();
  glkWeb.input(2, 2, null, 0, []);
  p = glkWeb.wait(5);
  input.fire("compositionstart", {});
  input.value = "x"; // preedit
  input.fire("input", { isComposing: true });
  ev = await p;
  glkWeb.cancelChar(2);
  ok(ev.type === 1 && input.value === "", "cancelling a char request drops its preedit text");
  glkWeb.inputsBegin();
  glkWeb.input(2, 2, null, 0, []);
  p = glkWeb.wait(-1);
  input.fire("keydown", { key: "q" });
  ev = await within(p, 20);
  ok(ev && ev.type === 2 && ev.val1 === 0x71, "a new char request after the cancel receives keys");

  // 6. A composition that never ends recovers on blur.
  glkWeb.inputsBegin();
  glkWeb.input(2, 2, null, 0, []);
  p = glkWeb.wait(-1);
  input.fire("compositionstart", {});
  input.value = "y";
  input.fire("input", { isComposing: true });
  input.fire("keydown", { key: "z" });
  ok((await within(p, 20)) === "pending", "keys are held during a composition");
  input.fire("blur", {});
  input.value = "";
  input.fire("keydown", { key: "z" });
  ev = await within(p, 20);
  ok(ev && ev.type === 2 && ev.val1 === 0x7a, "after a blur the char request receives keys");
}

// ---- saves.js across tabs ----

// Serial, commit-at-end fake IndexedDB: enough for saves.js.
function fakeIDB() {
  const data = { saves: new Map(), meta: new Map() };
  const idb = {
    data,
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            const staged = [];
            const tx = {
              listeners: {},
              addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
              abort() { this.aborted = true; staged.length = 0; setTimeout(() => tx.onabort && tx.onabort(), 0); },
            };
            let pendingReqs = 0;
            const done = () => setTimeout(() => {
              if (tx.aborted || pendingReqs || tx.finished) return;
              tx.finished = true;
              for (const f of staged) f();
              if (tx.oncomplete) tx.oncomplete();
              for (const f of tx.listeners.complete || []) f();
            }, 0);
            const request = (fn) => {
              const rq = {};
              pendingReqs++;
              setTimeout(() => { rq.result = fn(); if (rq.onsuccess) rq.onsuccess(); pendingReqs--; done(); }, 0);
              return rq;
            };
            tx.objectStore = (name) => ({
              get: (k) => request(() => data[name].get(k)),
              put: (v, k) => { staged.push(() => data[name].set(k, v)); },
              delete: (k) => { staged.push(() => data[name].delete(k)); },
              openCursor() {
                const entries = [...data[name].entries()];
                let i = 0;
                const rq = {};
                pendingReqs++;
                const step = () => setTimeout(() => {
                  if (i < entries.length) {
                    const [key, value] = entries[i];
                    rq.result = { key, value, continue: () => { i++; step(); } };
                  } else { rq.result = null; pendingReqs--; }
                  if (rq.onsuccess) rq.onsuccess();
                  if (!rq.result) done();
                }, 0);
                step();
                return rq;
              },
            });
            return tx;
          },
        };
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
  return idb;
}

// A flat in-memory file system with the FS calls saves.js makes.
function fakeFS() {
  const files = new Map(); // path -> { bytes, mtime }
  const FILE = 0o100000;
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    files,
    isFile: (mode) => (mode & FILE) !== 0,
    stat(p) {
      const f = files.get(p);
      if (!f) throw enoent();
      return { mode: FILE | 0o666, mtime: new Date(f.mtime), size: f.bytes.length };
    },
    lstat(p) { return this.stat(p); },
    readFile(p) { const f = files.get(p); if (!f) throw enoent(); return f.bytes; },
    writeFile(p, b) { files.set(p, { bytes: new Uint8Array(b), mtime: Date.now() }); },
    unlink(p) { if (!files.delete(p)) throw enoent(); },
    rename(a, b) { const f = files.get(a); if (!f) throw enoent(); files.delete(a); files.set(b, f); },
    utime(p, a, m) { const f = files.get(p); if (f) f.mtime = m; },
    open(p, flags) {
      if ((flags & 128) && files.has(p)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      files.set(p, { bytes: new Uint8Array(0), mtime: Date.now() });
      return { path: p };
    },
    write(s, b, off, len) { files.get(s.path).bytes = new Uint8Array(b.subarray(off, off + len)); },
    close() {},
    readdir: (d) => [...files.keys()].filter((k) => k.startsWith(d + "/")).map((k) => k.slice(d.length + 1)),
  };
}

function tab(idb) {
  const FS = fakeFS();
  const store = Saves.createSaveStore(idb, { timeoutMs: 2000 });
  const session = Saves.createSaveSession({
    store, fs: () => FS, dir: "/saves", story: () => "x.ulx", locks: null, log: { warn() {} },
  });
  return { FS, store, session };
}

async function saveChecks() {
  const P = "/saves/x.glksave";
  const idb = fakeIDB();
  const A = tab(idb);
  const B = tab(idb);
  await A.session.ready;
  await B.session.ready;

  A.FS.writeFile(P, [1, 2, 3]);
  let r = await A.session.persist(P);
  ok(r.outcome === "persisted", "tab A saves x.glksave (rev 1)");
  ok((await B.session.load(P)) === "copied" && B.FS.files.has(P), "tab B restores it: a clean copy");

  // A deletes it: a tombstone at rev 2.
  A.FS.unlink(P);
  r = await A.session.remove(P);
  ok(r.outcome === "removed", "tab A deletes it");
  ok((await B.session.load(P)) === "deleted" && !B.FS.files.has(P),
    "tab B's clean copy is removed when the tombstone is found");
  ok((await B.session.load(P)) === "none", "... and then the file is simply absent");

  // B saves the name again: no conflict with the deletion it has seen.
  B.FS.writeFile(P, [4]);
  r = await B.session.persist(P);
  ok(r.outcome === "persisted" && idb.data.meta.get("x.glksave").rev === 3,
    "a new save in tab B after the deletion is not a conflict (rev 3)");

  // A copy with changes this tab could not store is kept and flagged.
  const C = tab(idb);
  await C.session.ready;
  ok((await C.session.load(P)) === "copied", "tab C restores rev 3");
  B.FS.writeFile(P, [5]);
  await B.session.persist(P); // rev 4: C's next save conflicts
  C.FS.writeFile(P, [6, 6]);
  r = await C.session.persist(P);
  ok(r.outcome === "conflict", "tab C's own save conflicts and stays in memory");
  B.FS.unlink(P);
  r = await B.session.remove(P);
  ok(r.outcome === "removed", "tab B deletes the file (tombstone rev 5)");
  ok((await C.session.load(P)) === "local" && C.FS.readFile(P)[0] === 6,
    "tab C keeps its unstored copy");
  ok(C.session.attention().some((x) => x.name === "x.glksave"), "... and it stays flagged (badge)");

  // No record at all (storage cleared): a clean copy goes too.
  const D = tab(idb);
  await D.session.ready;
  D.FS.writeFile("/saves/y.glksave", [7]);
  await D.session.persist("/saves/y.glksave");
  const E = tab(idb);
  await E.session.ready;
  ok((await E.session.load("/saves/y.glksave")) === "copied", "tab E restores y.glksave");
  idb.data.saves.delete("y.glksave");
  idb.data.meta.delete("y.glksave");
  ok((await E.session.load("/saves/y.glksave")) === "deleted" && !E.FS.files.has("/saves/y.glksave"),
    "with no record at all the clean copy is removed");
}

(async () => {
  await pageChecks();
  await saveChecks();
  console.log(failed ? `${failed} of ${total} failed` : `all ${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
