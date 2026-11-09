// web/app.js: plain-DOM front end for the WebAssembly Frotz spike.
//
// The C side (web/src/web_os.c) calls into Module.webFrotz:
//   output(text, style)  append text from the main window
//   clear()              erase the main window
//   status(text, rows)   replace the upper window / status line
//   readLine(ms)         Promise<string|null> (null = timed out)
//   readKey(ms)          Promise<number>      (0 = timed out)
//   fatal(msg)
//   syncSaves()          Promise; flushes /saves (IDBFS) to IndexedDB
// readLine/readKey are awaited from EM_ASYNC_JS, so under ASYNCIFY the
// interpreter's C stack is suspended until the player presses Enter.

const STORY = "games/Balances.z5";

const transcriptEl = document.getElementById("transcript");
const statusEl = document.getElementById("status");
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

let pending = null; // { kind: "line"|"key", resolve, timer }
// Lines submitted while the interpreter is busy (between resolving one read
// and asking for the next) are queued instead of dropped.
const typeAhead = [];

function settle(value) {
  if (!pending) return;
  const p = pending;
  pending = null;
  if (p.timer) clearTimeout(p.timer);
  form.dataset.waiting = "";
  p.resolve(value);
}

function wait(kind, ms, timeoutValue) {
  return new Promise((resolve) => {
    pending = { kind, resolve, timer: null };
    form.dataset.waiting = kind;
    if (ms > 0) pending.timer = setTimeout(() => settle(timeoutValue), ms);
    input.focus({ preventScroll: true });
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });
}

const webFrotz = {
  output(text, style) {
    const span = document.createElement("span");
    const cls = styleClass(style);
    if (cls) span.className = cls;
    span.textContent = text;
    transcriptEl.appendChild(span);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  },
  clear() {
    transcriptEl.textContent = "";
  },
  status(text, rows) {
    const lines = text.split("\n").slice(0, rows);
    statusEl.textContent = lines.map((l) => l.replace(/\s+$/, "")).join("\n");
    statusEl.hidden = rows === 0 || lines.every((l) => l.trim() === "");
  },
  readLine(ms) {
    if (typeAhead.length) return Promise.resolve(typeAhead.shift());
    return wait("line", ms, null);
  },
  readKey(ms) {
    return wait("key", ms, 0);
  },
  fatal(msg) {
    webFrotz.output("\n" + msg + "\n", 2);
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
function persistSaves() {
  if (!Module) return Promise.resolve();
  return withTimeout(pullMissingSaves().then(() => syncfs(false)), 5000, "Saving to browser storage");
}

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
  importNote.textContent = saveName
    ? `Import replaces ${saveName}; then type RESTORE in the game.`
    : "";
}

savesBtn.addEventListener("click", () => {
  renderSaves();
  savesDialog.showModal();
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

async function start() {
  const resp = await fetch(STORY);
  if (!resp.ok) throw new Error(`Could not load ${STORY}: ${resp.status}`);
  const story = new Uint8Array(await resp.arrayBuffer());
  const name = STORY.split("/").pop();

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
    await withTimeout(syncfs(true), 5000, "Loading saves");
  } catch (e) {
    console.warn("[frotz] could not load saves from IndexedDB", e);
  }
  saveName = name.replace(/\..*$/, "") + ".sav";
  Module.FS.writeFile(`/games/${name}`, story);
  // callMain returns when interpret() first suspends; the game then runs
  // from Promise resolutions driven by the input form.
  Module.callMain([`/games/${name}`]);
}

start().catch((err) => webFrotz.fatal(String(err)));
