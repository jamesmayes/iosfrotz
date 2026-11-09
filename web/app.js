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
//   setSaveName(name)    the <story>.sav name the core uses
//   persistSave(path)    Promise; after a SAVE, writes that file to IndexedDB
//   loadSave(path)       Promise; before a RESTORE, copies that file from
//                        IndexedDB into MEMFS if the stored copy is newer
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
let storyFile = null; // the story's file name, recorded with each save

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
// font on narrow screens), and rows from the height left for the two
// windows: the page (pinned to the visual viewport) less the toolbar and
// the command bar. On resize the
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
  const toolbar = document.getElementById("toolbar");
  const height = (document.body.clientHeight || window.innerHeight) -
    toolbar.offsetHeight - form.offsetHeight;
  // web_os.c needs at least 10 rows. If even that does not fit, the upper
  // window scrolls inside its own box (index.html, #status max-height).
  const rows = clamp(Math.floor(height / (font * GRID_LINE)), 10, MAX_ROWS);
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
  setSaveName(name) {
    saveName = name;
  },
  persistSave(path) {
    return persistSave(path, transcriptNotice);
  },
  loadSave(path) {
    return loadSave(path);
  },
};

// ---- Persistent saves (web/saves.js) ----
//
// /saves is plain MEMFS. A SAVE writes that one file to IndexedDB; a
// RESTORE first copies that one file back if the stored copy is newer.
// Nothing else is synchronised, so one tab can never overwrite or delete
// another tab's files, and for a file both tabs save, the later save wins.

const MAX_SAVE_BYTES = 4 * 1024 * 1024;
const SESSION_ONLY = "Saved for this session only, not to browser storage. " +
  "Export it from Saves.";

let store = null;
try {
  if (window.indexedDB) store = WebFrotzSaves.createSaveStore(window.indexedDB, { timeoutMs: 5000 });
} catch (e) {
  console.warn("[frotz] IndexedDB unavailable", e);
}
let stored = [];          // last store.list(): [{ name, size, mtime, story }]
let persistFailed = false; // the last persist failed; badge on the Saves button

const mtimeOf = (st) => +st.mtime;

function setPersistFailed(on) {
  persistFailed = on;
  if (on) {
    savesBtn.dataset.warning = "";
    savesBtn.setAttribute("aria-label", "Saves: a save is not in browser storage");
  } else {
    delete savesBtn.dataset.warning;
    savesBtn.removeAttribute("aria-label");
  }
}

// A line of its own in the transcript, styled apart from the game's text.
function transcriptNotice(msg) {
  const text = transcriptEl.textContent;
  const span = document.createElement("span");
  span.className = "notice";
  span.textContent = (text && !text.endsWith("\n") ? "\n" : "") + msg + "\n";
  transcriptEl.appendChild(span);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Write one MEMFS file to IndexedDB. Never throws: a failure or timeout is
// reported through `report` and leaves the Saves badge on until a later
// persist succeeds.
async function persistSave(path, report) {
  try {
    if (!store) throw new Error("IndexedDB is not available");
    const r = await WebFrotzSaves.persistFile(store, Module.FS, path, storyFile);
    if (r === "kept-newer") console.info(`[frotz] ${path}: browser storage has a later save; kept it`);
    setPersistFailed(false);
    refreshStored();
    return true;
  } catch (e) {
    console.warn("[frotz] could not write", path, "to IndexedDB", e);
    setPersistFailed(true);
    report(SESSION_ONLY);
    return false;
  }
}

// Before a RESTORE: bring in the stored copy if MEMFS lacks the file or the
// stored copy is newer. On failure the restore uses whatever MEMFS has.
async function loadSave(path) {
  if (!store) return;
  try {
    await WebFrotzSaves.loadFile(store, Module.FS, path);
  } catch (e) {
    console.warn("[frotz] could not read", path, "from IndexedDB", e);
    transcriptNotice("Could not read browser storage; restoring from this session only.");
  }
}

async function refreshStored() {
  if (!store) return;
  try {
    stored = await store.list();
  } catch (e) {
    console.warn("[frotz] could not list saves", e);
  }
  if (savesDialog.open) renderSaves();
}

// Saves this session has in MEMFS, merged with the ones in browser storage.
// The newer copy of each name is shown and exported. A MEMFS copy counts as
// "local" only if it is newer than the stored one (a copy a RESTORE read
// from storage has the same mtime); with storage working, that means the
// save did not reach it.
function allSaves() {
  const byName = new Map();
  for (const s of stored) byName.set(s.name, { name: s.name, mtime: s.mtime, size: s.size, local: false });
  if (Module) {
    for (const n of Module.FS.readdir(SAVE_DIR)) {
      if (n === "." || n === "..") continue;
      const st = Module.FS.stat(`${SAVE_DIR}/${n}`);
      if (!Module.FS.isFile(st.mode)) continue;
      const prev = byName.get(n);
      if (!prev || mtimeOf(st) > prev.mtime)
        byName.set(n, { name: n, mtime: mtimeOf(st), size: st.size, local: true });
    }
  }
  return [...byName.values()].sort((a, b) => b.mtime - a.mtime);
}

async function exportSave(f) {
  try {
    let bytes;
    if (f.local) bytes = Module.FS.readFile(`${SAVE_DIR}/${f.name}`);
    else {
      const rec = await store.get(f.name);
      if (!rec) throw new Error("not found");
      bytes = rec.bytes;
    }
    download(f.name, bytes);
  } catch (e) {
    console.warn("[frotz] export", f.name, e);
    importNote.textContent = `Could not read ${f.name}.`;
  }
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

let importMessage = "";

function renderSaves() {
  savesList.textContent = "";
  const files = allSaves();
  if (!files.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No saves yet. Type SAVE in the game.";
    savesList.appendChild(li);
  }
  for (const f of files) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${f.name} · ${new Date(f.mtime).toLocaleString()}` +
      (f.local ? " · this session only" : "");
    const exp = document.createElement("button");
    exp.type = "button";
    exp.textContent = "Export";
    exp.addEventListener("click", () => exportSave(f));
    li.append(label, exp);
    savesList.appendChild(li);
  }
  const parts = [];
  if (importMessage) parts.push(importMessage);
  if (persistFailed || !store)
    parts.push("A save could not be written to browser storage. It is kept only until " +
      "this page closes, so export it.");
  if (saveName) parts.push(`Import replaces ${saveName}; then type RESTORE in the game.`);
  importNote.textContent = parts.join(" ");
}

savesBtn.addEventListener("click", () => {
  importMessage = "";
  renderSaves();
  savesDialog.showModal();
  refreshStored();
});

// A Quetzal save is an IFF FORM of type IFZS.
function isQuetzal(b) {
  const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  return b.length >= 12 && tag(0) === "FORM" && tag(8) === "IFZS";
}

importInput.addEventListener("change", async () => {
  const file = importInput.files && importInput.files[0];
  importInput.value = "";
  if (!file || !Module || !saveName) return;
  // Anything invalid leaves the current save as it is.
  if (file.size > MAX_SAVE_BYTES) {
    importMessage = `${file.name} is too large for a save file (over 4 MB). Nothing was replaced.`;
    return renderSaves();
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    importMessage = `Could not read ${file.name}. Nothing was replaced.`;
    return renderSaves();
  }
  if (!isQuetzal(bytes)) {
    importMessage = `${file.name} is not a Quetzal save file. Nothing was replaced.`;
    return renderSaves();
  }
  const path = `${SAVE_DIR}/${saveName}`;
  try {
    Module.FS.writeFile(path, bytes);
  } catch (e) {
    importMessage = `Could not write ${saveName}.`;
    return renderSaves();
  }
  const ok = await persistSave(path, () => {});
  importMessage = ok ? `Imported ${file.name} as ${saveName}.` : `Imported ${file.name} as ${saveName}, for this session only.`;
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
const pickerStatus = document.getElementById("picker-status");
let stories = [];
// A story can only be loaded once per Module. `running` is set when play()
// starts creating one; from then on, picking another story reloads the
// page. Before that, a newer pick supersedes an older one: each load takes
// a token, and a fetch that completes after a newer pick is dropped.
let running = false;
let loadToken = 0;

const stem = (file) => file.replace(/\.[^.]*$/, "");

// #story=<id>, the parameter name in any case. Malformed escapes mean no
// story (the picker), never an error.
function hashStory() {
  const m = /(?:^|[#&])story=([^&]*)/i.exec(location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return null;
  }
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

function showPicker(message, isError) {
  document.body.dataset.mode = "picker";
  delete document.body.dataset.loading;
  pickerEl.hidden = false;
  titleEl.textContent = "Web Frotz";
  document.title = "Web Frotz";
  pickerStatus.textContent = message || "";
  pickerStatus.className = isError ? "error" : "";
}

function onHashChange() {
  if (running) return location.reload();
  const s = findStory(hashStory());
  if (s) loadStory(s.file, s.title, () => fetchBundled(s));
  else showPicker();
}

async function fetchBundled(s) {
  const resp = await fetch(`games/${encodeURIComponent(s.file)}`);
  if (!resp.ok) throw new Error(`Could not load ${s.file}: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// Claims the loading state before the first await. Failures put the picker
// back with the error shown.
async function loadStory(fileName, title, getBytes) {
  if (running) return;
  const token = ++loadToken;
  document.body.dataset.loading = "";
  pickerStatus.className = "";
  pickerStatus.textContent = `Loading ${title}…`;
  let bytes;
  try {
    bytes = await getBytes();
  } catch (err) {
    if (token === loadToken) loadFailed(err);
    return;
  }
  if (token !== loadToken || running) return; // a later pick won
  try {
    await play(fileName, title, bytes);
  } catch (err) {
    // createFrotz or the file system failed before the game started.
    Module = null;
    running = false;
    loadFailed(err);
  }
}

function loadFailed(err) {
  console.warn("[frotz] load failed", err);
  // Drop the hash so picking the same story again is a new hashchange.
  history.replaceState(null, "", location.pathname + location.search);
  showPicker(String(err && err.message ? err.message : err), true);
}

openInput.addEventListener("change", () => {
  const file = openInput.files && openInput.files[0];
  openInput.value = "";
  if (!file || running) return;
  // A local file cannot be linked to, so drop any #story= from the URL.
  history.replaceState(null, "", location.pathname + location.search);
  loadStory(file.name, stem(file.name), async () => new Uint8Array(await file.arrayBuffer()));
});

storiesBtn.addEventListener("click", () => {
  // A URL without a fragment is always a full load, which ends the game.
  if (running) location.replace(location.pathname + location.search);
});

// The core tells the page its <story>.sav name (setSaveName), and
// fastmem.c detects a Blorb (FORM/IFRS + ZCOD chunk) itself, so a .zblorb
// can be written to MEMFS as is.
async function play(fileName, title, bytes) {
  running = true;
  pickerEl.hidden = true;
  delete document.body.dataset.loading;
  document.body.dataset.mode = "game";
  titleEl.textContent = title;
  document.title = `${title} · Web Frotz`;
  const name = fileName.replace(/[\/]/g, "_");

  try {
    Module = await createFrotz({
      webFrotz,
      print: (t) => console.log("[frotz]", t),
      printErr: (t) => console.warn("[frotz]", t),
    });
    Module.FS.mkdir("/games");
    Module.FS.mkdir(SAVE_DIR);
    Module.FS.writeFile(`/games/${name}`, bytes);
  } catch (err) {
    throw new Error(`Could not start ${title}: ${err && err.message ? err.message : err}`);
  }
  // Saves are read from IndexedDB one file at a time, at RESTORE; this only
  // lists them for the Saves dialog, and the game does not wait for it.
  refreshStored();
  storyFile = fileName;
  // callMain returns when interpret() first suspends; the game then runs
  // from Promise resolutions driven by the input form.
  Module.callMain([`/games/${name}`]);
  input.focus({ preventScroll: true });
}

async function init() {
  window.addEventListener("hashchange", onHashChange);
  try {
    const resp = await fetch("games/stories.json");
    stories = resp.ok ? await resp.json() : [];
  } catch (e) {
    stories = [];
  }
  renderPicker();
  const s = findStory(hashStory());
  if (s) loadStory(s.file, s.title, () => fetchBundled(s));
  else showPicker(stories.length ? "" : "Could not load the story list. Open a story file instead.", !stories.length);
}

init();
