// web/saves.js: per-file save storage in IndexedDB for Web Frotz.
//
// /saves in the interpreter is plain MEMFS. Nothing mirrors the whole
// directory. Each file is persisted on its own:
//
//   - after a successful SAVE, put(name, bytes, mtime) writes that one file
//     in one readwrite transaction;
//   - before a RESTORE, get(name) reads that one file, and app.js copies it
//     into MEMFS if MEMFS lacks it or the stored copy is newer;
//   - list() reads only the small "meta" records, for the Saves dialog.
//
// Database "web-frotz", version 1:
//   store "saves": key = file name, value = { bytes, mtime, story }
//   store "meta":  key = file name, value = { size, mtime, story }
// put() writes both in the same transaction, so they always agree.
//
// Conflicts between tabs: each file is decided on its own, and the copy
// with the later save time wins. put() reads the stored record inside its
// transaction and does not replace one with a later mtime. So a tab that
// loaded an old save can never overwrite another tab's newer save of the
// same file, and a save of one story never touches another story's file.
//
// Timeouts: every operation is a promise that settles within `timeoutMs`.
// Each one takes a generation number for its kind and file name; when it
// times out, or a later operation of the same kind on the same name starts,
// it is superseded. A
// superseded operation's late result is ignored, a superseded put() aborts
// its transaction if it is still running, and a connection that opens late
// is closed without being used. Each operation opens its own connection and
// closes it when the transaction ends, so no connection is held between
// operations (or across a page in the back/forward cache).
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

  function createSaveStore(idb, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 5000;
    const gens = new Map(); // "kind:name" -> latest generation

    function nextGen(key) {
      const g = (gens.get(key) || 0) + 1;
      gens.set(key, g);
      return g;
    }

    // Run body(ctx) under a generation token and a timeout. ctx.live() is
    // false once the operation has been superseded or has timed out;
    // ctx.onCancel(fn) registers clean-up (abort, close) for that moment.
    function guarded(key, what, body) {
      const gen = nextGen(key);
      let settled = false;
      const cancels = [];
      const ctx = {
        live: () => !settled && gens.get(key) === gen,
        onCancel: (fn) => cancels.push(fn),
      };
      return new Promise((resolve, reject) => {
        const finish = (fn, v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(v);
        };
        const cancel = (err) => {
          if (settled) return;
          for (const fn of cancels) {
            try { fn(); } catch (e) { /* already finished */ }
          }
          finish(reject, err);
        };
        const timer = setTimeout(() => cancel(new StorageTimeout(what)), timeoutMs);
        Promise.resolve()
          .then(() => body(ctx))
          .then(
            (v) => (gens.get(key) === gen ? finish(resolve, v) : cancel(new Superseded(what))),
            (e) => finish(reject, e));
      });
    }

    function open(ctx) {
      return new Promise((resolve, reject) => {
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
    function transact(ctx, db, stores, mode, body) {
      return new Promise((resolve, reject) => {
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
        tx.onabort = () => { db.close(); reject(tx.error || new Error("transaction aborted")); };
        tx.onerror = () => { /* followed by onabort */ };
        body(tx, (v) => { result = v; });
      });
    }

    // Requests inside a transaction use plain onsuccess callbacks, not
    // promises: older Safari let a transaction commit before promise
    // callbacks ran. An error aborts the transaction, which rejects.
    return {
      // [{ name, size, mtime, story }], newest first.
      list() {
        return guarded("list:", "Listing saves", async (ctx) => {
          const db = await open(ctx);
          return transact(ctx, db, [META], "readonly", (tx, set) => {
            const out = [];
            const cur = tx.objectStore(META).openCursor();
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) {
                out.sort((a, b) => b.mtime - a.mtime);
                set(out);
                return;
              }
              out.push({ name: String(c.key), ...c.value });
              c.continue();
            };
          });
        });
      },

      // { bytes, mtime, story } or null.
      get(name) {
        return guarded(`get:${name}`, `Reading ${name}`, async (ctx) => {
          const db = await open(ctx);
          return transact(ctx, db, [SAVES], "readonly", (tx, set) => {
            const req = tx.objectStore(SAVES).get(name);
            req.onsuccess = () => set(req.result || null);
          });
        });
      },

      // Resolves "written", or "kept-newer" if the store already holds a
      // copy saved later (another tab); rejects on failure or timeout.
      put(name, bytes, mtime, story) {
        return guarded(`put:${name}`, `Saving ${name}`, async (ctx) => {
          const db = await open(ctx);
          return transact(ctx, db, [SAVES, META], "readwrite", (tx, set) => {
            const meta = tx.objectStore(META);
            const req = meta.get(name);
            req.onsuccess = () => {
              const old = req.result;
              if (old && old.mtime > mtime) {
                set("kept-newer");
                return;
              }
              const copy = new Uint8Array(bytes); // detached from the wasm heap
              tx.objectStore(SAVES).put({ bytes: copy, mtime, story }, name);
              meta.put({ size: copy.length, mtime, story }, name);
              set("written");
            };
          });
        });
      },
    };
  }

  const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

  // Write one file from the Emscripten FS to the store. Resolves to put()'s
  // result; rejects if the file cannot be read or the write fails.
  async function persistFile(store, FS, path, story) {
    const bytes = FS.readFile(path);
    const mtime = +FS.stat(path).mtime;
    return store.put(baseName(path), bytes, mtime, story);
  }

  // Copy one file from the store into the Emscripten FS if the FS lacks it
  // or the stored copy is newer. Resolves to true if it copied; rejects if
  // the store cannot be read.
  async function loadFile(store, FS, path) {
    const rec = await store.get(baseName(path));
    if (!rec) return false;
    let local = -Infinity;
    try { local = +FS.stat(path).mtime; } catch (e) { /* not in the FS */ }
    if (!(rec.mtime > local)) return false;
    FS.writeFile(path, rec.bytes);
    FS.utime(path, rec.mtime, rec.mtime);
    return true;
  }

  const api = { createSaveStore, persistFile, loadFile, StorageTimeout, Superseded };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WebFrotzSaves = api;
})(typeof self !== "undefined" ? self : globalThis);
