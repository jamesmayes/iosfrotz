// web/ui.js: the parts of the page both interpreters share.
//
//   detectFormat(bytes)  which interpreter a story file needs, from its
//                        magic bytes: { format: "zcode" | "glulx" } or
//                        { error } (no DOM; also used by bench/check-page.js)
//   asset(path)          the URL of a build file (dist/frotz.js, app.js, ...):
//                        the path itself, or the content-hashed name the
//                        deploy build (deploy/build-site.js) maps it to
//   locateFile(p, prefix)
//                        the Emscripten hook that finds the .wasm the same way
//   registerEngine(format, engine), engine(format)
//                        the interpreter front ends (app.js for Z-code, glk.js
//                        for Glulx) register here when main.js loads them
//   onViewport(fn)       call fn after the page is re-pinned to the visual
//                        viewport (mobile Safari's keyboard)
//   appendNotice(el, msg)
//                        a storage notice on a line of its own in el
//   createSaves(opts)    the Saves button, dialog and import for one story,
//                        on a web/saves.js save session
//
// Only one interpreter runs in a page: main.js loads its front end when the
// first story starts, and changing story reloads the page.

(function (root) {
  "use strict";

  // ---- Story formats ----
  //
  // Z-code has no magic number, so a file counts as Z-code when its header
  // is plausible: version 1-8, and static memory and the object table inside
  // the file, after the 64-byte header. Glulx starts with "Glul". A Blorb
  // (FORM ... IFRS) is opened by the interpreter whose executable chunk it
  // holds (ZCOD or GLUL); fastmem.c and git each find that chunk themselves.

  const tag = (b, i) => (i + 4 <= b.length ? String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]) : "");
  const u16 = (b, i) => (b[i] << 8) | b[i + 1];
  const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

  function isZcode(b) {
    if (b.length < 64 || b[0] < 1 || b[0] > 8) return false;
    const staticBase = u16(b, 0x0e), objects = u16(b, 0x0a);
    return staticBase >= 64 && staticBase <= b.length && objects >= 64 && objects < b.length;
  }

  const NOT_A_STORY = "is not a Z-code or Glulx story file. This player opens .z3–.z8, .ulx " +
    "and Blorb (.zblorb, .gblorb) files.";

  function detectFormat(b) {
    if (tag(b, 0) === "Glul") return { format: "glulx" };
    if (tag(b, 0) === "FORM") {
      if (tag(b, 8) !== "IFRS") return { error: NOT_A_STORY };
      const end = Math.min(b.length, 8 + u32(b, 4));
      for (let p = 12; p + 8 <= end;) {
        const t = tag(b, p), len = u32(b, p + 4);
        if (t === "ZCOD") return { format: "zcode" };
        if (t === "GLUL") return { format: "glulx" };
        p += 8 + len + (len & 1);
      }
      return { error: "is a Blorb file with no Z-code or Glulx story in it." };
    }
    if (isZcode(b)) return { format: "zcode" };
    return { error: NOT_A_STORY };
  }

  // ---- Build files ----

  function asset(path) {
    const map = root.WebFrotzAssets;
    return (map && map[path]) || path;
  }

  function locateFile(p, prefix) {
    const map = root.WebFrotzAssets;
    return (map && map[`dist/${p}`]) || prefix + p;
  }

  // ---- Interpreter front ends ----

  const engines = {};
  const registerEngine = (format, e) => { engines[format] = e; };
  const engine = (format) => engines[format] || null;

  // ---- Mobile Safari: keep the input above the software keyboard ----
  //
  // iOS does not shrink the layout viewport for the keyboard; it shrinks and
  // scrolls the visual viewport. Pinning the body to the visual viewport
  // (--app-top, --app-height in index.html) keeps the input docked just
  // above the keyboard and the story filling the rest.

  const viewportHooks = [];

  function fitViewport() {
    const vv = root.visualViewport;
    if (!vv) return;
    const style = document.documentElement.style;
    style.setProperty("--app-height", `${vv.height}px`);
    style.setProperty("--app-top", `${vv.offsetTop}px`);
    if (root.innerHeight - vv.height > 120) document.body.dataset.keyboard = "";
    else delete document.body.dataset.keyboard;
    for (const fn of viewportHooks) fn();
  }

  function onViewport(fn) {
    viewportHooks.push(fn);
    if (root.visualViewport) fn();
  }

  if (typeof document !== "undefined" && root.visualViewport) {
    root.visualViewport.addEventListener("resize", fitViewport);
    root.visualViewport.addEventListener("scroll", fitViewport);
    fitViewport();
  }

  // ---- Notices ----

  // A line of its own, styled apart from the game's text (.notice).
  function appendNotice(el, msg) {
    const t = el.textContent;
    const span = document.createElement("span");
    span.className = "notice";
    span.textContent = (t && !t.endsWith("\n") ? "\n" : "") + msg + "\n";
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  }

  // ---- Saves (web/saves.js) ----
  //
  // /saves is plain MEMFS. A SAVE writes that one file to IndexedDB; a
  // RESTORE first brings that one file in. Each stored file has a revision,
  // and a write only replaces the revision this tab last saw, so a tab never
  // overwrites another tab's newer save: it gets a conflict, keeps its own
  // save in memory, and says so. Where Web Locks exist, only one tab (the
  // first) writes at all; the others keep their saves for the session and
  // say so (saves.js has the details).
  //
  // opts:
  //   tag            console prefix ("frotz", "glk")
  //   fs()           the Emscripten FS
  //   story()        the story file name recorded with each save
  //   saveName()     the file Import replaces (<story>.sav, <story>.glksave)
  //   ready()        true once the story has started
  //   notice(msg)    show a notice in the story
  //   hidden(name)   optional: leave a name out of the Saves dialog
  //   beforeImport(name)
  //                  optional: called before an import writes `name`
  // Returns the save session.

  const SAVE_DIR = "/saves";
  const MAX_SAVE_BYTES = 4 * 1024 * 1024;

  // Z-machine and Glulx saves are both Quetzal: an IFF FORM of type IFZS.
  function isQuetzal(b) {
    return b.length >= 12 && tag(b, 0) === "FORM" && tag(b, 8) === "IFZS";
  }

  function createSaves(opts) {
    const Saves = root.WebFrotzSaves;
    const savesBtn = document.getElementById("saves-button");
    const savesDialog = document.getElementById("saves-dialog");
    const savesList = document.getElementById("saves-list");
    const importInput = document.getElementById("import-save");
    const importNote = document.getElementById("import-note");
    const warn = (...a) => console.warn(`[${opts.tag}]`, ...a);

    let store = null;
    try {
      if (root.indexedDB) store = Saves.createSaveStore(root.indexedDB, { timeoutMs: 5000 });
    } catch (e) {
      warn("IndexedDB unavailable", e);
    }

    const saves = Saves.createSaveSession({
      store,
      fs: opts.fs,
      dir: SAVE_DIR,
      story: opts.story,
      hidden: opts.hidden,
      locks: (root.navigator && root.navigator.locks) || null,
      events: root,
      onChange: savesChanged,
      onMode: savesModeChanged,
      log: { warn },
    });

    // Only one tab writes to browser storage. Say so once when this one
    // cannot (because another tab owns it, or because this one lost it), and
    // again when it takes over; the dialog note and the badge keep saying it
    // meanwhile.
    function savesModeChanged(mode, previous) {
      if (mode === "reader") opts.notice(saves.notice());
      else if (mode === "writer" && previous === "reader") opts.notice(Saves.NOW_OWNER);
    }

    // The badge stays on while any save this tab made is not in storage.
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

    let importMessage = "";

    function renderSaves() {
      Saves.renderSaveList(savesList, saves, (msg) => {
        importMessage = msg;
        renderSaves();
      });
      const parts = [];
      if (importMessage) parts.push(importMessage);
      const note = Saves.attentionText(saves, !!store);
      if (note) parts.push(note);
      const name = opts.saveName();
      if (name) parts.push(`Import replaces ${name}; then type RESTORE in the game.`);
      importNote.textContent = parts.join(" ");
    }

    savesBtn.addEventListener("click", () => {
      importMessage = "";
      renderSaves();
      savesDialog.showModal();
      saves.refresh();
    });

    importInput.addEventListener("change", async () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = "";
      const saveName = opts.saveName();
      if (!file || !opts.ready() || !saveName) return;
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
      if (opts.beforeImport) opts.beforeImport(saveName);
      let r;
      try {
        r = await saves.importBytes(`${SAVE_DIR}/${saveName}`, bytes);
      } catch (e) {
        warn("import", e);
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

    return saves;
  }

  const api = {
    detectFormat, asset, locateFile, registerEngine, engine, onViewport, appendNotice,
    createSaves, isQuetzal, SAVE_DIR,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WebFrotzUI = api;
})(typeof self !== "undefined" ? self : globalThis);
