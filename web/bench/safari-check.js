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
//     glk-dev unit test; not shipped, so the char-input and timer checks
//     SKIP without it).
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
// Safari does not answer AppleScript, or the page does not report in.
// Otherwise exit 0 if no check failed, 1 if any did.

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
  window.__idb = () => new Promise(async (res) => {
    const list = indexedDB.databases ? await indexedDB.databases() : [];
    if (!list.some((d) => d.name === "web-frotz")) { res({}); return; }
    const r = ro.call(indexedDB, "web-frotz", 1);
    r.onsuccess = () => { const db = r.result; const out = {};
      if (!db.objectStoreNames.contains("meta")) { db.close(); res({}); return; }
      const tx = db.transaction(["meta"], "readonly");
      const c = tx.objectStore("meta").openCursor();
      c.onsuccess = () => { const k = c.result; if (!k) return; out[k.key] = { rev: k.value.rev, size: k.value.size, deleted: !!k.value.deleted }; k.continue(); };
      tx.oncomplete = () => { db.close(); res(out); };
    };
    r.onerror = () => res({ error: String(r.error) });
  });
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
      if (done && t === last) { if (Date.now() - since >= 300) return { ok: true, tail: t.slice(Math.max(len - 40, 0)).slice(-1500) }; }
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
function abort(msg, partial) {
  console.error(`safari-check: ABORTED: ${msg}`);
  console.error(partial ? "The checks run so far are in bench/last-safari-check.md." :
    "Nothing was checked; bench/last-safari-check.md is unchanged.");
  closeOurWindows().finally(() => process.exit(2));
  return new Promise(() => {}); // `await abort(...)` stops the caller here
}

// ---- checks ----

const results = []; // { group, name, status, obs }
let current = "";
function rec(name, status, obs) {
  results.push({ group: current, name, status, obs });
  console.log(`${status.padEnd(4)} ${current} / ${name}: ${obs}`);
}
const pass = (n, o) => rec(n, "PASS", o);
const fail = (n, o) => rec(n, "FAIL", o);
const skip = (n, o) => rec(n, "SKIP", o);
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

async function saveReloadRestore(tab, saveName, savedRe, restoredRe) {
  const s = await cmd(tab, "save");
  const st1 = clip(await status(tab), 80);
  const ok1 = s.ok && savedRe.test(s.tail);
  const db1 = await idb(tab);
  const stored = db1[saveName] && !db1[saveName].deleted;
  (ok1 && stored ? pass : fail)("save", `reply "${clip(s.tail, 60)}"; IndexedDB ${saveName}: ${JSON.stringify(db1[saveName] || null)}`);
  await reload(tab);
  const r0 = await run(tab, "__T.waitReady(60000)", 65000);
  const st0 = clip(await status(tab), 80);
  (r0.ok ? pass : fail)("reload", r0.ok ? `story restarted; status "${st0}"` : `no prompt after reload: "${clip(r0.tail)}"`);
  const r = await cmd(tab, "restore");
  const st2 = clip(await status(tab), 80);
  const same = st2 === st1;
  (r.ok && restoredRe.test(r.tail) ? pass : fail)("restore",
    `reply "${clip(r.tail, 60)}"; status after save "${st1}", after restore "${st2}"${same ? " (same)" : " (DIFFERENT)"}`);
  return { st1, st2 };
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
      skip("char input", "bench/local/inputeventtest.ulx is missing (erkyrath/glk-dev, not shipped)");
      skip("timer", "same: needs bench/local/inputeventtest.ulx");
    } else {
      r = await start("A", "inputeventtest", null, null);
      await cmd("A", "get char");
      let k = await run("A", `__T.key("q", 10000)`, 15000);
      (/dec\) 113/.test(k.tail) ? pass : fail)("char input: q", `"${clip(k.tail, 80)}"`);
      await cmd("A", "get char");
      k = await run("A", `__T.key("ArrowLeft", 10000)`, 15000);
      (/FFFFFFFE/.test(k.tail) ? pass : fail)("char input: Left", `"${clip(k.tail, 80)}"`);
      const t0 = Date.now();
      const t = await cmd("A", "get timer", 15000);
      const dt = Date.now() - t0;
      (/timer event/.test(t.tail) && /Done/.test(t.tail) ? pass : fail)("timer", `"${clip(t.tail, 80)}" after ${dt} ms (game waits 2 s)`);
    }
    if (!hasStory("Alabaster.gblorb")) return skip("save/reload/restore", "git/test/Alabaster.gblorb missing");
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
    await openWindow("B");
    const hB = await waitHello("B", 0, 20000);
    if (hB.visible !== "visible") return fail("tab B opens", `tab B reports visibilityState "${hB.visible}"`);
    r = await start("B", "Balances", null, null);
    const mB = await run("B", "__T.mode()");
    const notOwner = await run("B", "__T.text().includes(WebFrotzSaves.NOT_OWNER)");
    (mB === "reader" && notOwner ? pass : fail)("tab B is session-only", `B mode ${mB}; NOT_OWNER notice ${notOwner ? "shown" : "missing"}`);
    const before = await idb("B");
    const sB = await cmd("B", "save");
    const after = await idb("B");
    const unchanged = JSON.stringify(before["Balances.sav"] || null) === JSON.stringify(after["Balances.sav"] || null);
    (unchanged ? pass : fail)("B's save stays in the tab", `reply "${clip(sB.tail, 80)}"; stored Balances.sav ${JSON.stringify(after["Balances.sav"] || null)}${unchanged ? " (unchanged)" : " (CHANGED)"}`);
    // Takeover: A leaves, B gets the lock.
    await go("A", "/__blank.html?t=A");
    let mB2 = null;
    for (let i = 0; i < 40 && mB2 !== "writer"; i++) { await new Promise((z) => setTimeout(z, 250)); mB2 = await run("B", "__T.mode()"); }
    const nowOwner = await run("B", "__T.text().includes(WebFrotzSaves.NOW_OWNER)");
    (mB2 === "writer" && nowOwner ? pass : fail)("takeover when A closes", `B mode ${mB2}; NOW_OWNER notice ${nowOwner ? "shown" : "missing"}`);
    const s2 = await cmd("B", "save");
    const db2 = await idb("B");
    const rev2 = db2["Balances.sav"] && db2["Balances.sav"].rev;
    const revBefore = after["Balances.sav"] ? after["Balances.sav"].rev : 0;
    (rev2 > revBefore ? pass : fail)("B's next save is stored", `reply "${clip(s2.tail, 60)}"; rev ${revBefore} -> ${rev2}`);

    // Queued-grant steal: B (writer) leaves; A, now a reader with its
    // IndexedDB opens gated, is granted the lock mid-snapshot; B's page
    // steals it. A must stay session-only and never become the writer.
    current = "Persistence (queued-grant steal)";
    r = await start("A", "Balances", null, null);
    const mA2 = await run("A", "__T.mode()");
    if (mA2 !== "reader") return fail("setup", `A should be a reader behind B, is ${mA2}`);
    await run("A", "__gateOpens()");
    await go("B", "/__blank.html?t=B");
    let gatedN = 0;
    for (let i = 0; i < 40 && !gatedN; i++) { await new Promise((z) => setTimeout(z, 250)); gatedN = await run("A", "window.__gatedCount || 0"); }
    if (!gatedN) { await run("A", "__openOpens()"); return fail("grant reaches A", `A's snapshot never opened IndexedDB (mode ${await run("A", "__T.mode()")})`); }
    pass("grant reaches A", `A's snapshot is held at ${gatedN} gated IndexedDB open(s); mode ${await run("A", "__T.mode()")}`);
    const st = await run("B", "__T.steal()");
    await new Promise((z) => setTimeout(z, 500));
    await run("A", "__openOpens()");
    await new Promise((z) => setTimeout(z, 2000));
    const mA3 = await run("A", "__T.mode()");
    const lost = await run("A", "__T.text().includes(WebFrotzSaves.LOST_OWNER)");
    const now = await run("A", "__T.text().includes(WebFrotzSaves.NOW_OWNER)");
    (st === "stolen" && mA3 === "reader" && lost && !now ? pass : fail)("stolen grant revokes A",
      `steal: ${st}; A mode ${mA3}; LOST_OWNER ${lost ? "shown" : "missing"}; NOW_OWNER ${now ? "SHOWN" : "not shown"}`);
    await run("B", "__T.unsteal()");
    await new Promise((z) => setTimeout(z, 2000));
    const mA4 = await run("A", "__T.mode()");
    (mA4 === "reader" ? pass : fail)("A does not queue again", `2 s after the thief let go, A mode ${mA4}`);
  },
};

async function tads(name, stem, file, walk, savedRe, restoredRe) {
  current = name;
  if (!hasStory(file)) return skip("all", `${file} missing`);
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
function writeReport(ua, startedAt) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const esc = (s) => String(s).replace(/\|/g, "\\|");
  const out = [];
  out.push("# Last Safari check", "");
  out.push(`- **When:** ${startedAt.toISOString()}`);
  out.push(`- **Commit:** ${gitHead()}${gitDirty() ? " (web/ had uncommitted changes)" : ""}`);
  out.push(`- **Safari:** ${ua || "?"}`);
  out.push(`- **Served:** \`dist-site/\` on ${ORIGIN}, with the test stories: ${EXTRA.map((s) => s.file).join(", ")}`);
  out.push(`- **Result:** ${n("PASS")} PASS, ${n("FAIL")} FAIL, ${n("SKIP")} SKIP`, "");
  out.push("Written by `make safari-check` (`bench/safari-check.js`); see the web README, \"Develop\".", "");
  out.push("| Check | | Observation |", "|---|---|---|");
  for (const r of results) out.push(`| ${esc(r.group)} / ${esc(r.name)} | **${r.status}** | ${esc(r.obs)} |`);
  out.push("", "## Startup timings", "",
    "Milliseconds from navigation start, first start of each interpreter in this run, served from localhost with `Cache-Control: no-store` (so every asset is fetched).", "",
    "| Interpreter | Story | .js loaded | .wasm loaded | wasm instantiated | first text | ready for input |", "|---|---|---|---|---|---|---|");
  for (const { interp, story, t } of timings) {
    const res = (re) => { const e = t.resources.find((x) => re.test(x.name)); return e ? `${e.end} (${Math.round(e.size / 1024)} KB)` : "?"; };
    const k = { "Z-code": "frotz", Glulx: "git", "TADS 2": "tads2", "TADS 3": "tads3" }[interp];
    out.push(`| ${interp} | ${story} | ${res(new RegExp(`^${k}\\..*\\.js$`))} | ${res(new RegExp(`^${k}\\..*\\.wasm$`))} | ${t.wasmReady ?? "?"} | ${t.firstText ?? "?"} | ${t.inputReady ?? "?"} |`);
  }
  const ev = events.filter((e) => e.error || e.rejection || e.warn);
  out.push("", "## Page errors and warnings", "");
  if (!ev.length) out.push("None.");
  for (const e of ev) out.push(`- tab ${e.t}: ${e.error ? "error" : e.rejection ? "unhandled rejection" : "warn"}: ${esc(clip(e.error || e.rejection || e.warn, 200))}`);
  out.push("");
  fs.writeFileSync(REPORT, out.join("\n"));
  console.log(`\nReport: ${path.relative(process.cwd(), REPORT)} (${n("PASS")} PASS, ${n("FAIL")} FAIL, ${n("SKIP")} SKIP)`);
  return n("FAIL");
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

  const startedAt = new Date();
  for (const name of Object.keys(CHECKS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    try {
      await CHECKS[name]();
    } catch (e) {
      rec("error", "FAIL", e.message);
      if (/did not (answer|load)/.test(e.message)) {
        const v = await run("A", "__T.visible()", 5000).catch(() => "no answer");
        if (v !== "visible" || screenLocked()) { writeReport(hello.ua, startedAt); await abort(`Safari stopped answering (page visibility: ${v}; screen ${screenLocked() ? "locked" : "unlocked"}).`, true); }
      }
    }
  }
  const failed = writeReport(hello.ua, startedAt);
  await closeOurWindows();
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
