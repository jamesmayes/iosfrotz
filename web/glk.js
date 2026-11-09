// web/glk.js: plain-DOM front end for Glulx stories (git compiled to
// WebAssembly with the browser Glk in web/glk/glk_web.c).
//
// The library owns the Glk window tree and lays it out in CSS pixels from
// the font metrics this page measures; the page draws what it is told.
// glk_web.c calls into Module.glkWeb:
//
//   metrics()            [page w, h, grid char w, h, buffer char w, h,
//                         grid padding x, y, buffer padding x, y]
//   layout(recs, n)      n records of 6 ints: id, wintype, left, top, w, h
//                        (leaf windows only; any window not listed is gone)
//   text(id, s, clear)   append to a text buffer window; 0x01 + letter marks a
//                        style change ('a' + Glk style number)
//   grid(id, cols, rows, ch, st)
//                        redraw a text grid window (code points, styles)
//   inputsBegin(), input(id, kind, initial, maxlen, terms)
//                        the windows waiting for input (kind 1 line, 2 char),
//                        all of them before every wait. initial is non-null
//                        only the first time a request is sent; maxlen is in
//                        code points
//   wait(ms)             Promise<{type, win, val1, val2, text}>: the next
//                        event, or {type: 1} when ms (>= 0) runs out. Awaited
//                        from EM_ASYNC_JS, so the interpreter's C stack is
//                        suspended (ASYNCIFY) until the player acts.
//   cancelLine(id)       the partial line, when the game cancels a request
//   cancelChar(id)
//   pollArrange()        true once after the page changed size
//   loadFile(path)       Promise; bring one /saves file in from IndexedDB
//   persistFile(path)    Promise; write one /saves file to IndexedDB
//   deleteFile(path)     Promise; the game deleted a /saves file
//   setStory(stem, saveName)
//   exit()               the game ended
//
// Saves use web/saves.js, the same per-file IndexedDB store as the Z-machine
// client (database "web-frotz"). Glulx saves are named <story>.glksave.

const glkRoot = document.getElementById("glk-root");
const form = document.getElementById("command-form");
const input = document.getElementById("command");
const savesBtn = document.getElementById("saves-button");
const savesDialog = document.getElementById("saves-dialog");
const savesList = document.getElementById("saves-list");
const importInput = document.getElementById("import-save");
const importNote = document.getElementById("import-note");

const SAVE_DIR = "/saves";
let Module = null;
let saveName = null;  // <story>.glksave
let storyFile = null; // recorded with each save

// Glk event types and keycodes (glk.h).
const EV = { None: 0, Timer: 1, CharInput: 2, LineInput: 3, Arrange: 5 };
const KEY = {
  Left: 0xfffffffe, Right: 0xfffffffd, Up: 0xfffffffc, Down: 0xfffffffb,
  Return: 0xfffffffa, Delete: 0xfffffff9, Escape: 0xfffffff8, Tab: 0xfffffff7,
  PageUp: 0xfffffff6, PageDown: 0xfffffff5, Home: 0xfffffff4, End: 0xfffffff3,
};
const funcKey = (n) => 0xffffffef - (n - 1); // F1 .. F12

function keyCode(e) {
  const named = {
    ArrowLeft: KEY.Left, ArrowRight: KEY.Right, ArrowUp: KEY.Up, ArrowDown: KEY.Down,
    Enter: KEY.Return, Backspace: KEY.Delete, Delete: KEY.Delete, Escape: KEY.Escape,
    Tab: KEY.Tab, PageUp: KEY.PageUp, PageDown: KEY.PageDown, Home: KEY.Home, End: KEY.End,
  };
  if (e.key in named) return named[e.key];
  const f = /^F([1-9]|1[0-2])$/.exec(e.key);
  if (f) return funcKey(+f[1]);
  if ([...e.key].length === 1) return e.key.codePointAt(0);
  return null;
}

// ---- Metrics ----

const GRID_PAD = [6, 2];    // grid window padding x, y (px)
const BUFFER_PAD = [16, 8]; // buffer window padding x, y

function probe(cls) {
  const el = document.createElement("div");
  el.className = `glk-probe ${cls}`;
  el.textContent = "0".repeat(50);
  glkRoot.appendChild(el);
  const r = el.getBoundingClientRect();
  el.remove();
  return [r.width / 50, r.height];
}

let rootSize = { w: 0, h: 0 };

function metrics() {
  rootSize = { w: glkRoot.clientWidth, h: glkRoot.clientHeight };
  const [gcw, gch] = probe("glk-grid");
  const [bcw, bch] = probe("glk-buffer");
  return [rootSize.w, rootSize.h, gcw, gch, bcw, bch, ...GRID_PAD, ...BUFFER_PAD];
}

// ---- Windows ----

const windows = new Map(); // id -> { el, type }
const WINTYPE = { 2: "blank", 3: "buffer", 4: "grid" };
const MAX_BUFFER_NODES = 4000; // older runs are dropped beyond this

function layout(recs, n) {
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const [id, type, left, top, w, h] = recs.slice(i * 6, i * 6 + 6);
    seen.add(id);
    let win = windows.get(id);
    if (!win) {
      const el = document.createElement("div");
      el.className = `glk-win glk-${WINTYPE[type] || "blank"}`;
      el.dataset.win = String(id);
      if (type === 3) el.setAttribute("aria-live", "polite");
      glkRoot.appendChild(el);
      win = { el, type };
      windows.set(id, win);
    }
    Object.assign(win.el.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  }
  for (const [id, win] of windows) {
    if (!seen.has(id)) {
      win.el.remove();
      windows.delete(id);
    }
  }
  for (const win of windows.values()) if (win.type === 3) scrollDown(win.el);
}

function scrollDown(el) {
  el.scrollTop = el.scrollHeight;
}

function text(id, s, clear) {
  const win = windows.get(id);
  if (!win) return;
  const el = win.el;
  if (clear) el.textContent = "";
  let style = 0;
  const frag = document.createDocumentFragment();
  // Split on markers: glk_web.c starts every flush with one, and every piece
  // after a marker starts with its style letter.
  const pieces = s.split("\x01");
  for (let i = 0; i < pieces.length; i++) {
    let t = pieces[i];
    if (i > 0) {
      style = t.charCodeAt(0) - 97;
      t = t.slice(1);
    }
    if (!t) continue;
    const span = document.createElement("span");
    span.className = `gs-${style}`;
    span.textContent = t;
    frag.appendChild(span);
  }
  el.appendChild(frag);
  while (el.childNodes.length > MAX_BUFFER_NODES) el.firstChild.remove();
  scrollDown(el);
}

function grid(id, cols, rows, ch, st) {
  const win = windows.get(id);
  if (!win) return;
  const el = win.el;
  el.textContent = "";
  for (let r = 0; r < rows; r++) {
    const row = document.createElement("div");
    row.className = "glk-grid-row";
    let c = 0;
    while (c < cols) {
      const s = st[r * cols + c];
      let t = "";
      while (c < cols && st[r * cols + c] === s) {
        t += String.fromCodePoint(ch[r * cols + c] || 32);
        c++;
      }
      const span = document.createElement("span");
      span.className = `gs-${s}`;
      span.textContent = t;
      row.appendChild(span);
    }
    el.appendChild(row);
  }
}

// The main story window: the largest text buffer window. Notices go there.
function mainBuffer() {
  let best = null, area = -1;
  for (const win of windows.values()) {
    if (win.type !== 3) continue;
    const a = win.el.clientWidth * win.el.clientHeight;
    if (a > area) { best = win; area = a; }
  }
  return best;
}

function notice(msg) {
  const win = mainBuffer();
  if (!win) { console.warn("[glk]", msg); return; }
  const span = document.createElement("span");
  span.className = "notice";
  const t = win.el.textContent;
  span.textContent = (t && !t.endsWith("\n") ? "\n" : "") + msg + "\n";
  win.el.appendChild(span);
  scrollDown(win.el);
}

// ---- Input ----
//
// One record per pending request, kept across waits: { kind (1 line, 2
// char), maxlen (code points), terms, partial (a line's text while the
// command bar serves another window), seen }. glk_web.c sends every pending
// request before each wait, and the initial text only with the first. A
// request that is not sent again has ended and is dropped.
//
// There is one command bar. It serves one request at a time, the target:
// by default the first line request, else the first char request. Tapping
// a window that has a request makes it the target, so char input on one
// window is not blocked by a line request on another. Switching keeps the
// line typed so far in its record.

const requests = new Map(); // window id -> request record
let target = null;          // window id the command bar serves, or null
let pending = null;         // { resolve, timer }
let arrangePending = false;
let ended = false;
const typeAhead = []; // lines submitted while the game was busy
// True from compositionstart to compositionend: the bar then holds an input
// method's uncommitted (preedit) text, which no path may hand to the game.
// Checking an event's isComposing is not enough, because a char request is
// also read from the bar when a wait starts (after a timer or Arrange
// event ended the previous one), with no event to ask.
let composing = false;

const cpLen = (t) => [...t].length;
const cpSlice = (t, n) => [...t].slice(0, n).join("");

function inputsBegin() {
  for (const r of requests.values()) r.seen = false;
}

function inputReq(id, kind, initial, maxlen, terms) {
  let r = requests.get(id);
  if (!r || r.kind !== kind || (kind === 1 && initial !== null)) {
    // A new request: a line starts with its initial text.
    r = { kind, partial: kind === 1 ? cpSlice(initial || "", maxlen) : "" };
    requests.set(id, r);
    if (target === id) loadTarget();
  }
  r.maxlen = maxlen;
  r.terms = terms;
  r.seen = true;
  // A limit can drop under a pending line (a grid narrowed by a resize):
  // hold what is typed so far to it.
  if (kind === 1) {
    if (cpLen(r.partial) > maxlen) r.partial = cpSlice(r.partial, maxlen);
    if (target === id && !composing && cpLen(input.value) > maxlen) input.value = cpSlice(input.value, maxlen);
  }
}

// The bar's text is being replaced or the request that owned it is gone:
// an unfinished composition goes with it. Without this, a browser that never
// sends compositionend would leave the next request deaf until a blur.
function dropComposition() {
  composing = false;
}

// Put the target's own text in the bar: its line so far, or nothing. Any
// preedit text in the bar belonged to the old target, so it is dropped.
function loadTarget() {
  dropComposition();
  const r = target !== null ? requests.get(target) : null;
  input.value = r && r.kind === 1 ? r.partial : "";
  input.setSelectionRange(input.value.length, input.value.length);
}

// Show which kind of input the bar takes, and (with several requests)
// which window it serves.
function showTarget() {
  const r = target !== null ? requests.get(target) : null;
  form.dataset.waiting = r ? (r.kind === 1 ? "line" : "key") : "";
  for (const win of windows.values()) {
    if (win.el.dataset.win === String(target) && requests.size > 1) win.el.dataset.target = "";
    else delete win.el.dataset.target;
  }
}

// The player chose another window: keep the line typed so far.
function setTarget(id) {
  if (id === target) return;
  const old = target !== null ? requests.get(target) : null;
  if (old && old.kind === 1) old.partial = input.value;
  target = id;
  loadTarget();
  showTarget();
}

// Drop requests that were not sent again, and pick a target if there is
// none. What the player typed while the game was busy stays in the bar for
// the new target, unless a line starts with initial text of its own.
function settleRequests() {
  for (const [id, r] of requests) if (!r.seen) requests.delete(id);
  if (target !== null && !requests.has(target)) target = null;
  if (target === null) {
    for (const [id, r] of requests) {
      if (r.kind === 1) { target = id; break; }
      if (target === null) target = id;
    }
    const r = target !== null ? requests.get(target) : null;
    if (r && r.kind === 1 && r.partial) loadTarget();
  }
  showTarget();
}

// The request the command bar serves, if it is of this kind.
function targetReq(kind) {
  const r = target !== null ? requests.get(target) : null;
  return r && r.kind === kind ? r : null;
}

// End the target request with ev: the request is done, so its record goes.
// The bar is emptied unless the event came from elsewhere (type-ahead), in
// which case what is in the bar is the player's next input.
function finishTarget(ev, keepBar) {
  requests.delete(target);
  target = null;
  if (!keepBar) input.value = "";
  form.dataset.waiting = "";
  return ev;
}

// The first code point typed into the bar, for a char request (a soft
// keyboard or an input method commits text rather than sending keys).
function takeChar() {
  if (composing) return null; // preedit text is not input yet
  const cps = [...input.value];
  if (!cps.length) return null;
  input.value = cps.slice(1).join("");
  return cps[0].codePointAt(0);
}

function settle(ev) {
  if (!pending) return false;
  const p = pending;
  pending = null;
  if (p.timer) clearTimeout(p.timer);
  form.dataset.waiting = "";
  p.resolve(ev);
  return true;
}

function wait(ms) {
  settleRequests();
  if (arrangePending) {
    arrangePending = false;
    return Promise.resolve({ type: EV.Arrange });
  }
  if (targetReq(1) && typeAhead.length && !composing) {
    const win = target;
    return Promise.resolve(finishTarget({ type: EV.LineInput, win, text: typeAhead.shift() }, true));
  }
  if (targetReq(2)) {
    const c = takeChar(); // typed while the game was busy
    if (c !== null) {
      const win = target;
      return Promise.resolve(finishTarget({ type: EV.CharInput, win, val1: c | 0 }, true));
    }
  }
  return new Promise((resolve) => {
    pending = { resolve, timer: null };
    showTarget();
    input.removeAttribute("maxlength"); // Glk counts code points; see "input"
    // ms 0 (an overdue timer) still goes through setTimeout, a macrotask,
    // so the page paints and takes input between timer events.
    if (ms >= 0) pending.timer = setTimeout(() => settle({ type: EV.Timer }), ms);
    if (!input.matches(":focus") && !savesDialog.open) input.focus({ preventScroll: true });
  });
}

function cancelLine(id) {
  const r = requests.get(id);
  if (!r || r.kind !== 1) return "";
  const t = target === id ? input.value : r.partial;
  requests.delete(id);
  if (target === id) {
    target = null;
    input.value = "";
    dropComposition();
  }
  return t;
}

function cancelChar(id) {
  const r = requests.get(id);
  if (!r || r.kind !== 2) return;
  requests.delete(id);
  if (target === id) {
    target = null;
    // Committed text typed ahead stays for the next request; preedit text
    // (and the composition it belongs to) goes with this one.
    if (composing) {
      input.value = "";
      dropComposition();
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (ended || composing) return; // Return during a composition commits it
  if (pending && targetReq(1)) {
    const win = target;
    const t = input.value;
    settle(finishTarget({ type: EV.LineInput, win, text: t }));
  } else if (pending && targetReq(2)) {
    const win = target;
    settle(finishTarget({ type: EV.CharInput, win, val1: KEY.Return | 0 }));
  } else if (!targetReq(2)) {
    typeAhead.push(input.value);
    input.value = "";
  }
});

input.addEventListener("keydown", (e) => {
  if (!pending || e.isComposing || composing) return;
  const k = keyCode(e);
  if (k === null) return;
  const line = targetReq(1);
  if (line) {
    if (line.terms.includes(k)) {
      e.preventDefault();
      const win = target;
      const t = input.value;
      settle(finishTarget({ type: EV.LineInput, win, text: t, val2: k | 0 }));
    }
    return;
  }
  if (targetReq(2) && k !== KEY.Return) {
    // Return is left to the form's submit handler.
    e.preventDefault();
    const win = target;
    settle(finishTarget({ type: EV.CharInput, win, val1: k | 0 }));
  }
});

// Text that arrives without a usable keydown: soft keyboards, dictation,
// and input methods (the committed text of a composition). A char request
// takes the first code point; a line is held to its maxlen in code points
// (the HTML maxlength attribute counts UTF-16 units, so a supplementary
// character would not fit in a maxlen of one).
function onText(e) {
  if (e.isComposing || composing) return;
  const line = targetReq(1);
  if (line) {
    if (cpLen(input.value) > line.maxlen) input.value = cpSlice(input.value, line.maxlen);
    return;
  }
  if (pending && targetReq(2)) {
    const c = takeChar();
    if (c === null) return;
    const win = target;
    // The rest of the text stays in the bar for the next char request.
    settle(finishTarget({ type: EV.CharInput, win, val1: c | 0 }, true));
  }
}
input.addEventListener("input", onText);
input.addEventListener("compositionstart", () => { composing = true; });
input.addEventListener("compositionend", (e) => {
  composing = false;
  onText(e);
});
// Losing focus ends a composition; if a browser leaves out compositionend,
// do not keep refusing input for good.
input.addEventListener("blur", () => { composing = false; });

// A tap on a window with a pending request makes the command bar serve it.
glkRoot.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest(".glk-win") : null;
  const id = el ? Number(el.dataset.win) : NaN;
  if (requests.has(id)) setTarget(id);
});

// A tap anywhere on the story focuses the input (and shows the keyboard).
glkRoot.addEventListener("click", () => {
  if (!window.getSelection().toString()) input.focus({ preventScroll: true });
});

// ---- Resize ----

let resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!Module) return;
    if (glkRoot.clientWidth === rootSize.w && glkRoot.clientHeight === rootSize.h) return;
    if (!settle({ type: EV.Arrange })) arrangePending = true;
  }, 150);
}
window.addEventListener("resize", onResize);

function pollArrange() {
  const p = arrangePending;
  arrangePending = false;
  return p;
}

// ---- Saves (web/saves.js) ----
//
// The same per-file, revisioned store and save session as the Z-machine
// client: a write only replaces the revision this tab last saw, and a
// conflict, failure or timeout keeps the file in memory, shows a notice and
// badges the Saves button. Only the tab holding the Web Lock writes; the
// others are session-only until it closes.

const MAX_SAVE_BYTES = 4 * 1024 * 1024;
let store = null;
try {
  if (window.indexedDB) store = WebFrotzSaves.createSaveStore(window.indexedDB, { timeoutMs: 5000 });
} catch (e) {
  console.warn("[glk] IndexedDB unavailable", e);
}
const deleted = new Set(); // deleted by the game, but not in storage yet

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);

const saves = WebFrotzSaves.createSaveSession({
  store,
  fs: () => Module.FS,
  dir: SAVE_DIR,
  story: () => storyFile,
  hidden: (n) => deleted.has(n),
  locks: navigator.locks || null,
  events: window,
  onChange: savesChanged,
  onMode: savesModeChanged,
  log: { warn: (...a) => console.warn("[glk]", ...a) },
});

// Only one tab writes to browser storage (saves.js). Say so once when this
// one cannot (because another tab owns it, or because this one lost it),
// and again when it takes over; the dialog note and the badge keep saying
// it meanwhile.
function savesModeChanged(mode, previous) {
  if (mode === "reader") notice(saves.notice());
  else if (mode === "writer" && previous === "reader") notice(WebFrotzSaves.NOW_OWNER);
}

function savesChanged() {
  if (saves.mode() === "reader") {
    savesBtn.dataset.warning = "";
    savesBtn.setAttribute("aria-label", "Saves: another tab owns browser storage");
  } else if (saves.attention().length) {
    savesBtn.dataset.warning = "";
    savesBtn.setAttribute("aria-label", "Saves: a save is not in browser storage");
  } else {
    delete savesBtn.dataset.warning;
    savesBtn.removeAttribute("aria-label");
  }
  if (savesDialog.open) renderSaves();
}

async function persistFile(path, report = notice) {
  deleted.delete(baseName(path));
  const r = await saves.persist(path);
  if (r.message) report(r.message);
  return r.outcome;
}

async function loadFile(path) {
  if (deleted.has(baseName(path))) return; // its tombstone could not be written
  const r = await saves.load(path);
  if (r === "error") notice("Could not read browser storage; using this session's copy only.");
  else if (r === "local") notice(`Using this tab's own ${baseName(path)}, which is not in browser storage.`);
  else if (r === "deleted") notice(`${baseName(path)} was deleted in another tab.`);
}

// The tombstone in browser storage keeps the file deleted after a reload
// (saves.js, remove). If it cannot be written, the file stays hidden from
// the Saves dialog for this session, and the notice says it may come back.
async function deleteFile(path) {
  const name = baseName(path);
  const r = await saves.remove(path);
  if (r.outcome === "removed" || r.outcome === "none") deleted.delete(name);
  else deleted.add(name);
  if (r.message) notice(r.message);
}

let importMessage = "";

function renderSaves() {
  WebFrotzSaves.renderSaveList(savesList, saves, (msg) => {
    importMessage = msg;
    renderSaves();
  });
  const parts = [];
  if (importMessage) parts.push(importMessage);
  const note = WebFrotzSaves.attentionText(saves, !!store);
  if (note) parts.push(note);
  if (saveName) parts.push(`Import replaces ${saveName}; then type RESTORE in the game.`);
  importNote.textContent = parts.join(" ");
}

savesBtn.addEventListener("click", () => {
  importMessage = "";
  renderSaves();
  savesDialog.showModal();
  saves.refresh();
});

// Glulx saves are Quetzal files too: an IFF FORM of type IFZS.
function isQuetzal(b) {
  const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  return b.length >= 12 && tag(0) === "FORM" && tag(8) === "IFZS";
}

importInput.addEventListener("change", async () => {
  const file = importInput.files && importInput.files[0];
  importInput.value = "";
  if (!file || !Module || !saveName) return;
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
  deleted.delete(saveName);
  let r;
  try {
    r = await saves.importBytes(path, bytes);
  } catch (e) {
    console.warn("[glk] import", e);
    importMessage = `Could not write ${saveName}. Nothing was replaced.`;
    return renderSaves();
  }
  importMessage = r.outcome === "persisted" ? `Imported ${file.name} as ${saveName}.` :
    r.outcome === "conflict" ? `Imported ${file.name} as ${saveName} for this session only: ` +
      "another tab saved a newer one to browser storage." :
    r.outcome === "session" ? `Imported ${file.name} as ${saveName} for this session only: ` +
      "another Frotz tab owns browser storage." :
    `Imported ${file.name} as ${saveName}, for this session only.`;
  renderSaves();
});

// ---- The bridge object ----

const glkWeb = {
  metrics,
  layout,
  text,
  grid,
  inputsBegin,
  input: inputReq,
  wait,
  cancelLine,
  cancelChar,
  pollArrange,
  loadFile,
  persistFile: (path) => persistFile(path),
  deleteFile,
  setStory(stem, name) { saveName = name; },
  exit() {
    ended = true;
    notice("[The story has ended.]");
    input.disabled = true;
    form.dataset.waiting = "";
  },
};

// ---- Mobile Safari: keep the input above the software keyboard ----

function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  root.setProperty("--app-height", `${vv.height}px`);
  root.setProperty("--app-top", `${vv.offsetTop}px`);
  if (window.innerHeight - vv.height > 120) document.body.dataset.keyboard = "";
  else delete document.body.dataset.keyboard;
  onResize();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitViewport);
  window.visualViewport.addEventListener("scroll", fitViewport);
  fitViewport();
}

// ---- Story picker ----
//
// games/glulx-stories.json lists the bundled Glulx stories. Picking one sets
// #story=<name>; a story loads once per WebAssembly instance, so changing
// story while one runs reloads the page.

const pickerEl = document.getElementById("picker");
const storyListEl = document.getElementById("story-list");
const openInput = document.getElementById("open-story");
const storiesBtn = document.getElementById("stories-button");
const titleEl = document.getElementById("story-title");
const pickerStatus = document.getElementById("picker-status");
const APP_TITLE = "Web Glulx";
let stories = [];
let running = false;
let loadToken = 0;

const stem = (file) => file.replace(/\.[^.]*$/, "");

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
  titleEl.textContent = APP_TITLE;
  document.title = APP_TITLE;
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
  if (token !== loadToken || running) return;
  try {
    await play(fileName, title, bytes);
  } catch (err) {
    Module = null;
    running = false;
    loadFailed(err);
  }
}

function loadFailed(err) {
  console.warn("[glk] load failed", err);
  history.replaceState(null, "", location.pathname + location.search);
  showPicker(String(err && err.message ? err.message : err), true);
}

openInput.addEventListener("change", () => {
  const file = openInput.files && openInput.files[0];
  openInput.value = "";
  if (!file || running) return;
  history.replaceState(null, "", location.pathname + location.search);
  loadStory(file.name, stem(file.name), async () => new Uint8Array(await file.arrayBuffer()));
});

storiesBtn.addEventListener("click", () => {
  if (running) location.replace(location.pathname + location.search);
});

async function play(fileName, title, bytes) {
  running = true;
  pickerEl.hidden = true;
  delete document.body.dataset.loading;
  document.body.dataset.mode = "game";
  titleEl.textContent = title;
  document.title = `${title} · ${APP_TITLE}`;
  const name = fileName.replace(/[\/]/g, "_");
  try {
    Module = await createGit({
      glkWeb,
      print: (t) => console.log("[git]", t),
      printErr: (t) => console.warn("[git]", t),
    });
    Module.FS.mkdir("/games");
    Module.FS.writeFile(`/games/${name}`, bytes);
  } catch (err) {
    throw new Error(`Could not start ${title}: ${err && err.message ? err.message : err}`);
  }
  storyFile = fileName;
  saves.refresh();
  // callMain returns when the game first waits in glk_select; from then on
  // it runs from Promise resolutions driven by the input form.
  Module.callMain([`/games/${name}`]);
  input.focus({ preventScroll: true });
}

async function init() {
  window.addEventListener("hashchange", onHashChange);
  try {
    const resp = await fetch("games/glulx-stories.json");
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
