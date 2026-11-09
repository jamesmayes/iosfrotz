// web/app.js: plain-DOM front end for the WebAssembly Frotz spike.
//
// The C side (web/src/web_os.c) calls into Module.webFrotz:
//   output(text, attr)   append text to the main window
//   clear(bg)            erase the main window to colour bg
// attr is style | fg << 8 | bg << 16 (see web_os.c).
//   grid(ch, attr, rows, cols, stride)
//                        redraw the upper window from the core's cell grid
//   screenSize()         (rows << 8) | cols that fit the page, at start
//   sizeChanged()        a new packed size after a resize, else 0
//   readLine(ms, initial, continued)
//                        Promise<{line, timedOut}>; the field starts as
//                        `initial` (the game's initial text, or the partial
//                        line of a read continued after a timeout), and a
//                        timeout returns what has been typed so far
//   readKey(ms)          Promise<number>      (0 = timed out)
//   fatal(msg)
//   syncSaves()          Promise; flushes /saves (IDBFS) to IndexedDB
// readLine/readKey are awaited from EM_ASYNC_JS, so under ASYNCIFY the
// interpreter's C stack is suspended until the player presses Enter.

const transcriptEl = document.getElementById("transcript");
const upperEl = document.getElementById("status");
const form = document.getElementById("command-form");
const input = document.getElementById("command");
const savesBtn = document.getElementById("saves-button");
const savesDialog = document.getElementById("saves-dialog");
const savesList = document.getElementById("saves-list");
const importInput = document.getElementById("import-save");
const importNote = document.getElementById("import-note");

const SAVE_DIR = "/saves";
let Module = null;
let saveName = null; // the <story>.sav name the core uses for this story

// Style bits from frotz.h: 1 reverse, 2 bold, 4 emphasis, 8 fixed.
function styleClass(style) {
  const c = [];
  if (style & 1) c.push("s-reverse");
  if (style & 2) c.push("s-bold");
  if (style & 4) c.push("s-emphasis");
  if (style & 8) c.push("s-fixed");
  return c.join(" ");
}

// ---- Upper window: a fixed-pitch grid ----
//
// The page picks the screen size in characters from its own width: as many
// columns of the grid font as fit (at least MIN_COLS, shrinking the grid
// font on narrow screens), and rows from the window height. On resize the
// new column count is handed to the core at its next read.

const GRID_PX = 15;           // grid font size before fitting
const GRID_LINE = 1.25;       // grid line height, in em
const MIN_COLS = 52;          // below 55 V3 games use the brief status line
const MAX_COLS = 100, MAX_ROWS = 100; // web/shim/iosfrotz.h
const COLUMN_PX = 768;        // max width of the reading column (48rem)

let gridState = null;         // last grid from the core
let reported = null;          // size last reported to the core
let pendingSize = 0;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function charWidth(px) {
  const probe = document.createElement("span");
  probe.className = "grid-probe";
  probe.style.fontSize = px + "px";
  probe.textContent = "0".repeat(100);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return w || px * 0.6;
}

function fitScreen() {
  // The transcript column (inside the safe-area padding, at most 48rem),
  // less its 16px side padding.
  const column = transcriptEl.clientWidth || Math.min(document.body.clientWidth, COLUMN_PX);
  const avail = column - 32;
  const chw = charWidth(GRID_PX);
  let font = GRID_PX;
  let cols = Math.floor(avail / chw);
  if (cols < MIN_COLS) {
    font = Math.max(9, (GRID_PX * avail) / (MIN_COLS * chw));
    cols = Math.floor(avail / ((chw * font) / GRID_PX));
  }
  cols = clamp(cols, 20, MAX_COLS);
  const rows = clamp(Math.floor(window.innerHeight / (font * GRID_LINE)), 20, MAX_ROWS);
  return { rows, cols, font };
}

function applyGridFont(f) {
  document.documentElement.style.setProperty("--grid-font", f.font.toFixed(2) + "px");
}

// Z-machine colour numbers 2-12 map to --z2 ... --z12 (index.html); 1 is the
// page default, which follows the light/dark scheme.
function colourVar(n, fallback) {
  return n >= 2 && n <= 12 ? `var(--z${n})` : fallback;
}

// Apply an attribute word (style | fg << 8 | bg << 16) to a span.
function applyAttr(span, a) {
  const style = a & 0xff, fg = (a >> 8) & 0xff, bg = (a >> 16) & 0xff;
  const cls = styleClass(style);
  if (cls) span.className = cls;
  if (style & 1) {
    // Reverse video swaps the colours, defaults included.
    span.style.color = colourVar(bg, "var(--screen-bg)");
    span.style.background = colourVar(fg, "var(--fg)");
  } else {
    if (fg !== 1) span.style.color = colourVar(fg, "");
    if (bg !== 1) span.style.background = colourVar(bg, "");
  }
}

function renderGrid() {
  const g = gridState;
  upperEl.textContent = "";
  if (!g || g.rows === 0) {
    upperEl.hidden = true;
    return;
  }
  const cols = Math.min(g.cols, reported ? reported.cols : g.cols);
  let anything = false;
  for (let r = 0; r < g.rows; r++) {
    const row = document.createElement("div");
    row.className = "grid-row";
    let c = 0;
    while (c < cols) {
      const a = g.attr[r * g.stride + c];
      let text = "";
      while (c < cols && g.attr[r * g.stride + c] === a) {
        const ch = g.ch[r * g.stride + c];
        text += ch ? String.fromCharCode(ch) : " ";
        c++;
      }
      if (a & 0xff || ((a >> 16) & 0xff) !== 1 || text.trim()) anything = true;
      const span = document.createElement("span");
      applyAttr(span, a);
      span.textContent = text;
      row.appendChild(span);
    }
    upperEl.appendChild(row);
  }
  upperEl.style.setProperty("--cols", cols);
  upperEl.hidden = !anything;
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!reported) return;
    const f = fitScreen();
    applyGridFont(f);
    if (f.cols !== reported.cols) {
      reported = { ...reported, cols: f.cols };
      pendingSize = (reported.rows << 8) | f.cols;
    }
    renderGrid(); // clip or re-centre now; the core redraws at its next turn
  }, 150);
});

let pending = null; // { kind: "line"|"key", resolve, timer }
// Lines submitted while the interpreter is busy (between resolving one read
// and asking for the next) are queued instead of dropped.
const typeAhead = [];
// The partial line a timed-out read returned, until the next read.
let timedOutLine = null;

function settle(value) {
  if (!pending) return;
  const p = pending;
  pending = null;
  if (p.timer) clearTimeout(p.timer);
  form.dataset.waiting = "";
  p.resolve(value);
}

// onTimeout() gives the value a timed-out read resolves with.
function wait(kind, ms, onTimeout) {
  return new Promise((resolve) => {
    pending = { kind, resolve, timer: null };
    form.dataset.waiting = kind;
    if (ms > 0) pending.timer = setTimeout(() => settle(onTimeout()), ms);
    input.focus({ preventScroll: true });
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });
}

const webFrotz = {
  output(text, attr) {
    const span = document.createElement("span");
    applyAttr(span, attr);
    span.textContent = text;
    transcriptEl.appendChild(span);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  },
  clear(bg) {
    transcriptEl.textContent = "";
    // Erasing the screen fills it with the current background colour.
    document.documentElement.style.setProperty("--screen-bg", colourVar(bg, "var(--bg)"));
  },
  grid(ch, attr, rows, cols, stride) {
    gridState = { ch: ch.slice(), attr: attr.slice(), rows, cols, stride };
    renderGrid();
  },
  screenSize() {
    const f = fitScreen();
    reported = f;
    applyGridFont(f);
    return (f.rows << 8) | f.cols;
  },
  sizeChanged() {
    const p = pendingSize;
    pendingSize = 0;
    return p;
  },
  readLine(ms, initial, continued) {
    // A line typed ahead was typed without seeing the initial text, so it
    // is taken as the whole line.
    if (typeAhead.length) return Promise.resolve({ line: typeAhead.shift(), timedOut: false });
    // A continued read gets back the partial line it returned on timeout
    // (the field normally still holds it). A new read starts from the
    // game's initial text; when there is none, the field keeps what the
    // player has started typing, unless that is just the partial line of a
    // read that the game's timeout routine ended.
    let value = input.value;
    if (continued || initial) value = initial;
    else if (timedOutLine !== null && value === timedOutLine) value = "";
    timedOutLine = null;
    if (input.value !== value) {
      input.value = value;
      input.setSelectionRange(value.length, value.length);
    }
    return wait("line", ms, () => {
      timedOutLine = input.value;
      return { line: timedOutLine, timedOut: true };
    });
  },
  readKey(ms) {
    return wait("key", ms, () => 0);
  },
  fatal(msg) {
    document.body.dataset.mode = "game";
    webFrotz.output("\n" + msg + "\n", 2 | (1 << 8) | (1 << 16));
  },
  syncSaves() {
    return persistSaves();
  },
};

// ---- Persistent saves (IDBFS) ----

function syncfs(populate) {
  return new Promise((resolve, reject) => {
    if (!Module) return resolve();
    Module.FS.syncfs(populate, (err) => (err ? reject(err) : resolve()));
  });
}

const cb = (fn) => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));

// syncfs(false) makes IndexedDB mirror MEMFS, deleting anything MEMFS lacks.
// Another tab may have saved since this page loaded, so first copy any save
// that exists only in IndexedDB into MEMFS.
async function pullMissingSaves() {
  const IDBFS = Module.IDBFS;
  const mount = Module.FS.lookupPath(SAVE_DIR).node.mount;
  const remote = await cb((k) => IDBFS.getRemoteSet(mount, k));
  const local = await cb((k) => IDBFS.getLocalSet(mount, k));
  const missing = Object.keys(remote.entries).filter((p) => !local.entries[p]).sort();
  if (!missing.length) return;
  const store = remote.db.transaction(["FILE_DATA"], "readonly").objectStore("FILE_DATA");
  for (const path of missing) {
    const entry = await cb((k) => IDBFS.loadRemoteEntry(store, path, k));
    await cb((k) => IDBFS.storeLocalEntry(path, entry, k));
  }
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// The game waits on this after every save, so it must never hang: if
// IndexedDB is stuck (Safari can hold a lock for a suspended background
// tab), give up after a few seconds. The file stays in MEMFS and goes to
// IndexedDB with the next successful sync.
let storageTrouble = null; // message for the Saves dialog, or null

function noteStorage(promise) {
  return promise.then(
    (v) => { storageTrouble = null; return v; },
    (e) => {
      storageTrouble = "Browser storage did not respond, so saves are only " +
        "kept until this page closes. Export any you need.";
      throw e;
    });
}

function persistSaves() {
  if (!Module) return Promise.resolve();
  return noteStorage(withTimeout(pullMissingSaves().then(() => syncfs(false)),
    5000, "Saving to browser storage"));
}

// Copy saves that are only in IndexedDB into MEMFS, e.g. when loading them
// at start timed out. Never deletes anything.
function refreshSaves() {
  if (!Module) return Promise.resolve();
  return noteStorage(withTimeout(pullMissingSaves(), 3000, "Loading saves"));
}

// Close the IndexedDB connection when the page is hidden for good or put in
// the back/forward cache, so a suspended page cannot hold the database for
// the next one. IDBFS reopens it on the next sync.
window.addEventListener("pagehide", () => {
  if (Module && Module.IDBFS) Module.IDBFS.quit();
});

function listSaves() {
  if (!Module) return [];
  return Module.FS.readdir(SAVE_DIR)
    .filter((n) => n !== "." && n !== "..")
    .map((n) => ({ name: n, stat: Module.FS.stat(`${SAVE_DIR}/${n}`) }))
    .filter((f) => Module.FS.isFile(f.stat.mode))
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
}

function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderSaves() {
  savesList.textContent = "";
  const files = listSaves();
  if (!files.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No saves yet. Type SAVE in the game.";
    savesList.appendChild(li);
  }
  for (const f of files) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${f.name} · ${new Date(f.stat.mtime).toLocaleString()}`;
    const exp = document.createElement("button");
    exp.type = "button";
    exp.textContent = "Export";
    exp.addEventListener("click", () =>
      download(f.name, Module.FS.readFile(`${SAVE_DIR}/${f.name}`)));
    li.append(label, exp);
    savesList.appendChild(li);
  }
  importNote.textContent = (storageTrouble ? storageTrouble + " " : "") +
    (saveName ? `Import replaces ${saveName}; then type RESTORE in the game.` : "");
}

savesBtn.addEventListener("click", async () => {
  renderSaves();
  savesDialog.showModal();
  try { await refreshSaves(); } catch (e) { console.warn("[frotz]", e); }
  renderSaves();
});

importInput.addEventListener("change", async () => {
  const file = importInput.files && importInput.files[0];
  importInput.value = "";
  if (!file || !Module || !saveName) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  Module.FS.writeFile(`${SAVE_DIR}/${saveName}`, bytes);
  try { await persistSaves(); } catch (e) { console.warn("[frotz] syncfs", e); }
  renderSaves();
});


form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!pending || pending.kind === "line") {
    const line = input.value;
    input.value = "";
    if (pending) settle({ line, timedOut: false });
    else typeAhead.push(line);
  } else {
    settle(13); // ZC_RETURN for "press any key"
  }
});

input.addEventListener("keydown", (e) => {
  if (!pending || pending.kind !== "key") return;
  e.preventDefault();
  if (e.key === "Enter") return settle(13);
  if (e.key === "Backspace") return settle(8);
  if (e.key === "Escape") return settle(27);
  const arrows = { ArrowUp: 0x81, ArrowDown: 0x82, ArrowLeft: 0x83, ArrowRight: 0x84 };
  if (e.key in arrows) return settle(arrows[e.key]);
  if (e.key.length === 1) settle(e.key.codePointAt(0));
});

// ---- Mobile Safari: keep the input above the software keyboard ----
//
// iOS does not shrink the layout viewport for the keyboard; it shrinks and
// scrolls the visual viewport. Pinning the body to the visual viewport keeps
// the input docked just above the keyboard and the transcript filling the
// rest.

function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  root.setProperty("--app-height", `${vv.height}px`);
  root.setProperty("--app-top", `${vv.offsetTop}px`);
  if (window.innerHeight - vv.height > 120) document.body.dataset.keyboard = "";
  else delete document.body.dataset.keyboard;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitViewport);
  window.visualViewport.addEventListener("scroll", fitViewport);
  fitViewport();
}

// ---- Story picker ----
//
// The start screen lists games/stories.json. Picking one sets the URL hash
// (#story=Balances) so a link can be shared; the hash selects the story at
// load. A story can only be loaded once per Module, so changing story while
// one is running reloads the page.

const pickerEl = document.getElementById("picker");
const storyListEl = document.getElementById("story-list");
const openInput = document.getElementById("open-story");
const storiesBtn = document.getElementById("stories-button");
const titleEl = document.getElementById("story-title");
let stories = [];
let running = false;

const stem = (file) => file.replace(/\.[^.]*$/, "");

function hashStory() {
  const m = /(?:^|[#&])story=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function findStory(id) {
  if (!id) return null;
  const k = id.toLowerCase();
  return stories.find((s) => stem(s.file).toLowerCase() === k) || null;
}

function renderPicker() {
  storyListEl.textContent = "";
  for (const s of stories) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#story=${encodeURIComponent(stem(s.file))}`;
    const t = document.createElement("span");
    t.className = "story-name";
    t.textContent = s.title;
    const by = document.createElement("span");
    by.className = "story-author";
    by.textContent = s.author;
    a.append(t, by);
    li.appendChild(a);
    storyListEl.appendChild(li);
  }
}

function showPicker() {
  document.body.dataset.mode = "picker";
  pickerEl.hidden = false;
  titleEl.textContent = "Web Frotz";
}

function onHashChange() {
  if (running) return location.reload();
  const s = findStory(hashStory());
  if (s) loadBundled(s).catch((err) => webFrotz.fatal(String(err)));
}

async function loadBundled(s) {
  const resp = await fetch(`games/${encodeURIComponent(s.file)}`);
  if (!resp.ok) throw new Error(`Could not load ${s.file}: ${resp.status}`);
  await play(s.file, s.title, new Uint8Array(await resp.arrayBuffer()));
}

openInput.addEventListener("change", async () => {
  const file = openInput.files && openInput.files[0];
  openInput.value = "";
  if (!file || running) return;
  // A local file cannot be linked to, so drop any #story= from the URL.
  history.replaceState(null, "", location.pathname + location.search);
  await play(file.name, stem(file.name), new Uint8Array(await file.arrayBuffer()));
});

storiesBtn.addEventListener("click", () => {
  // A URL without a fragment is always a full load, which ends the game.
  if (running) location.replace(location.pathname + location.search);
});

// The core strips everything from the first "." to build <story>.sav, and
// fastmem.c detects a Blorb (FORM/IFRS + ZCOD chunk) itself, so a .zblorb
// can be written to MEMFS as is.
async function play(fileName, title, bytes) {
  running = true;
  pickerEl.hidden = true;
  document.body.dataset.mode = "game";
  titleEl.textContent = title;
  document.title = `${title} · Web Frotz`;
  const name = fileName.replace(/[\/]/g, "_");

  Module = await createFrotz({
    webFrotz,
    print: (t) => console.log("[frotz]", t),
    printErr: (t) => console.warn("[frotz]", t),
  });
  Module.FS.mkdir("/games");
  Module.FS.mkdir(SAVE_DIR);
  Module.FS.mount(Module.IDBFS, {}, SAVE_DIR);
  try {
    // Load saves persisted by earlier visits.
    await noteStorage(withTimeout(syncfs(true), 5000, "Loading saves"));
  } catch (e) {
    console.warn("[frotz] could not load saves from IndexedDB", e);
  }
  saveName = name.replace(/\..*$/, "") + ".sav";
  Module.FS.writeFile(`/games/${name}`, bytes);
  // callMain returns when interpret() first suspends; the game then runs
  // from Promise resolutions driven by the input form.
  Module.callMain([`/games/${name}`]);
  input.focus({ preventScroll: true });
}

async function init() {
  const resp = await fetch("games/stories.json");
  stories = resp.ok ? await resp.json() : [];
  renderPicker();
  window.addEventListener("hashchange", onHashChange);
  const s = findStory(hashStory());
  if (s) await loadBundled(s);
  else showPicker();
}

init().catch((err) => webFrotz.fatal(String(err)));
