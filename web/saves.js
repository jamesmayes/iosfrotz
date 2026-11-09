// web/saves.js: per-file save storage in IndexedDB for Web Frotz and the
// Glulx page.
//
// /saves in the interpreter is plain MEMFS. Nothing mirrors the whole
// directory. Each file is persisted on its own:
//
//   - after a successful SAVE, put() writes that one file in one readwrite
//     transaction;
//   - before a RESTORE, get() reads that one file, and the session copies it
//     into MEMFS (see createSaveSession);
//   - list() reads only the small "meta" records, for the Saves dialog.
//
// Database "web-frotz", version 1:
//   store "saves": key = file name, value = { bytes, mtime, story, rev }
//   store "meta":  key = file name, value = { size, mtime, story, rev, sha256 }
// put() writes both in the same transaction, so they always agree.
//
// Deletion (remove()) leaves a tombstone: the bytes record goes, and meta
// keeps the name with { deleted: true } and the next rev. get() then finds
// nothing, list() reports the tombstone (sessions leave it out of the
// Saves dialog), and a stale tab that saves the old version afterwards gets
// a conflict like any other, instead of bringing the file back unnoticed.
//
// Revisions, not timestamps, decide conflicts between tabs. Each file's
// meta has `rev`, an integer that starts at 1 and goes up by one with every
// write. A store remembers, per file, the rev it last saw: from list() the
// first time it sees a name, from its own committed put(), and from
// adopt() when a restore copies the stored file into MEMFS. put() runs ONE
// readwrite transaction: it reads meta and, if the stored rev is not the
// one this tab expects, resolves { outcome: "conflict", theirs: meta }
// without writing anything; otherwise it writes bytes and meta with rev + 1.
// So a tab can only replace the version it last saw: if another tab saved
// in between, the stale tab gets a conflict, however close together the two
// saves were. mtime is informational only. A missing record counts as
// rev 0: there is nothing to overwrite. If the stored bytes already equal
// this tab's (same sha256), the save counts as persisted without a write.
//
// Timeouts and supersession: every operation is a promise that settles
// within `timeoutMs`. There is at most one live operation per kind and file
// name. Starting another one cancels the previous one at once: its
// transaction is aborted if it has not committed, its connection is closed,
// and its promise rejects with Superseded. A timeout cancels the same way
// and rejects with StorageTimeout. Every stage (the open, creating the
// transaction, each request callback) checks that its operation is still
// live before acting, and a connection that opens late is closed unused.
// A transaction that has already committed cannot be undone: cancelling
// then only suppresses the stale result. (The store still records the rev
// it committed, so the tab's next save does not conflict with itself.)
// Each operation opens its own connection and closes it when the
// transaction ends, so no connection is held between operations (or across
// a page in the back/forward cache).
//
// The file is plain browser JavaScript (no modules), and also loads in Node
// for tests: createSaveStore takes the IndexedDB factory as a parameter.

(function (root) {
  "use strict";

  const DB_NAME = "web-frotz";
  const DB_VERSION = 1;
  const SAVES = "saves";
  const META = "meta";

  class StorageTimeout extends Error {
    constructor(what) {
      super(`${what} timed out`);
      this.name = "StorageTimeout";
    }
  }

  class Superseded extends Error {
    constructor(what) {
      super(`${what} was superseded`);
      this.name = "Superseded";
    }
  }

  // Hex SHA-256 of bytes, or null where Web Crypto is not available (pages
  // served over plain http from another host).
  async function sha256(bytes) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) return null;
    try {
      const d = new Uint8Array(await subtle.digest("SHA-256", bytes));
      return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      return null;
    }
  }

  function createSaveStore(idb, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 5000;
    const gens = new Map(); // "kind:name" -> latest generation
    const liveOps = new Map(); // "kind:name" -> cancel(err) of the live operation
    const seen = new Map(); // file name -> rev this tab last saw

    function nextGen(key) {
      const g = (gens.get(key) || 0) + 1;
      gens.set(key, g);
      return g;
    }

    function noteRev(name, rev) {
      if (!(seen.get(name) >= rev)) seen.set(name, rev);
    }

    // Run body(ctx) under a generation token and a timeout. ctx.live() is
    // false once the operation has been superseded or has timed out;
    // ctx.onCancel(fn) registers clean-up (abort, close) for that moment.
    function guarded(key, what, body) {
      const prev = liveOps.get(key);
      const gen = nextGen(key);
      let settled = false;
      const cancels = [];
      const ctx = {
        live: () => !settled && gens.get(key) === gen,
        onCancel: (fn) => cancels.push(fn),
      };
      let cancel;
      const p = new Promise((resolve, reject) => {
        const finish = (fn, v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (liveOps.get(key) === cancel) liveOps.delete(key);
          fn(v);
        };
        cancel = (err) => {
          if (settled) return;
          settled = true; // so every stage now sees !live()
          for (const fn of cancels) {
            try { fn(); } catch (e) { /* already finished */ }
          }
          settled = false;
          finish(reject, err);
        };
        const timer = setTimeout(() => cancel(new StorageTimeout(what)), timeoutMs);
        Promise.resolve()
          .then(() => body(ctx))
          .then(
            (v) => (ctx.live() ? finish(resolve, v) : cancel(new Superseded(what))),
            (e) => finish(reject, e));
      });
      liveOps.set(key, cancel);
      if (prev) prev(new Superseded(what));
      return p;
    }

    function open(ctx) {
      return new Promise((resolve, reject) => {
        if (!ctx.live()) {
          reject(new Superseded("open"));
          return;
        }
        let req;
        try {
          req = idb.open(DB_NAME, DB_VERSION);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES);
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        };
        req.onsuccess = () => {
          const db = req.result;
          // Another tab upgrading the database asks us to let go.
          db.onversionchange = () => db.close();
          if (!ctx.live()) {
            db.close(); // opened after the operation gave up
            reject(new Superseded("open"));
            return;
          }
          ctx.onCancel(() => db.close());
          resolve(db);
        };
        req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
        req.onblocked = () => { /* waits; the timeout covers it */ };
      });
    }

    // One transaction; resolves with body's result when it commits.
    // Request callbacks in body must check ctx.live() first.
    function transact(ctx, db, stores, mode, body) {
      return new Promise((resolve, reject) => {
        if (!ctx.live()) {
          db.close();
          reject(new Superseded("transaction"));
          return;
        }
        let tx;
        try {
          tx = db.transaction(stores, mode);
        } catch (e) {
          db.close();
          reject(e);
          return;
        }
        ctx.onCancel(() => tx.abort());
        let result;
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = () => { db.close(); reject(tx.error || new Superseded("transaction")); };
        tx.onerror = () => { /* followed by onabort */ };
        body(tx, (v) => { result = v; });
      });
    }

    // Requests inside a transaction use plain onsuccess callbacks, not
    // promises: older Safari let a transaction commit before promise
    // callbacks ran. An error aborts the transaction, which rejects.
    return {
      // [{ name, size, mtime, story, rev, sha256 }], newest first. A name
      // this tab has not seen before is recorded at its listed rev.
      list() {
        return guarded("list:", "Listing saves", async (ctx) => {
          const db = await open(ctx);
          const out = await transact(ctx, db, [META], "readonly", (tx, set) => {
            const acc = [];
            const cur = tx.objectStore(META).openCursor();
            cur.onsuccess = () => {
              if (!ctx.live()) return;
              const c = cur.result;
              if (!c) {
                acc.sort((a, b) => b.mtime - a.mtime);
                set(acc);
                return;
              }
              acc.push({ name: String(c.key), ...c.value });
              c.continue();
            };
          });
          for (const m of out) if (!seen.has(m.name)) seen.set(m.name, m.rev || 0);
          return out;
        });
      },

      // { bytes, mtime, story, rev } or null. Does not change the rev this
      // tab has seen: call adopt() once the bytes are in use.
      get(name, purpose) {
        const kind = purpose || "read";
        return guarded(`get-${kind}:${name}`, `Reading ${name}`, async (ctx) => {
          const db = await open(ctx);
          return transact(ctx, db, [SAVES], "readonly", (tx, set) => {
            const req = tx.objectStore(SAVES).get(name);
            req.onsuccess = () => {
              if (!ctx.live()) return;
              set(req.result || null);
            };
          });
        });
      },

      // This tab now holds the stored version `rev` of name (a restore
      // copied it into MEMFS), so its next save may replace it.
      adopt(name, rev) {
        seen.set(name, rev);
      },

      seenRev(name) {
        return seen.get(name) || 0;
      },

      // remove(name, { story, expectedRev }) resolves
      //   { outcome: "removed", rev, meta }   tombstone written
      //   { outcome: "none" }                  nothing stored under name
      //   { outcome: "conflict", theirs }      stored rev is not expectedRev
      // and rejects like put(). One readwrite transaction: the bytes record
      // is deleted and meta becomes a tombstone at rev + 1.
      remove(name, opts) {
        const o = opts || {};
        return guarded(`put:${name}`, `Deleting ${name}`, async (ctx) => {
          const db = await open(ctx);
          return transact(ctx, db, [SAVES, META], "readwrite", (tx, set) => {
            const meta = tx.objectStore(META);
            const req = meta.get(name);
            req.onsuccess = () => {
              if (!ctx.live()) return;
              const old = req.result || null;
              if (!old || old.deleted) {
                set({ outcome: "none" });
                return;
              }
              const have = old.rev || 0;
              const expected = o.expectedRev != null ? o.expectedRev : (seen.get(name) || 0);
              if (have !== expected) {
                set({ outcome: "conflict", theirs: old });
                return;
              }
              const rev = have + 1;
              const m = { size: 0, mtime: Date.now(), story: o.story || null, rev, sha256: null,
                deleted: true };
              tx.objectStore(SAVES).delete(name);
              meta.put(m, name);
              tx.addEventListener("complete", () => noteRev(name, rev));
              set({ outcome: "removed", rev, meta: m });
            };
          });
        });
      },

      // put(name, bytes, { mtime, story, expectedRev }) resolves
      //   { outcome: "persisted", rev, meta }   written (or already equal)
      //   { outcome: "conflict", theirs }        stored rev is not expectedRev
      // and rejects on failure, timeout (StorageTimeout) or supersession.
      // expectedRev defaults to the rev this tab last saw, read when the
      // transaction runs.
      put(name, bytes, opts) {
        const o = opts || {};
        const copy = new Uint8Array(bytes); // detached from the wasm heap
        return guarded(`put:${name}`, `Saving ${name}`, async (ctx) => {
          const hash = await sha256(copy);
          const db = await open(ctx);
          return transact(ctx, db, [SAVES, META], "readwrite", (tx, set) => {
            const meta = tx.objectStore(META);
            const req = meta.get(name);
            req.onsuccess = () => {
              if (!ctx.live()) return;
              const old = req.result || null;
              const have = old ? old.rev || 0 : 0;
              const expected = o.expectedRev != null ? o.expectedRev : (seen.get(name) || 0);
              if (have !== expected) {
                if (old && hash && old.sha256 === hash) {
                  // Same bytes as stored: nothing to lose either way.
                  tx.addEventListener("complete", () => noteRev(name, have));
                  set({ outcome: "persisted", rev: have, meta: old, unchanged: true });
                } else {
                  set({ outcome: "conflict", theirs: old });
                }
                return;
              }
              const rev = have + 1;
              const m = { size: copy.length, mtime: o.mtime || Date.now(), story: o.story || null,
                rev, sha256: hash };
              tx.objectStore(SAVES).put({ bytes: copy, mtime: m.mtime, story: m.story, rev }, name);
              meta.put(m, name);
              // Recorded on commit even if the result is suppressed by a
              // cancel that came too late to abort.
              tx.addEventListener("complete", () => noteRev(name, rev));
              set({ outcome: "persisted", rev, meta: m });
            };
          });
        });
      },
    };
  }

  const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

  // Replace path with bytes without ever leaving it half written: write a
  // sibling <path>.tmp, then rename it over path. On any failure the
  // previous file is untouched and the temporary file is removed.
  function writeAtomic(FS, path, bytes, mtime) {
    const tmp = `${path}.tmp`;
    try {
      FS.writeFile(tmp, bytes);
      if (mtime) FS.utime(tmp, mtime, mtime);
      FS.rename(tmp, path);
    } catch (e) {
      try { FS.unlink(tmp); } catch (e2) { /* never created */ }
      throw e;
    }
  }

  const SESSION_ONLY = "Saved for this session only, not to browser storage. Export it from Saves.";
  const conflictNotice = (name) =>
    `Another tab saved ${name} more recently. Your save is kept in this session only: ` +
    "Export it, or open Saves and choose Keep this one.";

  // The save state of one page: which MEMFS files are not in browser
  // storage and why, plus the last listing. Shared by app.js and glk.js.
  //
  //   opts.store     a save store, or null without IndexedDB
  //   opts.fs()      the Emscripten FS
  //   opts.dir       "/saves"
  //   opts.story()   the story file name recorded with each save
  //   opts.hidden(n) true for a name to leave out of entries() (optional)
  //   opts.onChange()  after anything entries() or attention() reports changes
  //   opts.log       console-like logger
  function createSaveSession(opts) {
    const store = opts.store;
    const log = opts.log || console;
    const dir = opts.dir;
    const unpersisted = new Map(); // name -> { reason: "conflict"|"failed"|"timeout" }
    const base = new Map(); // name -> stored rev the MEMFS copy equals
    let stored = []; // last list()
    const changed = () => { if (opts.onChange) opts.onChange(); };

    const exists = (path) => {
      try { return opts.fs().isFile(opts.fs().stat(path).mode); } catch (e) { return false; }
    };

    function noteStored(name, meta) {
      stored = stored.filter((s) => s.name !== name);
      if (meta) stored.push({ name, ...meta });
    }

    async function put(path, expectedRev) {
      const name = baseName(path);
      let r;
      try {
        if (!store) throw new Error("IndexedDB is not available");
        const FS = opts.fs();
        const bytes = FS.readFile(path);
        r = await store.put(name, bytes, { mtime: +FS.stat(path).mtime, story: opts.story(), expectedRev });
      } catch (e) {
        if (e instanceof Superseded) return { outcome: "superseded" }; // the newer one reports
        const outcome = e instanceof StorageTimeout ? "timeout" : "failed";
        log.warn(`could not write ${path} to IndexedDB`, e);
        unpersisted.set(name, { reason: outcome });
        changed();
        return { outcome, message: SESSION_ONLY };
      }
      if (r.outcome === "persisted") {
        unpersisted.delete(name);
        base.set(name, r.rev);
        noteStored(name, r.meta);
        changed();
        refresh();
        return { outcome: "persisted" };
      }
      log.warn(`${path}: another tab saved rev ${r.theirs && r.theirs.rev}; kept this save in memory`);
      unpersisted.set(name, { reason: "conflict" });
      noteStored(name, r.theirs);
      changed();
      refresh();
      return { outcome: "conflict", message: conflictNotice(name) };
    }

    // The game deleted path (already gone from MEMFS): delete it from
    // storage too. Resolves { outcome, message? }: "removed", "none",
    // "conflict" (another tab saved it since; the stored one is kept),
    // "failed", "timeout" or "superseded". Never rejects.
    async function remove(path) {
      const name = baseName(path);
      unpersisted.delete(name);
      base.delete(name);
      if (!store) { changed(); return { outcome: "none" }; }
      let r;
      try {
        r = await store.remove(name, { story: opts.story() });
      } catch (e) {
        if (e instanceof Superseded) return { outcome: "superseded" };
        const outcome = e instanceof StorageTimeout ? "timeout" : "failed";
        log.warn(`could not delete ${path} from IndexedDB`, e);
        changed();
        return { outcome, message: `Could not delete ${name} from browser storage; ` +
          "it may come back when the page is reloaded." };
      }
      if (r.outcome === "removed") noteStored(name, r.meta);
      changed();
      refresh();
      if (r.outcome === "conflict")
        return { outcome: "conflict", message: `Another tab saved ${name} more recently, ` +
          "so the stored copy was not deleted." };
      return { outcome: r.outcome };
    }

    async function refresh() {
      if (!store) return;
      try {
        stored = await store.list();
      } catch (e) {
        if (!(e instanceof Superseded)) log.warn("could not list saves", e);
        return;
      }
      changed();
    }

    return {
      // After the game wrote path: store it. Resolves { outcome, message? }
      // with outcome "persisted", "conflict", "failed", "timeout" or
      // "superseded" (a newer write of the same file took over). message
      // is the transcript notice, if any. Never rejects.
      persist: (path) => put(path),

      remove,

      // Store this tab's copy of name over the stored version listed now
      // (the one the player saw in the dialog). Conflicts again if another
      // tab has saved since.
      keepLocal(name) {
        const s = stored.find((x) => x.name === name);
        return put(`${dir}/${name}`, s ? s.rev || 0 : 0);
      },

      // Before the game reads path: bring the stored copy into MEMFS if
      // MEMFS lacks it or holds a different stored revision. A copy that
      // is not in storage (a save that failed or conflicted) is this tab's
      // own latest save and is kept. Resolves "copied", "same", "none",
      // "local" (kept the unpersisted copy) or "error" (storage could not
      // be read; MEMFS is unchanged). Never rejects.
      async load(path) {
        const name = baseName(path);
        if (!store) return "none";
        if (unpersisted.has(name) && exists(path)) return "local";
        let rec;
        try {
          rec = await store.get(name, "load");
        } catch (e) {
          log.warn(`could not read ${path} from IndexedDB`, e);
          return "error";
        }
        if (!rec) return "none";
        const rev = rec.rev || 0;
        if (exists(path) && base.get(name) === rev) return "same";
        try {
          writeAtomic(opts.fs(), path, rec.bytes, rec.mtime);
        } catch (e) {
          log.warn(`could not copy ${name} into memory`, e);
          return "error";
        }
        base.set(name, rev);
        store.adopt(name, rev);
        unpersisted.delete(name);
        changed();
        return "copied";
      },

      // Import: replace path with bytes (atomically; throws if MEMFS cannot
      // take it, leaving the old file), then persist it like a save. A
      // conflict is not possible to resolve silently here either.
      async importBytes(path, bytes) {
        writeAtomic(opts.fs(), path, bytes);
        return put(path);
      },

      refresh,

      // Rows for the Saves dialog. Each stored file has a "stored" row; a
      // MEMFS file gets a "local" row when it is not in storage (failed or
      // conflicted, or not stored at all). For a conflict both rows show.
      entries() {
        const hidden = opts.hidden || (() => false);
        const rows = [];
        const names = new Set();
        for (const s of stored) {
          if (s.deleted || hidden(s.name)) continue;
          names.add(s.name);
          rows.push({ name: s.name, where: "stored", mtime: s.mtime, size: s.size, rev: s.rev || 0 });
        }
        let FS = null;
        try { FS = opts.fs(); } catch (e) { /* no game yet */ }
        if (FS) {
          for (const n of FS.readdir(dir)) {
            if (n === "." || n === ".." || hidden(n)) continue;
            const st = FS.stat(`${dir}/${n}`);
            if (!FS.isFile(st.mode)) continue;
            const u = unpersisted.get(n);
            if (!u && names.has(n)) continue;
            rows.push({ name: n, where: "local", mtime: +st.mtime, size: st.size,
              reason: u ? u.reason : "not-stored" });
          }
        }
        return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 :
          a.where === b.where ? 0 : a.where === "stored" ? -1 : 1));
      },

      async exportBytes(row) {
        if (row.where === "local") return opts.fs().readFile(`${dir}/${row.name}`);
        const rec = await store.get(row.name, "export");
        if (!rec) throw new Error("not found");
        return rec.bytes;
      },

      // Names of files this tab saved that are not in browser storage. The
      // badge stays on while any remain; a later persisted save of the same
      // file clears it.
      attention() {
        return [...unpersisted.entries()].map(([name, u]) => ({ name, reason: u.reason }));
      },
    };
  }

  // ---- Saves dialog rendering, shared by app.js and glk.js ----

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

  // Fill ul with the session's rows. onMessage(text) reports an action's
  // result in the dialog.
  function renderSaveList(ul, session, onMessage) {
    ul.textContent = "";
    const rows = session.entries();
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No saves yet. Type SAVE in the game.";
      ul.appendChild(li);
    }
    for (const f of rows) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      const when = new Date(f.mtime).toLocaleString();
      if (f.where === "stored") {
        label.textContent = `${f.name} · ${when} · in browser storage`;
      } else {
        label.textContent = `${f.name} · ${when} · this tab only, not in browser storage` +
          (f.reason === "conflict" ? " (another tab saved a newer one)" : "");
        li.dataset.local = "";
      }
      const exp = document.createElement("button");
      exp.type = "button";
      exp.textContent = "Export";
      exp.addEventListener("click", async () => {
        try {
          download(f.name, await session.exportBytes(f));
        } catch (e) {
          console.warn("[saves] export", f.name, e);
          onMessage(`Could not read ${f.name}.`);
        }
      });
      li.append(label, exp);
      if (f.where === "local" && f.reason === "conflict") {
        const keep = document.createElement("button");
        keep.type = "button";
        keep.textContent = "Keep this one";
        keep.addEventListener("click", async () => {
          const r = await session.keepLocal(f.name);
          onMessage(r.outcome === "persisted" ? `Stored this tab's ${f.name} in browser storage.` :
            r.outcome === "conflict" ? `Another tab saved ${f.name} again. Nothing was replaced.` :
            `Could not write ${f.name} to browser storage.`);
        });
        li.append(keep);
      }
      ul.appendChild(li);
    }
  }

  // The Saves dialog note: what is not in storage, and why.
  function attentionText(session, hasStore) {
    const a = session.attention();
    const parts = [];
    const conflicts = a.filter((x) => x.reason === "conflict").map((x) => x.name);
    if (conflicts.length)
      parts.push(`Another tab saved a newer ${conflicts.join(", ")}. Both versions are listed: ` +
        "export either one, or Keep this one to store this tab's version instead.");
    if (a.some((x) => x.reason !== "conflict") || !hasStore)
      parts.push("A save could not be written to browser storage. It is kept only until " +
        "this page closes, so export it.");
    return parts.join(" ");
  }

  const api = {
    createSaveStore, createSaveSession, writeAtomic, renderSaveList, attentionText,
    StorageTimeout, Superseded, SESSION_ONLY, conflictNotice,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WebFrotzSaves = api;
})(typeof self !== "undefined" ? self : globalThis);
