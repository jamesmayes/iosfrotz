// web/app.js: plain-DOM front end for Z-code stories (Frotz compiled to
// WebAssembly with the browser OS layer in web/src/web_os.c). main.js loads
// it, with dist/frotz.js, when the first Z-code story starts; it registers
// with web/ui.js as the "zcode" engine.
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
//   persistSave(path)    Promise; after a SAVE (or auxiliary save), writes
//                        that file to IndexedDB
//   loadSave(path)       Promise; before a RESTORE (or auxiliary restore),
//                        brings that file in from IndexedDB
// readLine/readKey are awaited from EM_ASYNC_JS, so under ASYNCIFY the
// interpreter's C stack is suspended until the player presses Enter.

const transcriptEl = document.getElementById("transcript");
const upperEl = document.getElementById("status");
const form = document.getElementById("command-form");
const input = document.getElementById("command");
const UI = WebFrotzUI;

const SAVE_DIR = UI.SAVE_DIR;
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
    // is taken as the whole line. It also ends any timed-out read, so the
    // timeout marker is retired here too: otherwise a fresh line the player
    // types later that happens to equal it would be erased below.
    if (typeAhead.length) {
      timedOutLine = null;
      return Promise.resolve({ line: typeAhead.shift(), timedOut: false });
    }
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

// ---- Persistent saves (web/saves.js, through web/ui.js) ----
//
// /saves is plain MEMFS; a SAVE (or auxiliary save) writes that one file to
// IndexedDB and a RESTORE first brings that one file in. ui.js has the
// Saves button, dialog and import, and the single-writer rule.

const saves = UI.createSaves({
  tag: "frotz",
  fs: () => Module.FS,
  story: () => storyFile,
  saveName: () => saveName,
  ready: () => !!Module,
  notice: transcriptNotice,
});

// A line of its own in the transcript, styled apart from the game's text.
function transcriptNotice(msg) {
  UI.appendNotice(transcriptEl, msg);
}

// Write one MEMFS file to IndexedDB. Never throws: a conflict, failure or
// timeout is reported through `report` and leaves the badge on.
async function persistSave(path, report) {
  const r = await saves.persist(path);
  if (r.message) report(r.message);
  return r.outcome;
}

// Before a RESTORE: bring in the stored copy (saves.js decides when). On
// failure the restore uses whatever MEMFS has.
async function loadSave(path) {
  const r = await saves.load(path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (r === "error") transcriptNotice("Could not read browser storage; restoring from this session only.");
  else if (r === "local") transcriptNotice(`Restoring this tab's own ${name}, which is not in browser storage.`);
  else if (r === "deleted") transcriptNotice(`${name} was deleted in another tab.`);
}

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

// ---- Mobile Safari: keep the latest text in view as the keyboard moves ----

UI.onViewport(() => {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
});

// ---- Start (main.js calls this once per page) ----
//
// The core tells the page its <story>.sav name (setSaveName), and
// fastmem.c detects a Blorb (FORM/IFRS + ZCOD chunk) itself, so a .zblorb
// can be written to MEMFS as is.
async function play(fileName, title, bytes) {
  const name = fileName.replace(/[\/]/g, "_");
  try {
    Module = await createFrotz({
      webFrotz,
      locateFile: UI.locateFile,
      print: (t) => console.log("[frotz]", t),
      printErr: (t) => console.warn("[frotz]", t),
    });
    Module.FS.mkdir("/games");
    Module.FS.mkdir(SAVE_DIR);
    Module.FS.writeFile(`/games/${name}`, bytes);
  } catch (err) {
    Module = null;
    throw new Error(`Could not start ${title}: ${err && err.message ? err.message : err}`);
  }
  // Saves are read from IndexedDB one file at a time, at RESTORE; this only
  // lists them for the Saves dialog, and the game does not wait for it.
  saves.refresh();
  storyFile = fileName;
  // callMain returns when interpret() first suspends; the game then runs
  // from Promise resolutions driven by the input form.
  Module.callMain([`/games/${name}`]);
  input.focus({ preventScroll: true });
}

UI.registerEngine("zcode", { start: play });
