// web/app.js: plain-DOM front end for the WebAssembly Frotz spike.
//
// The C side (web/src/web_os.c) calls into Module.webFrotz:
//   output(text, style)  append text from the main window
//   clear()              erase the main window
//   status(text, rows)   replace the upper window / status line
//   readLine(ms)         Promise<string|null> (null = timed out)
//   readKey(ms)          Promise<number>      (0 = timed out)
//   fatal(msg)
// readLine/readKey are awaited from EM_ASYNC_JS, so under ASYNCIFY the
// interpreter's C stack is suspended until the player presses Enter.

const STORY = "games/Balances.z5";

const transcriptEl = document.getElementById("transcript");
const statusEl = document.getElementById("status");
const form = document.getElementById("command-form");
const input = document.getElementById("command");

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
};

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!pending || pending.kind === "line") {
    const line = input.value;
    input.value = "";
    if (pending) settle(line);
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

async function start() {
  const resp = await fetch(STORY);
  if (!resp.ok) throw new Error(`Could not load ${STORY}: ${resp.status}`);
  const story = new Uint8Array(await resp.arrayBuffer());
  const name = STORY.split("/").pop();

  const Module = await createFrotz({
    webFrotz,
    print: (t) => console.log("[frotz]", t),
    printErr: (t) => console.warn("[frotz]", t),
  });
  Module.FS.mkdir("/games");
  Module.FS.mkdir("/saves");
  Module.FS.writeFile(`/games/${name}`, story);
  // callMain returns when interpret() first suspends; the game then runs
  // from Promise resolutions driven by the input form.
  Module.callMain([`/games/${name}`]);
}

start().catch((err) => webFrotz.fatal(String(err)));
