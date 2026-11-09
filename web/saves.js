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
// One writer at a time (Web Locks). A page asks for the exclusive lock
// "webfrotz-saves" (both pages share the database, so they share the
// lock). The page that gets it holds it until it closes and is the only one
// that writes to browser storage. A page that does not get it is in
// session-only mode: its saves stay in MEMFS, a notice says another Frotz
// tab owns browser storage, RESTORE still reads stored files, and nothing
// is ever written. It keeps waiting for the lock in the background; when the
// owner closes, the waiting page takes it and starts persisting. A writer
// that loses the lock (stolen, or a conflict shows another page wrote)
// becomes session-only at once; a page leaving for the back/forward cache
// lets go of it and asks again when it comes back (createSaveSession has
// the details). Without Web Locks, or if the very first request fails,
// every page writes, and the revision checks below are all that stands
// between tabs ("unlocked" mode).
//
// Revisions. Each file's meta has `rev`, an integer that starts at 1 and
// goes up by one with every write. put() runs ONE readwrite transaction:
// it reads meta and, if the stored rev is not the one this tab expects,
// resolves { outcome: "conflict", theirs: meta } without writing anything;
// otherwise it writes bytes and meta with rev + 1. A missing record counts
// as rev 0. If the stored bytes already equal this tab's (same sha256),
// the save counts as persisted without a write. mtime is informational
// only. With a single writer a conflict only happens when the store was
// changed behind this tab's back (an old owner's write that was still in
// flight when it closed, or a tab without Web Locks); the check stays.
//
// The expected rev per file (the store's `seen` map) is a baseline that
// only moves for a reason this tab knows about:
//
//   unknown -> seen(rev) -> localDirty(rev) -> conflict(theirs.rev)
//
//   unknown       never set: counts as 0 (absent).
//   seen(rev)     set by snapshot(), once, when this page becomes the
//                 writer (or, unlocked, when it starts): every stored name
//                 at its rev, and every other name frozen at 0 (absent).
//                 list() and refresh() never change it.
//   localDirty    the game (or an import) wrote the file in MEMFS; put()
//                 expects the frozen rev. On commit, seen = the new rev.
//   conflict      the stored rev was not the frozen one. seen does NOT
//                 move: every plain save of that file conflicts again
//                 until the player resolves it, by RESTORE (adopt(): seen =
//                 the stored rev, whose bytes are now in MEMFS) or by Keep
//                 this one (put with expectedRev = theirs.rev, which
//                 commits theirs.rev + 1).
//
// Deletion (remove()) leaves a tombstone: the bytes record goes, and meta
// keeps the name with { deleted: true } and the next rev. get() then finds
// nothing, list() reports the tombstone (sessions leave it out of the
// Saves dialog), and a stale tab that saves the old version afterwards gets
// a conflict like any other, instead of bringing the file back unnoticed.
// Another tab that holds a clean copy of the file in its own MEMFS removes
// it the next time the game opens the file or asks whether it exists (see
// load() in createSaveSession), so the deletion holds there too.
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
// Replacing a MEMFS file (import, or a RESTORE copying a stored file in)
// writes a temporary file and renames it over the target. The temporary
// name is ".webfrotz-tmp-<random hex>-<name>" in the same directory,
// created exclusively (O_EXCL; a new random name on collision), so it can
// never be a file the game owns (a game may well have "foo.sav.tmp"). Only
// the file this operation created is ever removed. Such names are left out
// of the Saves dialog, and the C side never gives a game one.
//
// The file is plain browser JavaScript (no modules), and also loads in Node
// for tests: createSaveStore takes the IndexedDB factory as a parameter,
// and createSaveSession takes the lock manager (navigator.locks).

(function (root) {
  "use strict";

  const DB_NAME = "web-frotz";
  const DB_VERSION = 1;
  const SAVES = "saves";
  const META = "meta";
  const LOCK_NAME = "webfrotz-saves";
  const TMP_PREFIX = ".webfrotz-tmp-";

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

  // A write this page may no longer make: it lost (or let go of) the lock
  // before the write reached storage. Nothing was written.
  class Revoked extends Error {
    constructor(what) {
      super(`${what} was abandoned: this tab no longer writes to browser storage`);
      this.name = "Revoked";
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
    const seen = new Map(); // file name -> expected rev (the frozen baseline)

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

    // All meta records, newest first.
    async function listMeta(ctx) {
      const db = await open(ctx);
      return transact(ctx, db, [META], "readonly", (tx, set) => {
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
    }

    // Requests inside a transaction use plain onsuccess callbacks, not
    // promises: older Safari let a transaction commit before promise
    // callbacks ran. An error aborts the transaction, which rejects.
    return {
      // [{ name, size, mtime, story, rev, sha256 }], newest first. Does not
      // change any expected rev (see the state machine above).
      list() {
        return guarded("list:", "Listing saves", (ctx) => listMeta(ctx));
      },

      // Set the baseline from what is stored now: every listed name at its
      // rev, every other name absent (0). Called once when this page
      // becomes the writer. Resolves with the listing.
      snapshot() {
        return guarded("snapshot:", "Reading saves", async (ctx) => {
          const out = await listMeta(ctx);
          seen.clear();
          for (const m of out) seen.set(m.name, m.rev || 0);
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

      // { rec, meta } for name, read in one transaction: rec as get()
      // returns it, meta the file's meta record (a tombstone after a
      // delete) or null. Does not change the rev this tab has seen.
      lookup(name, purpose) {
        const kind = purpose || "read";
        return guarded(`get-${kind}:${name}`, `Reading ${name}`, async (ctx) => {
          const db = await open(ctx);
          return transact(ctx, db, [SAVES, META], "readonly", (tx, set) => {
            const out = { rec: null, meta: null };
            let left = 2;
            const done = () => { if (--left === 0) set(out); };
            const r1 = tx.objectStore(SAVES).get(name);
            r1.onsuccess = () => {
              if (!ctx.live()) return;
              out.rec = r1.result || null;
              done();
            };
            const r2 = tx.objectStore(META).get(name);
            r2.onsuccess = () => {
              if (!ctx.live()) return;
              out.meta = r2.result || null;
              done();
            };
          });
        });
      },

      // This tab now holds the stored version `rev` of name (a restore
      // copied it into MEMFS), so its next save may replace it. The only
      // way, besides this tab's own commits and snapshot(), that the
      // baseline moves.
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
      // and rejects like put() (allowed() too). One readwrite transaction: the bytes record
      // is deleted and meta becomes a tombstone at rev + 1.
      remove(name, opts) {
        const o = opts || {};
        return guarded(`put:${name}`, `Deleting ${name}`, async (ctx) => {
          const allowed = () => !o.allowed || o.allowed();
          if (!allowed()) throw new Revoked(`Deleting ${name}`);
          const db = await open(ctx);
          let revoked = false;
          return transact(ctx, db, [SAVES, META], "readwrite", (tx, set) => {
            const meta = tx.objectStore(META);
            const req = meta.get(name);
            req.onsuccess = () => {
              if (!ctx.live()) return;
              if (!allowed()) { revoked = true; tx.abort(); return; }
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
          }).catch((e) => { throw revoked ? new Revoked(`Deleting ${name}`) : e; });
        });
      },

      // put(name, bytes, { mtime, story, expectedRev, allowed }) resolves
      //   { outcome: "persisted", rev, meta }   written (or already equal)
      //   { outcome: "conflict", theirs }        stored rev is not expectedRev
      // and rejects on failure, timeout (StorageTimeout), supersession, or
      // Revoked when allowed() (optional) is false before the write or in
      // the transaction's callback, which then writes nothing.
      // expectedRev defaults to the frozen baseline (0 if never set), read
      // when the transaction runs.
      put(name, bytes, opts) {
        const o = opts || {};
        const copy = new Uint8Array(bytes); // detached from the wasm heap
        return guarded(`put:${name}`, `Saving ${name}`, async (ctx) => {
          const allowed = () => !o.allowed || o.allowed();
          const hash = await sha256(copy);
          if (!allowed()) throw new Revoked(`Saving ${name}`);
          const db = await open(ctx);
          let revoked = false;
          return transact(ctx, db, [SAVES, META], "readwrite", (tx, set) => {
            const meta = tx.objectStore(META);
            const req = meta.get(name);
            req.onsuccess = () => {
              if (!ctx.live()) return;
              // Checked in the same callback that writes: once the session
              // stops writing, no write is issued, even from an open
              // transaction.
              if (!allowed()) { revoked = true; tx.abort(); return; }
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
          }).catch((e) => { throw revoked ? new Revoked(`Saving ${name}`) : e; });
        });
      },

      // Cancel every write and delete still in progress: a transaction
      // that has not committed is aborted, and each one rejects with
      // Revoked. Used when the page stops being the writer.
      abandon(why) {
        for (const [key, cancel] of [...liveOps])
          if (key.startsWith("put:")) cancel(new Revoked(why || "Saving"));
      },
    };
  }

  const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

  function randomHex() {
    const b = new Uint8Array(8);
    const c = root.crypto;
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0;
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  const isTempName = (name) => name.startsWith(TMP_PREFIX);

  // O_WRONLY | O_CREAT | O_EXCL (Emscripten's musl values). FS.open has no
  // string mode for an exclusive create.
  const O_CREATE_EXCL = 1 | 64 | 128;

  // Replace path with bytes without ever leaving it half written: create a
  // new temporary file ".webfrotz-tmp-<hex>-<name>" next to it exclusively
  // (another random name if one exists), write it, then rename it over
  // path. On any failure the previous file is untouched and only the
  // temporary file this call created is removed; nothing that existed
  // before is ever written or unlinked.
  function writeAtomic(FS, path, bytes, mtime) {
    const slash = path.lastIndexOf("/");
    const dir = path.slice(0, slash);
    const name = path.slice(slash + 1);
    const present = (p) => { try { FS.lstat(p); return true; } catch (e) { return false; } };
    let tmp = null;
    let stream = null;
    for (let i = 0; i < 16 && !stream; i++) {
      const t = `${dir}/${TMP_PREFIX}${randomHex()}-${name}`;
      try {
        stream = FS.open(t, O_CREATE_EXCL, 0o666);
        tmp = t;
      } catch (e) {
        if (!present(t)) throw e; // not a collision
      }
    }
    if (!stream) throw new Error(`could not create a temporary file for ${name}`);
    try {
      FS.write(stream, bytes, 0, bytes.length, 0);
      FS.close(stream);
      stream = null;
      if (mtime) FS.utime(tmp, mtime, mtime);
      FS.rename(tmp, path);
    } catch (e) {
      if (stream) { try { FS.close(stream); } catch (e2) { /* already closed */ } }
      try { FS.unlink(tmp); } catch (e2) { /* renamed or gone */ }
      throw e;
    }
  }

  const SESSION_ONLY = "Saved for this session only, not to browser storage. Export it from Saves.";
  const NOT_OWNER = "Another Frotz tab owns browser storage; saves here are kept for this " +
    "session only. Export any you need.";
  const LOST_OWNER = "This tab no longer owns browser storage: another Frotz tab took it over " +
    "or wrote to it. Saves here are kept for this session only. Export any you need, or reload " +
    "the page to try again.";
  const NOW_OWNER = "This tab now saves to browser storage. Saves made here earlier are still " +
    "for this session only: save again, or open Saves and choose Keep this one.";
  const conflictNotice = (name) =>
    `Another tab saved ${name} more recently. Your save is kept in this session only: ` +
    "Export it, or open Saves and choose Keep this one.";

  // The save state of one page: which MEMFS files are not in browser
  // storage and why, plus the last listing. Shared by app.js and glk.js.
  //
  //   opts.store     a save store, or null without IndexedDB
  //   opts.locks     navigator.locks, or null without Web Locks
  //   opts.events    window, for pagehide/pageshow (optional)
  //   opts.fs()      the Emscripten FS
  //   opts.dir       "/saves"
  //   opts.story()   the story file name recorded with each save
  //   opts.hidden(n) true for a name to leave out of entries() (optional)
  //   opts.onChange()  after anything entries() or attention() reports changes
  //   opts.onMode(mode, previous)  after mode() settles on a new value
  //                  (previous is the last settled mode; "pending" is never
  //                  reported) (optional)
  //   opts.log       console-like logger
  //
  // mode() is "pending" (the lock request has not answered yet, or the page
  // is hidden), "writer" (this page holds the lock and persists), "reader"
  // (session-only: another page holds the lock, or this page lost it),
  // "unlocked" (no Web Locks: persists, revisions only) or "none" (no
  // IndexedDB).
  //
  // Pending local writes. Every local write of a file (a game save, an
  // import, Keep this one, a game delete) gives that file a new local
  // generation and marks it dirty, synchronously, in the same turn as the
  // MEMFS change and before anything is awaited. A dirty file's MEMFS state
  // is newer than anything this tab knows to be stored, so load() (RESTORE)
  // never replaces it. Only the operation that still owns the file's
  // current generation may settle it: a persisted write clears the dirty
  // mark and sets the file's stored base revision; a failure, timeout,
  // conflict or session-only outcome keeps the dirty mark and the local
  // bytes and shows the reason. An operation overtaken by a newer local
  // write changes nothing about the file and reports "superseded".
  //
  // Ownership. Writing needs the lock to be held now, not just once:
  //   - the initial request failing, or no Web Locks at all, before any
  //     grant: "unlocked" (every tab writes, revisions only);
  //   - after a grant, losing it (the request rejects, e.g. another page
  //     asked with steal: true), or a revision conflict proving another
  //     page wrote: "reader" with LOST_OWNER, for the rest of the page's
  //     life (a reload, or a return from the back/forward cache, asks
  //     again). Writes still in progress are abandoned (aborted where not
  //     committed) and their files keep the dirty mark and a "session"
  //     badge; every write also re-checks ownership in the transaction
  //     callback that would write;
  //   - a queued request that rejects leaves the page a reader.
  // pagehide revokes writing first, abandons writes in progress (dirty
  // marks kept), aborts a queued request (AbortSignal) and then releases
  // the lock. pageshow with persisted === true asks again, and a page that
  // gets the lock takes a fresh snapshot before it writes.
  function createSaveSession(opts) {
    const store = opts.store;
    const log = opts.log || console;
    const dir = opts.dir;
    const unpersisted = new Map(); // name -> { reason: "conflict"|"failed"|"timeout"|"session" }
    const base = new Map(); // name -> stored rev the MEMFS copy equals (when clean)
    const dirty = new Map(); // name -> { g, del } local generation not known to be stored
    const lastGen = new Map(); // name -> latest local generation (never cleared)
    let genSeq = 0;
    let stored = []; // last list()
    // "pending" from the start, so construction never calls back (the
    // page's callbacks may refer to the session it is still creating).
    let mode = store ? "pending" : "none";
    let settled = "none"; // last mode reported to onMode
    let lost = false; // lost the lock after a grant: the reader notice is LOST_OWNER
    let epoch = 0; // bumped by every grant and every loss of writing rights
    let release = null; // lets go of the held lock
    let queued = null; // AbortController of the queued request
    let hidden = false; // between pagehide and pageshow
    const changed = () => { if (opts.onChange) opts.onChange(); };

    const exists = (path) => {
      try { return opts.fs().isFile(opts.fs().stat(path).mode); } catch (e) { return false; }
    };
    // A local write of name (del: a delete): new generation, dirty.
    // Synchronous.
    const touch = (name, del) => {
      const g = ++genSeq;
      dirty.set(name, { g, del: !!del });
      lastGen.set(name, g);
      return g;
    };
    const owns = (name, g) => { const d = dirty.get(name); return !!d && d.g === g; };
    // load() must keep MEMFS as it is: a dirty file that is there, or a
    // dirty delete. (A dirty file that has vanished from MEMFS some other
    // way has nothing left to protect.)
    const holdsLocal = (name, path) => {
      const d = dirty.get(name);
      return !!d && (d.del || exists(path));
    };
    const writes = () => mode === "writer" || mode === "unlocked";
    const notice = () => (lost ? LOST_OWNER : NOT_OWNER);

    function setMode(m) {
      if (mode === m) return;
      mode = m;
      if (m !== "pending" && m !== settled) {
        const prev = settled;
        settled = m;
        if (opts.onMode) opts.onMode(m, prev);
      }
      changed();
    }

    // Becoming a writer: freeze the baseline first, so no write ever runs
    // against a guessed rev. A failed snapshot leaves every name at 0, so
    // a save of an existing stored file conflicts (safe) rather than
    // overwriting it. Does nothing if the grant was lost meanwhile.
    async function becomeWriter(m, ep) {
      let snap = null;
      try {
        snap = await store.snapshot();
      } catch (e) {
        log.warn("could not read the saves in browser storage", e);
      }
      if (ep !== epoch) return;
      if (snap) stored = snap;
      setMode(m);
    }

    // Stop writing at once: abandon writes in progress and let go of the
    // lock. why: "lost" (stolen, or a conflict) or "hidden" (pagehide).
    function revoke(why) {
      epoch++;
      if (why === "lost") lost = true;
      setMode(why === "hidden" ? "pending" : "reader");
      store.abandon(why === "lost" ? "Lost browser storage" : "Page hidden");
      if (release) { const r = release; release = null; r(); }
      if (queued) { const q = queued; queued = null; try { q.abort(); } catch (e) { /* done */ } }
    }

    // Hold the lock just granted (epoch ep) until release() or the page
    // goes away.
    function holdLock() {
      return new Promise((resolve) => { release = resolve; });
    }

    // Ask for the lock. Resolves once mode() is no longer "pending".
    function acquire() {
      const locks = opts.locks;
      setMode("pending"); // already "pending" at construction: no callback
      if (!locks || typeof locks.request !== "function") return becomeWriter("unlocked", epoch);
      lost = false;
      return new Promise((resolve) => {
        let answered = false;
        let granted = false;
        const answer = () => { if (!answered) { answered = true; resolve(); } };
        let req;
        try {
          req = locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async (lock) => {
            if (lock) {
              if (hidden) return null; // hidden before the grant arrived: let go
              granted = true;
              const ep = ++epoch;
              const held = holdLock();
              await becomeWriter("writer", ep);
              answer();
              return held;
            }
            setMode("reader");
            answer();
            wait();
            return null;
          });
        } catch (e) {
          req = Promise.reject(e);
        }
        Promise.resolve(req).then(() => answer(), (e) => {
          if (!granted) {
            // The API is there but the first request failed: no grant was
            // ever made, so fall back to revisions only.
            log.warn("Web Locks unavailable; every tab writes to browser storage", e);
            becomeWriter("unlocked", epoch).then(answer);
            return;
          }
          // Lost after the grant (stolen, perhaps during the snapshot).
          log.warn("lost the browser storage lock", e);
          if (writes() || mode === "pending") revoke("lost");
          answer();
        });
      });
    }

    // A reader waits in line; granted when the owner lets go.
    function wait() {
      const locks = opts.locks;
      const ac = typeof AbortController === "function" ? new AbortController() : null;
      queued = ac;
      let granted = false;
      Promise.resolve()
        .then(() => locks.request(LOCK_NAME, ac ? { mode: "exclusive", signal: ac.signal } :
          { mode: "exclusive" }, async () => {
          if (queued === ac) queued = null;
          if (hidden || lost || mode !== "reader") return null;
          granted = true;
          const ep = ++epoch;
          const held = holdLock();
          await becomeWriter("writer", ep);
          return held;
        }))
        .catch((e) => {
          if (queued === ac) queued = null;
          if (ac && ac.signal.aborted && !granted) return; // aborted by revoke()
          if (granted) {
            log.warn("lost the browser storage lock", e);
            if (writes() || mode === "pending") revoke("lost");
            return;
          }
          // The queued request failed: stay a reader, with the notice.
          log.warn("waiting for browser storage failed; this tab stays session-only", e);
        });
    }

    let ready = store ? acquire() : Promise.resolve();

    if (store && opts.events && opts.locks && typeof opts.locks.request === "function") {
      opts.events.addEventListener("pagehide", () => {
        if (mode === "unlocked" || mode === "none") return; // no lock to give back
        hidden = true;
        revoke("hidden");
      });
      opts.events.addEventListener("pageshow", (ev) => {
        if (!ev || !ev.persisted || !hidden) return;
        hidden = false;
        ready = acquire();
      });
    }

    function noteStored(name, meta) {
      stored = stored.filter((s) => s.name !== name);
      if (meta) stored.push({ name, ...meta });
    }

    // Store path, the local generation g of name. Never rejects.
    async function put(path, name, g, expectedRev) {
      let r;
      try {
        if (!store) throw new Error("IndexedDB is not available");
        await ready;
        if (!owns(name, g)) return { outcome: "superseded" };
        if (!writes()) {
          unpersisted.set(name, { reason: "session" });
          changed();
          return { outcome: "session", message: notice() };
        }
        const epNow = epoch;
        const FS = opts.fs();
        const bytes = FS.readFile(path);
        // Still the writer of the same grant, and still the latest local
        // write of the file, at the moment the transaction would write.
        r = await store.put(name, bytes, { mtime: +FS.stat(path).mtime, story: opts.story(),
          expectedRev, allowed: () => writes() && epoch === epNow && owns(name, g) });
      } catch (e) {
        if (!owns(name, g)) return { outcome: "superseded" }; // the newer one reports
        if (e instanceof Revoked || (e instanceof Superseded && !writes())) {
          unpersisted.set(name, { reason: "session" });
          changed();
          return { outcome: "session", message: notice() };
        }
        const outcome = e instanceof StorageTimeout ? "timeout" : "failed";
        log.warn(`could not write ${path} to IndexedDB`, e);
        unpersisted.set(name, { reason: outcome });
        changed();
        return { outcome, message: SESSION_ONLY };
      }
      if (r.outcome === "persisted") {
        noteStored(name, r.meta);
        if (!owns(name, g)) { changed(); return { outcome: "superseded" }; }
        dirty.delete(name);
        unpersisted.delete(name);
        base.set(name, r.rev);
        changed();
        refresh();
        return { outcome: "persisted" };
      }
      log.warn(`${path}: browser storage has rev ${r.theirs && r.theirs.rev}, not the one this ` +
        "tab expected; kept this save in memory");
      noteStored(name, r.theirs);
      if (!owns(name, g)) { changed(); return { outcome: "superseded" }; }
      unpersisted.set(name, { reason: "conflict" });
      // Another page wrote: this one is not the only writer any more.
      if (mode === "writer") revoke("lost");
      changed();
      refresh();
      return { outcome: "conflict", message: conflictNotice(name) };
    }

    // The game deleted path (already gone from MEMFS): delete it from
    // storage too. Resolves { outcome, message? }: "removed", "none",
    // "conflict" (the stored one changed behind this tab; it is kept),
    // "session" (not the writer: deleted here only), "failed", "timeout" or
    // "superseded". Never rejects. Until it settles, and after a failure or
    // a session-only delete, the name stays dirty, so a RESTORE does not
    // bring the stored copy back. After a removal, "none" or a conflict it
    // is clean again (a conflict leaves the other tab's copy to RESTORE).
    async function remove(path) {
      const name = baseName(path);
      const g = touch(name, true);
      unpersisted.delete(name);
      base.delete(name);
      changed();
      if (!store) { dirty.delete(name); return { outcome: "none" }; }
      await ready;
      if (!owns(name, g)) return { outcome: "superseded" };
      if (!writes()) {
        return { outcome: "session", message: `Deleted ${name} in this session only: another ` +
          "Frotz tab owns browser storage." };
      }
      const epNow = epoch;
      let r;
      try {
        r = await store.remove(name, { story: opts.story(),
          allowed: () => writes() && epoch === epNow && owns(name, g) });
      } catch (e) {
        if (!owns(name, g)) return { outcome: "superseded" };
        if (e instanceof Revoked || (e instanceof Superseded && !writes())) {
          changed();
          return { outcome: "session", message: `Deleted ${name} in this session only: this ` +
            "tab no longer owns browser storage." };
        }
        const outcome = e instanceof StorageTimeout ? "timeout" : "failed";
        log.warn(`could not delete ${path} from IndexedDB`, e);
        changed();
        return { outcome, message: `Could not delete ${name} from browser storage; ` +
          "it may come back when the page is reloaded." };
      }
      if (r.outcome === "removed") noteStored(name, r.meta);
      if (!owns(name, g)) { changed(); return { outcome: "superseded" }; }
      dirty.delete(name);
      if (r.outcome === "conflict" && mode === "writer") revoke("lost");
      changed();
      refresh();
      if (r.outcome === "conflict")
        return { outcome: "conflict", message: `Another tab saved ${name} more recently, ` +
          "so the stored copy was not deleted." };
      return { outcome: r.outcome };
    }

    // Re-read the listing for the dialog. Never moves a baseline.
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
      get ready() { return ready; },
      mode: () => mode,

      // True while saves here cannot reach browser storage at all (another
      // tab is the writer, or there is no IndexedDB).
      sessionOnly: () => mode === "reader" || mode === "none",

      // True when Keep this one can store this tab's copy.
      canWrite: writes,

      // The persistent session-only notice for a reader.
      notice,

      // True while a local write of name is not known to be in storage.
      isDirty: (name) => dirty.has(name),

      // After the game wrote path: store it. Resolves { outcome, message? }
      // with outcome "persisted", "conflict", "session" (not the writer),
      // "failed", "timeout" or "superseded" (a newer local write of the
      // same file took over). message is the transcript notice, if any.
      // Never rejects. The file is marked dirty before this returns.
      persist(path) {
        const name = baseName(path);
        return put(path, name, touch(name));
      },

      remove,

      // Store this tab's copy of name over the stored version listed now
      // (the one the player saw in the dialog): the explicit resolution of
      // a conflict, or of a session-only save once this tab is the writer.
      // Conflicts again if the store has changed since.
      keepLocal(name) {
        const s = stored.find((x) => x.name === name);
        return put(`${dir}/${name}`, name, touch(name), s ? s.rev || 0 : 0);
      },

      // Before the game reads path (or asks whether it exists): bring the
      // stored copy into MEMFS if MEMFS lacks it or holds a different
      // stored revision. A dirty file (any local write, save, import, Keep
      // this one or delete, not known to be stored: in progress, failed,
      // conflicted or session-only) is this tab's own latest state and is
      // never replaced, nor brought back if deleted. So is any local write
      // that happens while storage is being read: the stored result is
      // then discarded.
      //
      // If storage has nothing under the name (another tab deleted it,
      // leaving a tombstone, or the record is gone) and this tab's copy is
      // clean, i.e. exactly a stored revision this tab read or wrote, the
      // copy is removed from MEMFS too: the deletion holds in every tab,
      // and the game sees the file as gone. This tab's baseline moves to
      // the tombstone's rev (0 with no record), so a new save of the name
      // is not a conflict with a deletion it has already seen.
      //
      // Resolves "copied", "same", "none", "deleted" (the clean copy was
      // removed), "local" (kept this tab's copy) or "error" (storage could
      // not be read; MEMFS is unchanged). Never rejects.
      async load(path) {
        const name = baseName(path);
        if (!store) return "none";
        if (holdsLocal(name, path)) return exists(path) ? "local" : "none";
        const before = lastGen.get(name) || 0;
        let rec, meta;
        try {
          ({ rec, meta } = await store.lookup(name, "load"));
        } catch (e) {
          log.warn(`could not read ${path} from IndexedDB`, e);
          return "error";
        }
        // No await from here on: nothing can change MEMFS in between.
        if ((lastGen.get(name) || 0) !== before || holdsLocal(name, path)) {
          log.warn(`${path} changed in this tab while browser storage was read; ` +
            "kept this tab's copy");
          return exists(path) ? "local" : "none";
        }
        if (!rec) {
          if (!exists(path) || !base.has(name) || dirty.has(name)) return "none";
          // Clean: not dirty (checked above, again after the read), and
          // equal to stored revision base.get(name).
          try {
            opts.fs().unlink(path);
          } catch (e) {
            log.warn(`could not remove ${name}, deleted in another tab, from memory`, e);
            return "error";
          }
          base.delete(name);
          store.adopt(name, meta ? meta.rev || 0 : 0);
          noteStored(name, meta);
          changed();
          return "deleted";
        }
        const rev = rec.rev || 0;
        if (exists(path) && base.get(name) === rev && !dirty.has(name)) return "same";
        try {
          writeAtomic(opts.fs(), path, rec.bytes, rec.mtime);
        } catch (e) {
          log.warn(`could not copy ${name} into memory`, e);
          return "error";
        }
        base.set(name, rev);
        store.adopt(name, rev);
        dirty.delete(name); // its local copy was gone: the stored one replaces it
        unpersisted.delete(name);
        changed();
        return "copied";
      },

      // Import: replace path with bytes (atomically; throws if MEMFS cannot
      // take it, leaving the old file and its state), then persist it like
      // a save. The replacement and the dirty mark happen in the same
      // synchronous step, before anything is awaited.
      importBytes(path, bytes) {
        const name = baseName(path);
        try {
          writeAtomic(opts.fs(), path, bytes);
        } catch (e) {
          return Promise.reject(e);
        }
        return put(path, name, touch(name));
      },

      refresh,

      // Rows for the Saves dialog. Each stored file has a "stored" row; a
      // MEMFS file gets a "local" row when it is not in storage (failed,
      // conflicted or session-only, or not stored at all). For a conflict
      // both rows show. Temporary files are never listed.
      entries() {
        const hide = (n) => isTempName(n) || (opts.hidden ? opts.hidden(n) : false);
        const rows = [];
        const names = new Set();
        for (const s of stored) {
          if (s.deleted || hide(s.name)) continue;
          names.add(s.name);
          rows.push({ name: s.name, where: "stored", mtime: s.mtime, size: s.size, rev: s.rev || 0 });
        }
        let FS = null;
        try { FS = opts.fs(); } catch (e) { /* no game yet */ }
        if (FS) {
          for (const n of FS.readdir(dir)) {
            if (n === "." || n === ".." || hide(n)) continue;
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
      // badge stays on while any remain (or while sessionOnly()); a later
      // persisted save of the same file clears it.
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
          (f.reason === "conflict" ? " (another tab saved a newer one)" :
            f.reason === "session" ? " (another tab owned browser storage)" : "");
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
      if (f.where === "local" && (f.reason === "conflict" || f.reason === "session") &&
          session.canWrite()) {
        const keep = document.createElement("button");
        keep.type = "button";
        keep.textContent = "Keep this one";
        keep.addEventListener("click", async () => {
          const r = await session.keepLocal(f.name);
          onMessage(r.outcome === "persisted" ? `Stored this tab's ${f.name} in browser storage.` :
            r.outcome === "conflict" ? `Another tab saved ${f.name} again. Nothing was replaced.` :
            r.outcome === "session" ? r.message || session.notice() :
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
    if (session.mode() === "reader") parts.push(session.notice());
    const conflicts = a.filter((x) => x.reason === "conflict").map((x) => x.name);
    if (session.mode() !== "reader" && a.some((x) => x.reason === "session"))
      parts.push("Saves made while another tab owned browser storage are still in this tab " +
        "only: save again, or Keep this one.");
    if (conflicts.length)
      parts.push(`Another tab saved a newer ${conflicts.join(", ")}. Both versions are listed: ` +
        "export either one, or Keep this one to store this tab's version instead.");
    if (a.some((x) => x.reason !== "conflict" && x.reason !== "session") || !hasStore)
      parts.push("A save could not be written to browser storage. It is kept only until " +
        "this page closes, so export it.");
    return parts.join(" ");
  }

  const api = {
    createSaveStore, createSaveSession, writeAtomic, renderSaveList, attentionText,
    StorageTimeout, Superseded, Revoked, SESSION_ONLY, NOT_OWNER, LOST_OWNER, NOW_OWNER,
    conflictNotice,
    LOCK_NAME, TMP_PREFIX, isTempName,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WebFrotzSaves = api;
})(typeof self !== "undefined" ? self : globalThis);
