// web/main.js: the start page. One catalogue (games/stories.json) for both
// interpreters, an "Open a story file…" picker, and #story= links.
//
// The story's format comes from its bytes (WebFrotzUI.detectFormat), never
// from its extension. The matching interpreter is loaded on demand:
//
//   zcode  dist/frotz.js + app.js   (Frotz, web/src/web_os.c)
//   glulx  dist/git.js   + glk.js   (git, web/glk/glk_web.c)
//   tads2  dist/tads2.js + glk.js   (TADS 2 on the same Glk, web/tads/)
//   tads3  dist/tads3.js + glk.js   (TADS 3 on the same Glk, web/tads/)
//
// A story can only be loaded once per WebAssembly instance, and only one
// interpreter's front end runs in a page, so changing story while one is
// running reloads the page. Before that, a newer pick supersedes an older
// one: each load takes a token, and a fetch that completes after a newer
// pick is dropped.

(function () {
  "use strict";

  const UI = WebFrotzUI;
  const APP_TITLE = "Web Frotz";
  const ENGINES = {
    zcode: { name: "Z-code", scripts: ["dist/frotz.js", "app.js"] },
    glulx: { name: "Glulx", scripts: ["dist/git.js", "glk.js"] },
    tads2: { name: "TADS 2", scripts: ["dist/tads2.js", "glk.js"] },
    tads3: { name: "TADS 3", scripts: ["dist/tads3.js", "glk.js"] },
  };

  const pickerEl = document.getElementById("picker");
  const storyListEl = document.getElementById("story-list");
  const openInput = document.getElementById("open-story");
  const storiesBtn = document.getElementById("stories-button");
  const titleEl = document.getElementById("story-title");
  const pickerStatus = document.getElementById("picker-status");
  const commandForm = document.getElementById("command-form");
  const commandInput = document.getElementById("command");

  // The command bar shows as soon as a story starts loading, but its submit
  // handler belongs to the front end (app.js or glk.js), which is still
  // downloading. Return there would be a native form submit, which reloads
  // the page. So the page never lets the form submit, and the field stays
  // disabled, saying "Loading…", until the front end has loaded.
  commandForm.addEventListener("submit", (e) => e.preventDefault());
  function setCommandLoading(on) {
    commandInput.disabled = on;
    commandInput.placeholder = on ? "Loading…" : "";
  }

  let stories = [];
  // Set when a story's interpreter starts loading; from then on, picking
  // another story reloads the page.
  let running = false;
  let loadToken = 0;
  // The interpreter whose front end is loaded. If it failed to start, a
  // story in the same format can still be tried in this page; one in the
  // other format needs a fresh page, since the two front ends share the
  // command bar.
  let loadedFormat = null;

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
      const e = ENGINES[s.format];
      by.textContent = e ? `${s.author} · ${e.name}` : s.author;
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

  function showGame(title, format) {
    pickerEl.hidden = true;
    delete document.body.dataset.loading;
    document.body.dataset.format = format;
    document.body.dataset.mode = "game";
    setCommandLoading(true);
    titleEl.textContent = title;
    document.title = `${title} · ${APP_TITLE}`;
  }

  function onHashChange() {
    if (running) return location.reload();
    const s = findStory(hashStory());
    if (s && loadedFormat && s.format && s.format !== loadedFormat) return location.reload();
    if (s) loadBundled(s);
    else showPicker();
  }

  function loadBundled(s) {
    loadStory(s.file, s.title, async () => {
      const resp = await fetch(`games/${encodeURIComponent(s.file)}`);
      if (!resp.ok) throw new Error(`Could not load ${s.file}: ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    }, s.format);
  }

  // One <script> per build file, in order; each loads once.
  const loaded = new Map();
  function loadScript(path) {
    if (loaded.has(path)) return loaded.get(path);
    const p = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = UI.asset(path);
      el.onload = () => resolve();
      el.onerror = () => {
        el.remove();
        loaded.delete(path);
        reject(new Error(`Could not load ${path}.`));
      };
      document.body.appendChild(el);
    });
    loaded.set(path, p);
    return p;
  }

  async function loadEngine(format) {
    const e = ENGINES[format];
    try {
      for (const s of e.scripts) await loadScript(s);
    } catch (err) {
      throw new Error(`Could not load the ${e.name} interpreter. ${err.message}`);
    }
    loadedFormat = format;
    return UI.engine(format);
  }

  // Claims the loading state before the first await. Failures put the picker
  // back with the error shown. `expected` is the catalogue's format.
  async function loadStory(fileName, title, getBytes, expected) {
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
    const d = UI.detectFormat(bytes);
    if (d.error) return loadFailed(new Error(`${fileName} ${d.error}`));
    if (expected && expected !== d.format) {
      return loadFailed(new Error(`${fileName} is a ${ENGINES[d.format].name} story, but the ` +
        `catalogue lists it as ${ENGINES[expected] ? ENGINES[expected].name : expected}.`));
    }
    if (loadedFormat && loadedFormat !== d.format) {
      return loadFailed(new Error(`Reload the page to open ${fileName}: the ` +
        `${ENGINES[loadedFormat].name} interpreter is already loaded here.`));
    }
    running = true;
    showGame(title, d.format);
    try {
      const engine = await loadEngine(d.format);
      setCommandLoading(false);
      await engine.start(fileName, title, bytes);
    } catch (err) {
      // The interpreter, its module or the file system failed before the
      // game started.
      running = false;
      loadFailed(err);
    }
  }

  function loadFailed(err) {
    console.warn("[web] load failed", err);
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
    if (s) loadBundled(s);
    else showPicker(stories.length ? "" : "Could not load the story list. Open a story file instead.", !stories.length);
  }

  init();
})();
