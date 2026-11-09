// web/bench/safari-check.js: the checks that need a real Safari, run
// unattended. `make safari-check` (from web/) builds the site (make dist) and
// runs this; it writes bench/last-safari-check.md.
//
//   node bench/safari-check.js [--port N] [--only zcode,glulx,tads2,tads3,persistence]
//                              [--dry-run] [--no-lock-check] [--serve-only]
//
// How it drives Safari. A small server in this process serves dist-site/
// (the deployable bundle) on 127.0.0.1, and at serve time:
//   - injects a control script into index.html (not in the repo's pages):
//     it polls /__cmd?t=<tab> for JavaScript to run, posts results, page
//     errors, unhandled rejections, console.warn and pagehide/pageshow to
//     /__log, and records startup timings;
//   - adds the test stories to games/stories.json: errand.gam (TADS 2) and
//     belfry.t3 (TADS 3) from bench/tads, Alabaster.gblorb from git/test,
//     and inputeventtest.ulx from bench/local/ if it is there (Plotkin's
//     glk-dev unit test; not shipped: without it the char-input and timer
//     checks FAIL as not run).
// Safari only opens and closes windows, through AppleScript (`make new
// document`, `close`). Input goes through the page's own form
// (requestSubmit) and synthetic keydown events on the command field; no
// keystrokes are sent, so this needs neither Accessibility nor Screen
// Recording, nor Safari's "Allow JavaScript from Apple Events". It needs
// the Automation permission for the terminal to control Safari (macOS asks
// once), and an unlocked screen: a hidden page gets its timers and storage
// held back, which is what invalidated earlier runs.
//
// Fails fast (exit 2, the report left untouched) when the screen is locked,
// Safari does not answer AppleScript, or the page does not report in. An
// abort after the checks have started prints the reason and the checks not
// run, writes the report marked INCOMPLETE, and exits 2. Otherwise exit 0
// only when every required check ran and passed (the report's verdict is
// PASS); 1 if any check failed or did not run (a missing fixture, a missing
// startup timing, a group that stopped part way, or --only leaving groups
// out).

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const WEB = path.resolve(__dirname, "..");
const REPO = path.resolve(WEB, "..");
const SITE = path.join(WEB, "dist-site");
const REPORT = path.join(__dirname, "last-safari-check.md");

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argVal("--port", 8790));
const ONLY = argVal("--only", "") ? argVal("--only", "").split(",") : null;
const DRY = args.includes("--dry-run"); // start the server and the preflight, then stop
// Testing this script only: skip the lock check, to see the later fail-fast
// paths. A run with it on a locked screen proves nothing about the page.
const NO_LOCK_CHECK = args.includes("--no-lock-check");
// Serve the instrumented site and wait, without Safari (to look by hand).
const SERVE_ONLY = args.includes("--serve-only");
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---- test stories added to the catalogue ----

const EXTRA = [
  { file: "errand.gam", title: "The Keeper's Errand", author: "test game (TADS 2)", format: "tads2",
    src: path.join(WEB, "bench/tads/errand.gam") },
  { file: "belfry.t3", title: "The Silent Belfry", author: "test game (TADS 3)", format: "tads3",
    src: path.join(WEB, "bench/tads/belfry.t3") },
  { file: "Alabaster.gblorb", title: "Alabaster", author: "git/test", format: "glulx",
    src: path.join(REPO, "git/test/Alabaster.gblorb") },
  { file: "inputeventtest.ulx", title: "InputEventTest", author: "glk-dev (local)", format: "glulx",
    src: path.join(WEB, "bench/local/inputeventtest.ulx") },
].filter((s) => fs.existsSync(s.src));
const hasStory = (f) => EXTRA.some((s) => s.file === f);

// ---- the script injected into the page ----

// Runs before saves.js: timings, IndexedDB helpers, the open gate the
// queued-grant steal check needs, and the command poll.
const PRE = String.raw`(function () {
  const T = new URLSearchParams(location.search).get("t") || "_";
  const post = (o) => { o.t = T; o.at = Date.now(); const b = JSON.stringify(o);
    if (!navigator.sendBeacon("/__log", b)) fetch("/__log", { method: "POST", body: b, keepalive: true }); };
  const mode = () => { try { return saves.mode(); } catch (e) { return null; } };
  addEventListener("error", (e) => post({ error: String(e.message) }));
  addEventListener("unhandledrejection", (e) => post({ rejection: String(e.reason) }));
  const w = console.warn.bind(console);
  console.warn = (...a) => { post({ warn: a.map((x) => typeof x === "string" ? x : String(x)).join(" ") }); w(...a); };
  addEventListener("pagehide", (e) => post({ ev: "pagehide", persisted: e.persisted, mode: mode() }));
  addEventListener("pageshow", (e) => post({ ev: "pageshow", persisted: e.persisted, mode: mode() }));

  // Startup timings, in ms since navigation start.
  const tm = window.__timing = {};
  const W = WebAssembly;
  for (const k of ["instantiate", "instantiateStreaming"]) {
    const real = W[k];
    if (!real) continue;
    W[k] = function (...a) {
      if (tm.wasmStart == null) tm.wasmStart = performance.now();
      return real.apply(this, a).then((r) => { if (tm.wasmReady == null) tm.wasmReady = performance.now(); return r; });
    };
  }
  const textNow = () => {
    const z = document.getElementById("transcript"), g = document.getElementById("glk-root");
    return ((z && z.textContent) || "") + ((g && g.textContent) || "");
  };
  new MutationObserver(() => {
    if (tm.firstText == null && textNow().trim()) tm.firstText = performance.now();
    const c = document.getElementById("command");
    if (tm.firstText != null && tm.inputReady == null && c && !c.disabled && />\s*$/.test(textNow()))
      tm.inputReady = performance.now();
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });

  // __gateOpens() defers every indexedDB.open until __openOpens().
  const ro = IDBFactory.prototype.open;
  let gated = null;
  IDBFactory.prototype.open = function (...a) {
    if (!gated) return ro.apply(this, a);
    const self = this, fake = { result: null, error: null };
    gated.push(() => {
      const r = ro.apply(self, a);
      for (const ev of ["upgradeneeded", "success", "error", "blocked"])
        r["on" + ev] = () => { try { fake.result = r.result; } catch (e) {} fake.error = r.error; if (fake["on" + ev]) fake["on" + ev](); };
    });
    window.__gatedCount = (window.__gatedCount || 0) + 1;
    return fake;
  };
  window.__gateOpens = () => { gated = []; window.__gatedCount = 0; return "gated"; };
  window.__openOpens = () => { const g = gated || []; gated = null; g.forEach((f) => f()); return "opened " + g.length; };
  // The stored saves: per name, the meta record (rev, size, sha256,
  // deleted) and the stored bytes' length and FNV-1a hash (from the "saves"
  // store, so a byte change shows even if meta were stale).
  const fnv = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
  // Any failure to read resolves { error }, never an empty result.
  window.__idb = () => new Promise(async (res) => {
    if (!indexedDB.databases) { res({ error: "indexedDB.databases() is missing" }); return; }
    let list;
    try { list = await indexedDB.databases(); } catch (e) { res({ error: "indexedDB.databases() failed: " + e }); return; }
    if (!list.some((d) => d.name === "web-frotz")) { res({}); return; }
    let r;
    try { r = ro.call(indexedDB, "web-frotz", 1); } catch (e) { res({ error: "open threw: " + e }); return; }
    r.onsuccess = () => { const db = r.result; const out = {};
      if (!db.objectStoreNames.contains("meta") || !db.objectStoreNames.contains("saves")) { db.close(); res({}); return; }
      let tx;
      try { tx = db.transaction(["meta", "saves"], "readonly"); } catch (e) { db.close(); res({ error: "transaction threw: " + e }); return; }
      tx.onerror = () => res({ error: "read failed: " + tx.error });
      tx.onabort = () => { db.close(); res({ error: "read aborted: " + tx.error }); };
      const c = tx.objectStore("meta").openCursor();
      c.onsuccess = () => { const k = c.result; if (!k) return;
        out[k.key] = Object.assign(out[k.key] || {}, { rev: k.value.rev, size: k.value.size, sha256: k.value.sha256 || null, deleted: !!k.value.deleted }); k.continue(); };
      const b = tx.objectStore("saves").openCursor();
      b.onsuccess = () => { const k = b.result; if (!k) return;
        const by = k.value && k.value.bytes ? new Uint8Array(k.value.bytes) : null;
        out[k.key] = Object.assign(out[k.key] || {}, { bytes: by ? by.length : null, fnv: by ? fnv(by) : null }); k.continue(); };
      tx.oncomplete = () => { db.close(); res(out); };
    };
    r.onerror = () => res({ error: "open failed: " + r.error });
    r.onblocked = () => res({ error: "open blocked" });
  });
  // Every change of saves.mode(), from __watchMode() on: polled every 5 ms,
  // and every change of the Saves button's state attributes (set by each
  // mode change, delivered even for a state that lasts no time at all).
  window.__watchMode = () => {
    const log = window.__modeLog = [];
    let last = mode();
    log.push({ at: Date.now(), mode: last, via: "start" });
    clearInterval(window.__modeTimer);
    window.__modeTimer = setInterval(() => { const m = mode(); if (m !== last) { last = m; log.push({ at: Date.now(), mode: m, via: "poll" }); } }, 5);
    if (window.__modeObs) window.__modeObs.disconnect();
    const btn = document.getElementById("saves-button");
    window.__modeObs = new MutationObserver((rs) => { for (const r of rs) log.push({ at: Date.now(), attr: r.attributeName, old: r.oldValue, now: btn.getAttribute(r.attributeName), mode: mode(), via: "button" }); });
    if (btn) window.__modeObs.observe(btn, { attributes: true, attributeOldValue: true, attributeFilter: ["aria-label", "data-warning"] });
    return log.length;
  };
  // This page's Web Locks client id: hold a uniquely named lock and find it
  // in navigator.locks.query().
  window.__clientId = () => new Promise((res) => {
    if (window.__cid) return res(window.__cid);
    const name = "safari-check-id-" + T + "-" + Math.random();
    navigator.locks.request(name, async () => {
      const q = await navigator.locks.query();
      const h = q.held.find((l) => l.name === name);
      window.__cid = h ? h.clientId : null;
      res(window.__cid);
    }).catch((e) => res("query failed " + e));
  });
  // The save lock's queue, as navigator.locks.query() reports it.
  window.__locks = async () => {
    const q = await navigator.locks.query();
    const f = (l) => ({ mode: l.mode, clientId: l.clientId });
    return { held: q.held.filter((l) => l.name === "webfrotz-saves").map(f),
      pending: q.pending.filter((l) => l.name === "webfrotz-saves").map(f) };
  };
  window.__wipe = () => new Promise((res) => {
    const r = indexedDB.deleteDatabase("web-frotz");
    r.onsuccess = () => res("wiped"); r.onerror = () => res("wipe failed " + r.error); r.onblocked = () => res("wipe blocked");
  });

  // Page text and input.
  const text = () => {
    const z = document.getElementById("transcript");
    if (document.body.dataset.format === "zcode") return z.innerText;
    return [...document.querySelectorAll(".glk-buffer")].map((e) => e.innerText).join("\n");
  };
  const statusText = () => document.body.dataset.format === "zcode" ?
    document.getElementById("status").innerText :
    [...document.querySelectorAll(".glk-grid")].map((e) => e.innerText).join("\n");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Wait until the text has grown past len and ends at a prompt, unchanged
  // for 300 ms. Resolves { ok, tail }.
  async function settle(len, ms) {
    const end = Date.now() + ms;
    let last = null, since = 0;
    for (;;) {
      const t = text();
      const done = t.length > len && />\s*$/.test(t);
      if (done && t === last) { if (Date.now() - since >= 300) return { ok: true, tail: t.slice(Math.max(len - 40, 0)).slice(-1500), reply: t.slice(len).slice(-4000) }; }
      else { last = t; since = Date.now(); }
      if (Date.now() > end) return { ok: false, tail: t.slice(-800) };
      await sleep(50);
    }
  }
  window.__T = {
    text, status: statusText, mode, settle,
    visible: () => document.visibilityState,
    ready: () => { const c = document.getElementById("command"); return !!c && !c.disabled && />\s*$/.test(text()); },
    async waitReady(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (window.__T.ready()) { await sleep(300); return { ok: true, tail: text().slice(-1500) }; } await sleep(100); }
      return { ok: false, tail: text().slice(-800) };
    },
    async cmd(line, ms) {
      const len = text().length;
      const i = document.getElementById("command");
      i.value = line;
      document.getElementById("command-form").requestSubmit();
      return settle(len, ms || 15000);
    },
    // Submit a line that makes the game ask for a key: resolves once the
    // input bar waits for a key (command-form data-waiting="key", set by
    // app.js and glk.js), not at a ">" prompt.
    async submitForKey(line, ms) {
      const f = document.getElementById("command-form");
      document.getElementById("command").value = line;
      f.requestSubmit();
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (f.dataset.waiting === "key") { await sleep(100); return { ok: true, tail: text().slice(-800) }; }
        await sleep(50);
      }
      return { ok: false, waiting: f.dataset.waiting, tail: text().slice(-800) };
    },
    async key(k, ms) {
      const len = text().length;
      const i = document.getElementById("command");
      i.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      return settle(len, ms || 15000);
    },
    async savesList() {
      document.getElementById("saves-button").click();
      await sleep(800);
      const d = document.getElementById("saves-dialog");
      const r = { open: d.open, list: document.getElementById("saves-list").innerText,
        note: (document.getElementById("import-note") || {}).innerText || "" };
      d.close();
      return r;
    },
    // A save this tab holds itself: dirty (not known to be stored) and its
    // size in MEMFS (null when there is no such file). Z-code page only.
    localSave(name) {
      let size = null;
      try { size = Module.FS.stat("/saves/" + name).size; } catch (e) {}
      return { dirty: saves.isDirty(name), size };
    },
    timing() {
      const res = performance.getEntriesByType("resource")
        .filter((e) => /\.(wasm|js)(\?|$)/.test(e.name) && /assets\//.test(e.name))
        .map((e) => ({ name: e.name.replace(/^.*assets\//, ""), end: Math.round(e.responseEnd), size: e.encodedBodySize || e.transferSize || 0 }));
      const r = (v) => v == null ? null : Math.round(v);
      return { resources: res, wasmStart: r(tm.wasmStart), wasmReady: r(tm.wasmReady),
        firstText: r(tm.firstText), inputReady: r(tm.inputReady) };
    },
    steal() {
      return new Promise((res) => {
        navigator.locks.request("webfrotz-saves", { mode: "exclusive", steal: true }, () => {
          res("stolen");
          return new Promise((done) => { window.__releaseSteal = done; });
        }).catch((e) => res("steal failed " + e));
      });
    },
    unsteal() { if (window.__releaseSteal) { window.__releaseSteal(); window.__releaseSteal = null; return "released"; } return "nothing held"; },
  };

  async function poll() {
    try {
      const t = await (await fetch("/__cmd?t=" + encodeURIComponent(T))).text();
      if (t) {
        const c = JSON.parse(t);
        let result;
        try { result = await (0, eval)(c.eval); } catch (e) { result = { __err: String(e && e.stack || e) }; }
        post({ id: c.id, result: result === undefined ? null : result });
      }
    } catch (e) {}
    setTimeout(poll, 150);
  }
  post({ hello: navigator.userAgent, href: location.href, visible: document.visibilityState });
  poll();
})();`;

const BLANK = `<!doctype html><meta charset="utf-8"><title>safari-check</title>` +
  `<body><p>safari-check control page</p><script src="/__pre.js"></script></body>`;

// ---- the server ----

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".md": "text/markdown; charset=utf-8" };
const queues = new Map(); // tab -> [command]
const waiters = new Map(); // command id -> resolve
const hellos = []; // { t, href, visible, ua, n }
const events = []; // page errors, warnings, lifecycle
let helloWaiters = [];

function serve(req, res) {
  const u = new URL(req.url, ORIGIN);
  const send = (code, body, type) => {
    res.writeHead(code, { "Content-Type": type || "text/plain", "Cache-Control": "no-store" });
    res.end(body);
  };
  if (req.method === "POST" && u.pathname === "/__log") {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      res.writeHead(204); res.end();
      let d;
      try { d = JSON.parse(b); } catch (e) { return; }
      if (d.id && waiters.has(d.id)) { const w = waiters.get(d.id); waiters.delete(d.id); w(d.result); return; }
      if (d.hello) {
        hellos.push({ t: d.t, href: d.href, visible: d.visible, ua: d.hello });
        const ws = helloWaiters; helloWaiters = [];
        ws.forEach((f) => f());
        return;
      }
      events.push(d);
    });
    return;
  }
  if (u.pathname === "/__cmd") {
    const q = queues.get(u.searchParams.get("t")) || [];
    return send(200, q.length ? JSON.stringify(q.shift()) : "", "application/json");
  }
  if (u.pathname === "/__pre.js") return send(200, PRE, "text/javascript");
  if (u.pathname === "/__blank.html") return send(200, BLANK, TYPES[".html"]);
  if (u.pathname === "/" || u.pathname === "/index.html") {
    let html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
    // Before the page's first script, so the hooks are in place first.
    html = html.replace(/<script/, '<script src="/__pre.js"></script><script');
    return send(200, html, TYPES[".html"]);
  }
  if (u.pathname === "/games/stories.json") {
    const base = JSON.parse(fs.readFileSync(path.join(SITE, "games/stories.json"), "utf8"));
    return send(200, JSON.stringify(base.concat(EXTRA.map(({ src, ...s }) => s))), TYPES[".json"]);
  }
  const extra = EXTRA.find((s) => u.pathname === `/games/${s.file}`);
  const file = extra ? extra.src : path.join(SITE, path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, ""));
  if (!file.startsWith(SITE) && !extra) return send(403, "no");
  fs.readFile(file, (err, data) => {
    if (err) return send(404, "not found");
    send(200, data, TYPES[path.extname(file)] || "application/octet-stream");
  });
}

// ---- driving tabs ----

let seq = 0;
function run(tab, js, ms = 30000) {
  const id = `c${++seq}`;
  if (!queues.has(tab)) queues.set(tab, []);
  queues.get(tab).push({ id, eval: js });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`tab ${tab} did not answer within ${ms / 1000} s: ${js.slice(0, 60)}`)); }, ms);
    waiters.set(id, (r) => {
      clearTimeout(timer);
      if (r && r.__err) reject(new Error(`in tab ${tab}: ${r.__err}`)); else resolve(r);
    });
  });
}
const helloCount = (tab) => hellos.filter((h) => h.t === tab).length;
function waitHello(tab, after, ms) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const check = () => {
      const hs = hellos.filter((h) => h.t === tab);
      if (hs.length > after) return resolve(hs[hs.length - 1]);
      if (Date.now() > end) return reject(new Error(`tab ${tab} did not load within ${ms / 1000} s`));
      helloWaiters.push(check);
      setTimeout(check, 500);
    };
    check();
  });
}
// Navigate a tab; resolves with its new hello once the page is up.
async function go(tab, url, ms = 30000) {
  const n = helloCount(tab);
  // A change of hash alone is not a new page, so reload in that case.
  await run(tab, `setTimeout(() => { const u = new URL(${JSON.stringify(url)}, location.href);
    const same = u.pathname + u.search === location.pathname + location.search;
    location.href = u.href; if (same) location.reload(); }, 50), "going"`, 10000);
  return waitHello(tab, n, ms);
}
async function reload(tab, ms = 30000) {
  const n = helloCount(tab);
  await run(tab, `setTimeout(() => location.reload(), 50), "reloading"`, 10000);
  return waitHello(tab, n, ms);
}
const storyUrl = (tab, stem) => `/index.html?t=${tab}#story=${stem}`;

// Asynchronous, so the server keeps answering while osascript runs.
let safariAnswers = false; // set once AppleScript has worked
function osa(script, ms = 15000) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { encoding: "utf8", timeout: ms }, (err, out, errOut) => {
      if (!err) { safariAnswers = true; return resolve((out || "").trim()); }
      reject(new Error(err.killed ? `Safari did not answer AppleScript within ${ms / 1000} s` :
        `osascript: ${(errOut || err.message).trim()}`));
    });
  });
}
// Side by side, so neither window covers the other: WebKit treats a fully
// covered window as hidden and throttles it.
const BOUNDS = { A: "{0, 30, 700, 860}", B: "{710, 30, 1410, 860}" };
const openWindow = (tab) => osa(`tell application "Safari"
  activate
  make new document with properties {URL:"${ORIGIN}/__blank.html?t=${tab}"}
  try
    set bounds of front window to ${BOUNDS[tab] || BOUNDS.A}
  end try
end tell`);
function closeOurWindows() {
  if (!safariAnswers) return Promise.resolve();
  return osa(`tell application "Safari"
  repeat with w in (every window)
    try
      if URL of current tab of w starts with "${ORIGIN}" then close w
    end try
  end repeat
end tell`, 5000).catch(() => { /* best effort */ });
}

// ---- preflight ----

function screenLocked() {
  try {
    const out = execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" });
    return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out);
  } catch (e) { return null; }
}
// Stop now (exit 2), saying why and which checks did not run. Once the
// checks have started, the report is written too, marked incomplete.
let aborting = false;
function abort(msg) {
  if (aborting) return new Promise(() => {});
  aborting = true;
  console.error(`safari-check: ABORTED: ${msg}`);
  const unrun = unrunChecks();
  console.error(`safari-check: not run or not finished: ${unrun.length ? unrun.join(", ") : "none"}`);
  if (runInfo.startedAt) {
    try { writeReport(msg); } catch (e) { console.error(`safari-check: could not write the report: ${e.message}`); }
    console.error("The checks run so far are in bench/last-safari-check.md, marked INCOMPLETE.");
  } else {
    console.error("Nothing was checked; bench/last-safari-check.md is unchanged.");
  }
  closeOurWindows().finally(() => process.exit(2));
  return new Promise(() => {}); // `await abort(...)` stops the caller here
}

// ---- checks ----

const results = []; // { group, name, status, obs }
// Every check group a release needs, in order; "timings" is checked after
// the others, from the timings they recorded. A group counts as run only if
// it finished without throwing.
const GROUPS = ["zcode", "glulx", "tads2", "tads3", "persistence", "timings"];
const selected = () => GROUPS.filter((g) => !ONLY || ONLY.includes(g) || (g === "timings" && ONLY.some((o) => TIMED[o])));
const finished = new Set();
const runInfo = { ua: null, startedAt: null };
const unrunChecks = () => selected().filter((g) => !finished.has(g)).concat(ONLY ? GROUPS.filter((g) => !selected().includes(g)).map((g) => `${g} (left out by --only)`) : []);
let current = "";
function rec(name, status, obs) {
  results.push({ group: current, name, status, obs });
  console.log(`${status.padEnd(4)} ${current} / ${name}: ${obs}`);
}
const pass = (n, o) => rec(n, "PASS", o);
const fail = (n, o) => rec(n, "FAIL", o);
const clip = (s, n = 160) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(-n);
const timings = []; // { interp, story, t }
const cmd = (tab, line, ms = 20000) => run(tab, `__T.cmd(${JSON.stringify(line)}, ${ms})`, ms + 5000);

async function start(tab, stem, interp, story) {
  await go(tab, storyUrl(tab, stem));
  const r = await run(tab, "__T.waitReady(60000)", 65000);
  const t = await run(tab, "__T.timing()");
  if (interp) timings.push({ interp, story, t });
  return r;
}
const status = (tab) => run(tab, "__T.status()");
const idb = (tab) => run(tab, "__idb()");
// Read the stored saves; a failed read is a FAIL record of its own (and the
// result still carries the error, so no comparison can use it).
async function readIdb(tab, label) {
  const db = await idb(tab);
  if (!db || db.error) fail(`IndexedDB read (${label})`, `tab ${tab}: ${db ? db.error : "no answer"}`);
  return db || { error: "no answer" };
}
// One stored save, as read: ok only when the read succeeded and the record
// exists, is not deleted, and has its revision, bytes and byte fingerprint.
function storedSave(db, name) {
  if (!db || db.error) return { ok: false, rec: null, text: `READ FAILED (${db ? db.error : "no answer"})` };
  const r = db[name];
  if (!r) return { ok: false, rec: null, text: `NO STORED ${name}` };
  if (r.deleted || r.rev == null || !r.bytes || !r.fnv) return { ok: false, rec: r, text: `INCOMPLETE ${JSON.stringify(r)}` };
  return { ok: true, rec: r, text: JSON.stringify(r) };
}
// "Unchanged" only between two good reads of an established stored save.
function sameStored(dbBefore, dbAfter, name) {
  const a = storedSave(dbBefore, name), b = storedSave(dbAfter, name);
  if (!a.ok) return { ok: false, text: `not compared: before, ${a.text}` };
  if (!b.ok) return { ok: false, text: `not compared: after, ${b.text}` };
  const same = JSON.stringify(a.rec) === JSON.stringify(b.rec);
  return { ok: same, text: `${b.text}${same ? " (unchanged)" : ` (CHANGED from ${a.text})`}` };
}

// The game state, observed: the whole status line (not clipped) and the
// replies to LOOK and INVENTORY. Taking it costs turns, so it is taken at
// the same point each time: right after SAVE, right after the reload, and
// right after RESTORE; the status line is read before the probes.
const PROBES = ["look", "inventory"];
const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
async function observe(tab) {
  const st = norm(await status(tab));
  const replies = [];
  let ok = true, why = null;
  for (const c of PROBES) {
    const t = await cmd(tab, c);
    if (!t.ok && !why) why = `${c.toUpperCase()} reached no prompt: "${clip(t.tail, 80)}"`;
    ok = ok && t.ok;
    replies.push(norm(t.ok ? t.reply : `(no prompt) ${t.tail}`));
  }
  return { ok, why, st, replies, key: JSON.stringify([st, replies]) };
}
const firstDiff = (a, b) => {
  for (let i = 0; i < Math.max(a.replies.length, b.replies.length); i++)
    if (a.replies[i] !== b.replies[i]) return `${PROBES[i]}: "${clip(a.replies[i], 70)}" vs "${clip(b.replies[i], 70)}"`;
  return a.st !== b.st ? `status "${clip(a.st, 70)}" vs "${clip(b.st, 70)}"` : "none";
};

// SAVE, reload, RESTORE. The restore check passes only if the state after
// RESTORE equals the state after SAVE (status line and probe replies), and
// that state differs from the restarted story's, so equality shows that
// RESTORE brought the save back and not that nothing changed. All three
// observations must succeed: a failed one is a FAIL of its own and is never
// compared (its timeout text could otherwise make the states differ).
async function saveReloadRestore(tab, saveName, savedRe, restoredRe) {
  const s = await cmd(tab, "save");
  const ok1 = s.ok && savedRe.test(s.tail);
  const db1 = await readIdb(tab, "after SAVE");
  const stored = storedSave(db1, saveName);
  (ok1 && stored.ok ? pass : fail)("save", `reply "${clip(s.tail, 60)}"; IndexedDB ${saveName}: ${stored.text}`);
  const probed = (when, o) => { if (!o.ok) fail(`observe ${when}`, `failed, so not compared: ${o.why}`); return o; };
  const o1 = probed("after SAVE", await observe(tab));
  await reload(tab);
  const r0 = await run(tab, "__T.waitReady(60000)", 65000);
  (r0.ok ? pass : fail)("reload", r0.ok ? `story restarted; status "${clip(await status(tab), 80)}"` : `no prompt after reload: "${clip(r0.tail)}"`);
  const o0 = probed("after the reload", await observe(tab));
  const r = await cmd(tab, "restore");
  const ok2 = r.ok && restoredRe.test(r.tail);
  const o2 = probed("after RESTORE", await observe(tab));
  if (!(o1.ok && o0.ok && o2.ok)) {
    const bad = [["after SAVE", o1], ["after the reload", o0], ["after RESTORE", o2]].filter(([, o]) => !o.ok).map(([w]) => w);
    fail("restore", `reply "${clip(r.tail, 60)}"; not compared: the observation ${bad.join(", ")} failed (see its line)`);
    return { o1, o2 };
  }
  const same = o2.key === o1.key;
  const distinct = o0.key !== o1.key;
  (ok2 && same && distinct ? pass : fail)("restore",
    `reply "${clip(r.tail, 60)}"; state after RESTORE ${same ? "equals" : "DIFFERS from"} the state after SAVE` +
    `${same ? "" : ` (first difference ${firstDiff(o1, o2)})`}; saved state ${distinct ? "differs from" : "is INDISTINGUISHABLE from"} the restarted story` +
    `; status after save "${clip(o1.st, 80)}", after restore "${clip(o2.st, 80)}"; probes: ${PROBES.join(", ")}`);
  return { o1, o2 };
}

// The interpreter each group times, and the columns every timing must have.
const TIMED = { zcode: "Z-code", glulx: "Glulx", tads2: "TADS 2", tads3: "TADS 3" };
const ENGINE = { "Z-code": "frotz", Glulx: "git", "TADS 2": "tads2", "TADS 3": "tads3" };
function timingCells(interp, t) {
  const res = (re) => { const e = t.resources.find((x) => re.test(x.name)); return e ? `${e.end} (${Math.round(e.size / 1024)} KB)` : null; };
  const k = ENGINE[interp];
  return { js: res(new RegExp(`^${k}\\..*\\.js$`)), wasm: res(new RegExp(`^${k}\\..*\\.wasm$`)),
    wasmReady: t.wasmReady, firstText: t.firstText, inputReady: t.inputReady };
}
// Each selected interpreter must have a complete timing row.
function checkTimings() {
  current = "Startup timings";
  for (const [g, interp] of Object.entries(TIMED)) {
    if (!selected().includes(g)) continue;
    const row = timings.find((x) => x.interp === interp);
    if (!row) { fail(interp, "no timing recorded (the story never started)"); continue; }
    const c = timingCells(interp, row.t);
    const missing = Object.keys(c).filter((k) => c[k] == null);
    (missing.length ? fail : pass)(interp, missing.length ? `missing: ${missing.join(", ")}` :
      `js ${c.js}, wasm ${c.wasm}, instantiated ${c.wasmReady}, first text ${c.firstText}, input ${c.inputReady} ms`);
  }
}

const CHECKS = {
  async zcode() {
    current = "Z-code (Balances)";
    const r = await start("A", "Balances", "Z-code", "Balances");
    if (!r.ok) return fail("start", `no prompt: "${clip(r.tail)}"`);
    pass("start", `prompt after "${clip(r.tail, 80)}"`);
    for (const c of ["look", "inventory", "examine furniture"]) {
      const t = await cmd("A", c);
      (t.ok ? pass : fail)(`turn: ${c}`, `"${clip(t.tail, 100)}"; status "${clip(await status("A"), 60)}"`);
    }
    await saveReloadRestore("A", "Balances.sav", /Ok\./, /Ok\./);
  },

  async glulx() {
    current = "Glulx";
    let r = await start("A", "glulxercise", "Glulx", "Glulxercise");
    (r.ok && /glulxercise/i.test(r.tail) ? pass : fail)("start (Glulxercise)", `"${clip(r.tail, 100)}"`);
    if (!hasStory("inputeventtest.ulx")) {
      fail("char input", "not run: bench/local/inputeventtest.ulx is missing (erkyrath/glk-dev, not shipped; a required fixture)");
      fail("timer", "not run: needs bench/local/inputeventtest.ulx");
    } else {
      r = await start("A", "inputeventtest", null, null);
      if (!r.ok) fail("start (InputEventTest)", `no prompt: "${clip(r.tail)}"`);
      // "get char" asks for a key, so wait for the bar to take one (not
      // for a ">" prompt), then send it.
      const charTest = async (name, key, re) => {
        const g = await run("A", `__T.submitForKey("get char", 10000)`, 15000);
        if (!g.ok) return fail(name, `not run: "get char" never asked for a key (data-waiting "${g.waiting || ""}"): "${clip(g.tail, 80)}"`);
        const k = await run("A", `__T.key(${JSON.stringify(key)}, 10000)`, 15000);
        (k.ok && re.test(k.tail) ? pass : fail)(name, `"${clip(k.tail, 80)}"${k.ok ? "" : " (no prompt after the key)"}`);
      };
      await charTest("char input: q", "q", /dec\) 113/);
      await charTest("char input: Left", "ArrowLeft", /FFFFFFFE/);
      const t0 = Date.now();
      const t = await cmd("A", "get timer", 15000);
      const dt = Date.now() - t0;
      (/timer event/.test(t.tail) && /Done/.test(t.tail) ? pass : fail)("timer", `"${clip(t.tail, 80)}" after ${dt} ms (game waits 2 s)`);
    }
    if (!hasStory("Alabaster.gblorb")) return fail("save/reload/restore", "not run: git/test/Alabaster.gblorb is missing (a required fixture)");
    current = "Glulx (Alabaster)";
    r = await start("A", "Alabaster", null, null);
    if (!r.ok) return fail("start", `no prompt: "${clip(r.tail)}"`);
    pass("start", `"${clip(r.tail, 80)}"`);
    for (const c of ["cut hart", "ask Snow White about what she was doing"]) {
      const t = await cmd("A", c);
      (t.ok ? pass : fail)(`turn: ${c}`, `"${clip(t.tail, 80)}"`);
    }
    await saveReloadRestore("A", "Alabaster.glksave", /Ok\./, /Ok\./);
  },

  async tads2() { await tads("TADS 2", "errand", "errand.gam", "bench/tads/errand.walk", /Saved/, /Restored|restored/); },
  async tads3() { await tads("TADS 3", "belfry", "belfry.t3", "bench/tads/belfry.walk", /Saved/, /Restored/); },

  async persistence() {
    current = "Persistence (two tabs)";
    // A: writer. B: reader, queued.
    let r = await start("A", "Balances", null, null);
    if (!r.ok) return fail("tab A start", clip(r.tail));
    const mA = await run("A", "__T.mode()");
    (mA === "writer" ? pass : fail)("tab A owns storage", `A mode ${mA}`);
    // The stored save the "unchanged" checks below compare against: A, the
    // writer, stores it here, so it exists whatever ran before.
    const s0 = await cmd("A", "save");
    const db0 = await readIdb("A", "A's save");
    const stored0 = storedSave(db0, "Balances.sav");
    (s0.ok && /Ok\./.test(s0.reply) && stored0.ok ? pass : fail)("tab A stores a save",
      `reply "${clip(s0.tail, 60)}"; stored Balances.sav ${stored0.text}`);
    await openWindow("B");
    const hB = await waitHello("B", 0, 20000);
    if (hB.visible !== "visible") return fail("tab B opens", `tab B reports visibilityState "${hB.visible}"`);
    r = await start("B", "Balances", null, null);
    const mB = await run("B", "__T.mode()");
    const notOwner = await run("B", "__T.text().includes(WebFrotzSaves.NOT_OWNER)");
    (mB === "reader" && notOwner ? pass : fail)("tab B is session-only", `B mode ${mB}; NOT_OWNER notice ${notOwner ? "shown" : "missing"}`);
    // B's SAVE must succeed in the game, be held in B (MEMFS, dirty), say
    // it is session-only, and leave the stored record (meta and bytes) as
    // it was.
    const before = await readIdb("B", "before B's save");
    const sB = await cmd("B", "save");
    const after = await readIdb("B", "after B's save");
    const localB = await run("B", `__T.localSave("Balances.sav")`);
    const savedB = sB.ok && /Ok\./.test(sB.reply);
    const sessionB = sB.ok && sB.reply.includes(await run("B", "WebFrotzSaves.NOT_OWNER"));
    const unchanged = sameStored(before, after, "Balances.sav");
    (savedB && localB.dirty && localB.size > 0 && sessionB && unchanged.ok ? pass : fail)("B's save stays in the tab",
      `reply "${clip(sB.tail, 80)}" (${savedB ? "game saved" : "NO SUCCESS REPLY"}); in tab: ${localB.size == null ? "NO FILE" : `${localB.size} bytes`}, ` +
      `${localB.dirty ? "not in storage" : "NOT MARKED LOCAL"}; NOT_OWNER on the save ${sessionB ? "shown" : "MISSING"}; ` +
      `stored Balances.sav ${unchanged.text}`);
    // Takeover: A leaves, B gets the lock.
    await go("A", "/__blank.html?t=A");
    let mB2 = null;
    for (let i = 0; i < 40 && mB2 !== "writer"; i++) { await new Promise((z) => setTimeout(z, 250)); mB2 = await run("B", "__T.mode()"); }
    const nowOwner = await run("B", "__T.text().includes(WebFrotzSaves.NOW_OWNER)");
    (mB2 === "writer" && nowOwner ? pass : fail)("takeover when A closes", `B mode ${mB2}; NOW_OWNER notice ${nowOwner ? "shown" : "missing"}`);
    const s2 = await cmd("B", "save");
    const db2 = await readIdb("B", "after B's stored save");
    const sv1 = storedSave(after, "Balances.sav"), sv2 = storedSave(db2, "Balances.sav");
    (sv1.ok && sv2.ok && sv2.rec.rev > sv1.rec.rev ? pass : fail)("B's next save is stored",
      `reply "${clip(s2.tail, 60)}"; ${sv1.ok && sv2.ok ? `rev ${sv1.rec.rev} -> ${sv2.rec.rev}` : `not compared: before ${sv1.text}, after ${sv2.text}`}`);

    // Queued-grant steal: B (writer) leaves; A, now a reader with its
    // IndexedDB opens gated, is granted the lock mid-snapshot; B's page
    // steals it. A must stay session-only and never become the writer: its
    // mode is logged from before the grant (every change, not samples), the
    // lock queue is read from navigator.locks.query() with each page's
    // client id, and A's SAVE after the steal must leave storage alone.
    current = "Persistence (queued-grant steal)";
    r = await start("A", "Balances", null, null);
    const mA2 = await run("A", "__T.mode()");
    if (mA2 !== "reader") return fail("setup", `A should be a reader behind B, is ${mA2}`);
    const cidA = await run("A", "__clientId()");
    const cidB = await run("B", "__clientId()");
    const q0 = await run("A", "__locks()");
    const who = (c) => c === cidA ? "A" : c === cidB ? "B" : `other(${String(c).slice(0, 8)})`;
    const qs = (q) => `held [${q.held.map((l) => who(l.clientId)).join(", ")}], pending [${q.pending.map((l) => who(l.clientId)).join(", ")}]`;
    const queueOk = cidA && cidB && cidA !== cidB && q0.held.length === 1 && q0.held[0].clientId === cidB &&
      q0.pending.length === 1 && q0.pending[0].clientId === cidA;
    (queueOk ? pass : fail)("A waits in the lock queue", `client ids ${cidA ? "A ok" : "A MISSING"}, ${cidB ? "B ok" : "B MISSING"}; ${qs(q0)}`);
    await run("A", "__watchMode()");
    await run("A", "__gateOpens()");
    await go("B", "/__blank.html?t=B");
    const cidB2 = await run("B", "__clientId()"); // B's new page
    const who2 = (c) => c === cidB2 ? "B" : who(c);
    const qs2 = (q) => `held [${q.held.map((l) => who2(l.clientId)).join(", ")}], pending [${q.pending.map((l) => who2(l.clientId)).join(", ")}]`;
    let gatedN = 0;
    for (let i = 0; i < 40 && !gatedN; i++) { await new Promise((z) => setTimeout(z, 250)); gatedN = await run("A", "window.__gatedCount || 0"); }
    if (!gatedN) { await run("A", "__openOpens()"); return fail("grant reaches A", `A's snapshot never opened IndexedDB (mode ${await run("A", "__T.mode()")})`); }
    const q1 = await run("A", "__locks()");
    const granted = q1.held.length === 1 && q1.held[0].clientId === cidA && !q1.pending.some((l) => l.clientId === cidA);
    (granted ? pass : fail)("grant reaches A", `A's snapshot is held at ${gatedN} gated IndexedDB open(s); mode ${await run("A", "__T.mode()")}; ${qs2(q1)}`);
    const st = await run("B", "__T.steal()");
    await new Promise((z) => setTimeout(z, 500));
    await run("A", "__openOpens()");
    await new Promise((z) => setTimeout(z, 2000));
    const q2 = await run("A", "__locks()");
    const mA3 = await run("A", "__T.mode()");
    // The mode does not change (reader throughout), so the page prints no
    // notice; the session's own notice is what changes.
    const lost = await run("A", "saves.notice() === WebFrotzSaves.LOST_OWNER");
    const now = await run("A", "__T.text().includes(WebFrotzSaves.NOW_OWNER)");
    const thiefHolds = q2.held.length === 1 && q2.held[0].clientId === cidB2;
    const aQueued2 = q2.held.concat(q2.pending).some((l) => l.clientId === cidA);
    (st === "stolen" && mA3 === "reader" && lost && !now && thiefHolds && !aQueued2 ? pass : fail)("stolen grant revokes A",
      `steal: ${st}; A mode ${mA3}; A's notice ${lost ? "LOST_OWNER" : "NOT LOST_OWNER"}; NOW_OWNER ${now ? "SHOWN" : "not shown"}; ${qs2(q2)}`);
    // A's follow-up SAVE, while B holds the stolen lock: the game saves,
    // A keeps it (session-only, LOST_OWNER), storage is unchanged.
    const before2 = await readIdb("A", "before A's save after the steal");
    const sA = await cmd("A", "save");
    const after2 = await readIdb("A", "after A's save after the steal");
    const localA = await run("A", `__T.localSave("Balances.sav")`);
    const savedA = sA.ok && /Ok\./.test(sA.reply);
    const sessionA = sA.ok && sA.reply.includes(await run("A", "WebFrotzSaves.LOST_OWNER"));
    const unchanged2 = sameStored(before2, after2, "Balances.sav");
    (savedA && localA.dirty && localA.size > 0 && sessionA && unchanged2.ok ? pass : fail)("A's save after the steal stays in the tab",
      `reply "${clip(sA.tail, 80)}" (${savedA ? "game saved" : "NO SUCCESS REPLY"}); in tab: ${localA.size == null ? "NO FILE" : `${localA.size} bytes`}, ` +
      `${localA.dirty ? "not in storage" : "NOT MARKED LOCAL"}; LOST_OWNER on the save ${sessionA ? "shown" : "MISSING"}; ` +
      `stored Balances.sav ${unchanged2.text}`);
    await run("B", "__T.unsteal()");
    await new Promise((z) => setTimeout(z, 2000));
    const q3 = await run("A", "__locks()");
    const mA4 = await run("A", "__T.mode()");
    const after3 = await readIdb("A", "after the thief let go");
    const log = await run("A", "window.__modeLog || []");
    // Any mode but reader, or the Saves button's label ever being other
    // than the reader's (a record's oldValue is the label before each set),
    // means A left session-only at some point.
    const modes = log.filter((e) => e.mode).map((e) => e.mode).filter((m, i, a) => i === 0 || m !== a[i - 1]);
    const btn = log.filter((e) => e.via === "button");
    const READER_LABEL = "Saves: another tab owns browser storage";
    const everWriter = modes.some((m) => m !== "reader") || btn.some((e) => e.attr === "aria-label" && e.old !== READER_LABEL);
    const aQueued3 = q3.held.concat(q3.pending).some((l) => l.clientId === cidA);
    const unchanged3 = sameStored(before2, after3, "Balances.sav");
    (mA4 === "reader" && !everWriter && !aQueued3 && unchanged3.ok ? pass : fail)("A never writes and does not queue again",
      `2 s after the thief let go: A mode ${mA4}; ${qs2(q3)}; A's modes from before the grant: ${modes.join(" -> ") || "?"} ` +
      `(${log.length} log entries, ${btn.length} Saves-button changes${everWriter ? ", LEFT SESSION-ONLY" : ""}); stored Balances.sav ${unchanged3.text}`);
  },
};

async function tads(name, stem, file, walk, savedRe, restoredRe) {
  current = name;
  if (!hasStory(file)) return fail("all", `not run: ${file} is missing (a required fixture)`);
  const r = await start("A", stem, name, file);
  if (!r.ok) return fail("start", `no prompt: "${clip(r.tail)}"`);
  pass("start", `"${clip(r.tail, 100)}"`);
  const lines = fs.readFileSync(path.join(WEB, walk), "utf8").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/^(save|restore|undo|quit|restart)\b/i.test(l)).slice(0, 20);
  let ok = 0, bad = null;
  for (const c of lines) {
    const t = await cmd("A", c);
    if (t.ok) ok++; else if (!bad) bad = `${c}: "${clip(t.tail, 80)}"`;
  }
  (ok === lines.length ? pass : fail)("20 turns", `${ok}/${lines.length} commands reached the next prompt${bad ? `; first stall ${bad}` : ""}; status "${clip(await status("A"), 60)}"`);
  await saveReloadRestore("A", `${stem}.glksave`, savedRe, restoredRe);
  const sl = await run("A", "__T.savesList()");
  const listed = sl.open && new RegExp(`${stem}\\.glksave .* in browser storage`).test(sl.list);
  (listed ? pass : fail)("Saves dialog", `open ${sl.open}; list "${clip(sl.list, 120)}"${sl.note ? `; note "${clip(sl.note, 80)}"` : ""}`);
}

// ---- report ----

function gitHead() {
  try { return execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch (e) { return "?"; }
}
function gitDirty() {
  try { return execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", "web"], { encoding: "utf8" }).trim() !== ""; } catch (e) { return false; }
}
// The verdict: PASS only when every required check group ran to the end
// and nothing failed. Returns { pass, text }.
function verdict(aborted) {
  const failed = results.filter((r) => r.status === "FAIL").length;
  const unrun = unrunChecks();
  const why = [];
  if (aborted) why.push(`aborted: ${aborted}`);
  if (failed) why.push(`${failed} check${failed === 1 ? "" : "s"} failed`);
  if (unrun.length) why.push(`not run or not finished: ${unrun.join(", ")}`);
  if (!why.length) return { pass: true, text: "PASS (every required check ran and passed)" };
  return { pass: false, text: `${aborted || unrun.length ? "INCOMPLETE, not release evidence" : "FAIL"}: ${why.join("; ")}` };
}
function writeReport(aborted) {
  const { ua, startedAt } = runInfo;
  const n = (s) => results.filter((r) => r.status === s).length;
  const esc = (s) => String(s).replace(/\|/g, "\\|");
  const v = verdict(aborted);
  const out = [];
  out.push("# Last Safari check", "");
  out.push(`- **Verdict:** ${v.pass ? "**PASS**" : "**NOT PASSED**"}: ${esc(v.text)}`);
  out.push(`- **When:** ${startedAt.toISOString()}`);
  out.push(`- **Commit:** ${gitHead()}${gitDirty() ? " (web/ had uncommitted changes)" : ""}`);
  out.push(`- **Safari:** ${ua || "?"}`);
  out.push(`- **Served:** \`dist-site/\` on ${ORIGIN}, with the test stories: ${EXTRA.map((s) => s.file).join(", ")}`);
  out.push(`- **Checks:** ${n("PASS")} PASS, ${n("FAIL")} FAIL`, "");
  out.push("Written by `make safari-check` (`bench/safari-check.js`); see the web README, \"Develop\".", "");
  out.push("| Check | | Observation |", "|---|---|---|");
  for (const r of results) out.push(`| ${esc(r.group)} / ${esc(r.name)} | **${r.status}** | ${esc(r.obs)} |`);
  out.push("", "## Startup timings", "",
    "Milliseconds from navigation start, first start of each interpreter in this run, served from localhost with `Cache-Control: no-store` (so every asset is fetched).", "",
    "| Interpreter | Story | .js loaded | .wasm loaded | wasm instantiated | first text | ready for input |", "|---|---|---|---|---|---|---|");
  for (const { interp, story, t } of timings) {
    const c = timingCells(interp, t);
    const f = (x) => x == null ? "**missing**" : x;
    out.push(`| ${interp} | ${story} | ${f(c.js)} | ${f(c.wasm)} | ${f(c.wasmReady)} | ${f(c.firstText)} | ${f(c.inputReady)} |`);
  }
  const ev = events.filter((e) => e.error || e.rejection || e.warn);
  out.push("", "## Page errors and warnings", "");
  if (!ev.length) out.push("None.");
  for (const e of ev) out.push(`- tab ${e.t}: ${e.error ? "error" : e.rejection ? "unhandled rejection" : "warn"}: ${esc(clip(e.error || e.rejection || e.warn, 200))}`);
  out.push("");
  fs.writeFileSync(REPORT, out.join("\n"));
  console.log(`\nReport: ${path.relative(process.cwd(), REPORT)} (${n("PASS")} PASS, ${n("FAIL")} FAIL)`);
  console.log(`safari-check: ${v.text}`);
  return v.pass;
}

// ---- main ----

async function main() {
  if (!fs.existsSync(path.join(SITE, "index.html"))) await abort("dist-site/ is missing: run `make dist` first (make safari-check does).");
  if (process.platform !== "darwin") await abort("this check drives Safari on macOS.");
  const server = http.createServer(serve);
  await new Promise((resolve) => {
    server.once("error", (e) => abort(`could not listen on ${ORIGIN}: ${e.message} (use --port N)`));
    server.listen(PORT, "127.0.0.1", resolve);
  });
  console.log(`safari-check: serving dist-site/ on ${ORIGIN}; test stories: ${EXTRA.map((s) => s.file).join(", ")}`);

  const locked = NO_LOCK_CHECK || SERVE_ONLY ? false : screenLocked();
  if (locked) await abort("the screen is locked. Safari holds back timers and storage in a hidden page, so nothing it reports would count. Unlock the Mac and run it again.");
  console.log(`safari-check: screen ${SERVE_ONLY ? "not checked (--serve-only)" : NO_LOCK_CHECK ? "lock check skipped (--no-lock-check)" : locked === null ? "lock state unknown (ioreg failed)" : "unlocked"}`);
  if (SERVE_ONLY) { console.log(`safari-check: --serve-only: open ${ORIGIN}/index.html?t=A; Ctrl-C to stop.`); return; }
  if (DRY) { console.log("safari-check: --dry-run, stopping before Safari."); server.close(); return; }

  try { await openWindow("A"); } catch (e) {
    await abort(`${e.message}. Check that Safari opens, and that the terminal may control it ` +
      "(System Settings > Privacy & Security > Automation).");
  }
  let hello;
  try { hello = await waitHello("A", 0, 20000); } catch (e) {
    await abort(`Safari opened no page from ${ORIGIN} within 20 s (a dialog in Safari, or the server unreachable from Safari).`);
  }
  if (hello.visible !== "visible") await abort(`the page reports visibilityState "${hello.visible}": the screen is locked or Safari is hidden.`);
  await run("A", "__wipe()", 10000).then((w) => console.log(`safari-check: browser storage for ${ORIGIN}: ${w}`));

  runInfo.ua = hello.ua;
  runInfo.startedAt = new Date();
  for (const name of Object.keys(CHECKS)) {
    if (!selected().includes(name)) continue;
    try {
      await CHECKS[name]();
      finished.add(name);
    } catch (e) {
      rec("error", "FAIL", `stopped part way: ${e.message}`);
      if (/did not (answer|load)/.test(e.message)) {
        const v = await run("A", "__T.visible()", 5000).catch(() => "no answer");
        if (v !== "visible" || screenLocked())
          await abort(`Safari stopped answering during ${name} (${e.message}; tab A visibility: ${v}; screen ${screenLocked() ? "locked" : "unlocked"}).`);
      }
    }
  }
  if (selected().includes("timings")) { checkTimings(); finished.add("timings"); }
  const passed = writeReport(null);
  await closeOurWindows();
  server.close();
  process.exit(passed ? 0 : 1);
}

main().catch((e) => abort(`internal error: ${e && e.stack || e}`));
