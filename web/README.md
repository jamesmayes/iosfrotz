# Web Frotz

Interactive fiction in the browser, from this repo's interpreters compiled unmodified to WebAssembly with emscripten: **Frotz** (`frotz/common`) for Z-code and **git** (`git/`) for Glulx. One start page (`index.html`) plays both; a small browser OS layer (`src/web_os.c`) sits under Frotz and a browser Glk library (`glk/`) under git, with a plain HTML/JS front end and no framework or npm.

Contents: **Play** · **Deploy** · **Develop** · **Status** · **Architecture**.

## Play

`make serve` (from `web/`) and open <http://127.0.0.1:8000/>. The page needs HTTP; `file://` does not work.

- **The catalogue** (`games/stories.json`) lists the bundled stories, Z-code and Glulx together. Picking one sets the URL hash, for example `#story=Balances` (the file name without its extension; the parameter and the name are both case-insensitive), so a link opens that story directly. Old `glulx.html#story=…` links redirect to the same story on `index.html`.
- **Open a story file…** plays a file from the device: Z-code (`.z3`–`.z8`, `.zblorb`, `.zlb`) or Glulx (`.ulx`, `.gblorb`, `.blb`). Nothing is uploaded. The format is read from the file's bytes, not its name, and anything that is neither is refused with a message. A local file cannot be linked to, so the hash is cleared.
- **Stories** goes back to the catalogue (it reloads the page: a story is loaded once per WebAssembly instance). **Saves** lists, exports and imports saves (see "Save store").
- Type commands in the bar at the bottom. On iOS the bar stays docked above the keyboard. "Add to Home Screen" installs it as a web app, which also keeps Safari from deleting its saves after 7 days without a visit.

Bundled: *Balances* (Graham Nelson, Z-code) and *Glulxercise* (Andrew Plotkin's Glulx interpreter unit test; type `all`). See "Licence policy" for why the catalogue is this short.

## Deploy

```sh
cd web
make dist       # -> dist-site/, the whole static site (about 1.3 MB)
make serve      # make dist, then serve dist-site/ on 127.0.0.1:8000
```

`dist-site/` holds exactly what a static host needs: the start page, the `glulx.html` redirect, manifest, icon, the catalogue with the stories it lists and `games/LICENSES.md`, and in `assets/` the scripts and both interpreters (`.js` and `.wasm`) under content-hashed names, so they can be cached for good while `index.html` is revalidated. It is ignored by git. [`deploy/README.md`](deploy/README.md) lists the headers a host should send (`application/wasm`, `application/manifest+json`, long caching for `assets/`, no COOP/COEP) and how to publish on GitHub Pages.

## Develop

Requires emscripten (`emcc`, tested with 7.0.0 from Homebrew), Node (for `make check` and `make dist`; tested with 22) and Python 3 (for serving). Nothing is installed from npm.

```sh
cd web
make            # both interpreters
make frotz      # -> dist/frotz.js (~63 KB) + dist/frotz.wasm (~145 KB)
make git        # -> dist/git.js (~71 KB) + dist/git.wasm (~265 KB)
make bench      # -> dist/bench/git-{async,sync}.{js,wasm}, Node builds for the measurement
make check      # the checks below; must stay green
make serve-dev  # serve web/ itself (unhashed) on :8000, for editing the page
make clean      # removes dist/ and dist-site/
```

`dist/` (including the object files in `dist/obj/`) is git-ignored. `make serve-dev` serves the working files, so an edit to `index.html` or a script shows on reload with no build; `make dist` is only for deploying.

**Files.** `index.html` (the page and all its CSS), `main.js` (start page: catalogue, file picker, format detection, loading the interpreter), `ui.js` (what both interpreters share: format detection, the Saves button, dialog and import, viewport pinning, notices, the hashed-asset lookup), `app.js` (the Z-code front end), `glk.js` (the Glulx front end), `saves.js` (the save store and session), `src/web_os.c` (Frotz's browser OS layer), `glk/` (the browser Glk and git's startup file), `bench/` (checks and measurement), `deploy/` (the site build, its server and the deploy notes).

### How the core is compiled

- `-DFROTZ_IOS=1`: the core in this repo has iOS changes, and it references iOS-only globals (`do_autosave`, `fileZCodeOffset`, `AUTOSAVE_FILE`) even when `FROTZ_IOS` is not set, so it only compiles in iOS mode.
- `-Ishim` comes before `-I../frotz/common`. `screen.c` includes `"iosfrotz.h"` unconditionally. `shim/iosfrotz.h` stands in for `include/iosfrotz.h` (which pulls in CoreGraphics and Glk) and declares only what the core needs.
- `frotz/dumb/` is **not** used. It no longer compiles against this core: `zchar` is 16-bit because `USE_UTF8` is hard-wired in `frotz.h`, and it has conflicting `os_display_char` and `getline` signatures. `src/web_os.c` implements the `os_*` interface directly, modelled on `frotz/ios/ui_*.c`.
- Diagnostics: `src/web_os.c` is compiled with `-Wall -Wextra` and builds without warnings. The core gets the compiler's default diagnostics and also builds without warnings, so no `-Wno-*` suppressions are used. If a legacy core file ever needs one, `CORE_CFLAGS` in the Makefile applies to `frotz/common` objects only.
- Every object depends on the core headers and `shim/iosfrotz.h`. One link rule writes both `dist/frotz.js` and `dist/frotz.wasm`, so a missing or stale file of either relinks.
- Link flags: `-sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 -sALLOW_MEMORY_GROWTH -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sMODULARIZE -sEXPORT_NAME=createFrotz -sEXPORTED_RUNTIME_METHODS=callMain,FS -sENVIRONMENT=web`. Saves do not use IDBFS (see "Save store").

### How git is built

- `git/` is compiled **without** `FROTZ_IOS`, so none of its iOS code is used. `git.c` and `memory.c` include `"iosfrotz.h"` unconditionally, so `glk/shim/iosfrotz.h` is an empty stand-in for them. `git/config.h` turns on `USE_DIRECT_THREADING` (computed goto), which clang compiles for wasm. `-DUSE_INLINE` is set, as git's own Makefile suggests.
- The Glk headers and the two platform-independent Glk files (`gi_dispa.c` for the dispatch layer, `gi_blorb.c` for Blorb) come unmodified from `glkios/`. `glk/glk_unicode.c` and `glk/glk_date.c` compile `glkios/cgunicod.c` (Unicode case tables) and `glkios/cgdate.c` unmodified. `glk/glkios_compat.h` stands in for the iOS private header they include.
- `glk/git_web.c` is the startup file (the part `git_unix.c` plays on Unix). It reads the story from MEMFS and calls `git()`, which finds the Glulx chunk of a Blorb itself. `fatalError` prints in the story window and exits.
- Before calling `git()`, `git_web.c` validates the file, because neither `gi_blorb.c` nor git checks a Blorb's declared sizes against the real file. It checks that the FORM fits the file, that every chunk fits the FORM, that the resource index has room for its count and its entries, that each entry starts a real chunk, that no two entries share a (usage, number) key (`gi_blorb.c`'s quicksort never finishes on equal keys, and its binary search could pick a different duplicate than the one checked), that an odd-sized chunk's pad byte fits too, and that the executable is a GLUL chunk whose Glulx header fits it. A bare `.ulx` must have the Glulx magic and a RAMSTART/EXTSTART/ENDMEM map that fits its length. A damaged file is refused with a message in the story window. `node bench/check-malformed.js` (after `make bench`) runs damaged files through the Node build and fails if any of them reaches the game: a truncated FORM, an oversized GLUL chunk (alone, with the FORM length raised to match, and near 4 GB), a short resource index, an index count whose entries do not fit, six and three identical `Exec 0` entries, an odd final chunk whose pad byte is missing, and a header larger than its image; valid controls (Exec 0 and Pict 0 on one chunk, a padded odd chunk) must still start.
- Link flags are Frotz's (`-sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 -sALLOW_MEMORY_GROWTH -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sMODULARIZE -sEXPORTED_RUNTIME_METHODS=callMain,FS -sENVIRONMENT=web`), with `-sEXPORT_NAME=createGit`. The deepest unwind measured uses 288 bytes of the 64 KB Asyncify buffer (see "Measurement").
- `glk/glk_web.c` and `glk/git_web.c` build with `-Wall -Wextra` and no warnings. The `git/` and `glkios/` files also build without warnings at the default level.

### The harness and `make check`

`make check` builds `bench/glk-check.c`, a small Glk program on the plain bridge, and runs it with `bench/check-glk.js`: `set_arrangement` direction and axis changes, a nested key, closing a key, a blank fixed key, grid line limits and echo wrapping, cancelling a line before it is shown, echo per request, consecutive overdue timers (each waits on the page with a zero timeout), deleting a `/saves` file, the LineInput/CharInput gestalt answers, and `glk_style_distinguish` against the CSS. It then runs `bench/check-malformed.js`, and `bench/check-page.js`: format detection (`ui.js`) on the bundled stories, Blorbs with a ZCOD, a GLUL or no executable chunk, a Quetzal save, HTML, empty, truncated and version-9 files; the start page run as `index.html` runs it (`saves.js`, `ui.js`, `main.js`, which loads only `glk.js` for a Glulx story); `glk.js` on a fake DOM (composition across timer and Arrange waits, a lowered line limit) and `saves.js` across tabs on a fake IndexedDB (a clean copy removed after another tab's delete, an unstored copy kept). Link flags are compared with `dist/obj/<name>.ldflags` while the Makefile is read, without writing anything, so `make -n` leaves `dist/` alone.

**Safari 27.2 (macOS), 2026-11-08 (task 3).** The Glulx page (then `glulx.html`) was served by a test-only server that injected a remote-control script (not in the repo); input went through the real form (`requestSubmit()`) and synthetic `keydown`, `input` and `composition*` events on the command field, not real keystrokes. Test stories came from Plotkin's `erkyrath/glk-dev` unit tests and from `git/test/`, served by the test server and not shipped.

- *InputEventTest* (`inputeventtest.ulx`): char input delivered `q` (113), Left (`$FFFFFFFE`) and F5 (`$FFFFFFEB`); Unicode char input took `é` (233) as the committed text of a composition and `😀` (`$1F600`) as soft-keyboard text without a key event; line input in the status (grid) window returned the line; the timer test printed "(timer event)... Done." after its two seconds, and the page kept painting during the wait.
- *Alabaster* (`git/test/Alabaster.gblorb`): SAVE stored `Alabaster.glksave` in IndexedDB (rev 1, 19,092 B). After a reload MEMFS `/saves` was empty, and RESTORE printed "Ok." with the file copied in from IndexedDB. Deleting it through the page's `deleteFile` left a tombstone (rev 2, `deleted`); after another reload RESTORE printed "Restore failed.", and the next SAVE stored rev 3, which the Saves dialog listed as "in browser storage".
- *Glulxercise* (the bundled file): `all` ended with "All tests passed."
- No page errors or unhandled rejections were logged.
- Not tested in a browser: iOS or iPadOS Safari, real hardware keys and a real input method or soft keyboard, Chrome or Firefox, multi-window games beyond a status line, line terminators, and a timer handler slower than its interval (covered in `make check` only).

In Node, with the same objects:

- `bench/run-bench.js` plays a story through a Node build with a scripted `Module.glkWeb`. *Adventure* ran 234 turns, including a SAVE and a RESTORE. `git/test/Alabaster.gblorb` (Blorb, Inform 7, git's own test case) played to its ending. Its story text matches `git/test/Alabaster.golden` line for line (164 of 164 lines), once the golden file's CheapGlk status-window errors and the echoed commands are set aside.
- `glk.js` ran in Node on a minimal DOM stub against the ASYNCIFY build. Covered: window layout (status grid plus buffer), the grid's status line, buffer text with styles, typing commands, type-ahead, SAVE and RESTORE (with no IndexedDB, so the "session only" notice and badge appear), and a resize (an Arrange event; the game redrew a narrower status line).
- *Glulxercise* `all` under `bench/run-bench.js` passes every test except git's two random-number checks, which fail on bit balance with the harness's pinned clock (they passed in Safari, with a real clock; see `games/LICENSES.md`).

### Adding a story to the catalogue

A catalogue entry is `{ "file", "title", "author", "format" }`, where `format` is `"zcode"` or `"glulx"`; the page refuses to start a bundled story whose bytes say otherwise. `make dist` copies exactly the files the catalogue lists.

A story goes into `games/` and `games/stories.json` only with all of this recorded for it in `games/LICENSES.md`:

1. **Release.** Title, author, release and serial number, and the file's SHA-256.
2. **Source.** Where this exact file comes from (for example its IF Archive path), checked to be byte-identical.
3. **Permission.** The text that allows redistribution, quoted, with where it was found (the game's own banner or documentation, a licence file, or a statement from the author). "The iOS app already bundles it" or "it is on the IF Archive" is not permission.
4. **Notices.** The copyright and licence notices the permission requires, and how the web client keeps them (for example a banner the game prints itself), plus any condition the host has to meet, such as no charge.

A story that lacks any of these stays out of the catalogue.

## Status

### Z-code (Frotz)

- Z-code v3–v8 text games (tested with `Balances.z5`, v5).
- Status line / upper window as a real fixed-pitch grid.
- Text styles and colours in both windows.
- Timed line input (`read` with a timeout and a timeout routine), with V5+ initial text (see "Line input state"). This was checked in Node, not in a browser. Timed `read_char` uses the same timer but has not been tested.
- `save`, `restore`, `undo`, `restart`, `quit`. Saves persist across reloads.

Not done (yet):

- There is no file-name prompt. Every save and restore uses `<story>.sav`.
- No sound, no pictures (V6). No true colour (`set_true_colour`): colours outside the standard table fall back to the default.
- No `[MORE]` paging. The transcript just scrolls.
- Games that position the cursor inside the lower window (window 0) still look wrong: window 0 is a reflowing stream, not a grid.
- No visible cursor in the upper window, and no mouse/menu input.
- Transcripts (`script`) and command recording write to MEMFS only.
- A backspace in the output stream (`ZC_BACKSPACE`, rare in games) removes one whole character from text still in `web_os.c`'s output buffer, but cannot remove text already handed to the page. Text is flushed when the interpreter waits for input, when the style, font or colour changes, and when the 8 KB buffer fills.

### Glulx (git)

- Glulx stories, bare or in a Blorb, with text buffer, text grid and blank windows in any arrangement, line and char input in several windows, Unicode, timers, line echo and terminators, date/time and resource streams. *Glulxercise* `all` passes in Safari; *Alabaster* plays to its end, and *Adventure* 234 turns, in Node.
- Saves, data files and transcripts persist per file, with deletion (tombstones), as for Z-code.
- Damaged Blorbs and Glulx files are refused before git sees them (`git_web.c`).

Not done (yet):

- Graphics windows, images, sound, hyperlinks, mouse input: stubbed, gestalt false.
- Style hints are ignored. There is no per-game colour.
- `glulxe/` and `tads/` are not built. Neither needs only a startup file; see "What glulxe and TADS need" below.

### Mobile layout (task 4, Safari 27.2, 2026-11-08)

Desktop Safari windows sized to 390×844 and 430×932 (viewports 390×792 and 430×880), driven through a test-only control channel (a script injected by a scratch server; not in the repo): the start page, *Balances* and *Lost Pig* (Z-code), *Glulxercise* and *Alabaster* (Glulx, including its status grid while resizing between the two widths), the Saves dialog, and a real conflict notice from two tabs saving the same file without Web Locks. Nothing overflowed the viewport at either size. The Z-code status line keeps 52 columns by shrinking its font to 11.1px (390) and 12.4px (430); the Glulx grid keeps its 15px font and gets 40 and 45 columns. What was cramped, and fixed (layout only): 32px buttons and file labels (now 44px on touch screens), a 28px command field in a 53px bar (it now covers the bar), and two buttons squeezed onto two lines each in a conflicting save's row (they now wrap below the label). See "Mobile Safari" for what remains untested.

### Licence policy

A story is shipped only with its release, source, quoted permission and required notices recorded in [`games/LICENSES.md`](games/LICENSES.md) (the rules are under "Adding a story to the catalogue"). That holds *Balances* (the Inform example-game licence: unchanged copy, notices kept, no profit, which every host has to honour) and *Glulxercise* (public domain, stated in its source). The 20 other stories the iOS app bundles from `resources/Games` are not in the web client, because their terms have not been recorded for it; that is a hold on evidence, not a finding that their authors forbid it.

**Pending: *Adventure*.** Plotkin's Glulx compile of Nelson's Inform *Advent* (`advent.ulx` from the IF Archive) is held back. The Inform licence covers copies "not substantially different from those archived by the author", and this file was archived by Plotkin, not Nelson, so whether it qualifies is unconfirmed. James decides (Ganglion need `iosfrotz-web-catalogue`; its recommended default is to ship only what is cleared). Until then the benchmark reads it from `bench/local/Advent.ulx`, ignored by git ("Measurement").

The interpreters' own licences (Frotz, git, and the `glkios` files) apply to the `.wasm` builds wherever the site is hosted.

## Architecture

### One page, two interpreters

`index.html` loads `saves.js`, `ui.js` and `main.js`. When a story is picked, `main.js` gets its bytes, asks `WebFrotzUI.detectFormat` which interpreter it needs, and only then loads that interpreter: `dist/frotz.js` + `app.js` for Z-code, or `dist/git.js` + `glk.js` for Glulx. Each front end registers with `ui.js` and is started once. `body[data-format]` shows that front end's part of the page (the transcript and upper-window grid, or the Glk windows); the toolbar, picker, command bar, Saves dialog and notices are shared.

- **Detection.** Glulx starts with `Glul`. A Blorb (`FORM` … `IFRS`) is opened by the interpreter whose executable chunk it holds (`ZCOD` or `GLUL`; `fastmem.c` and git then find that chunk themselves). Z-code has no magic number, so a file counts as Z-code when its header is plausible: version 1–8, and static memory and the object table inside the file, after the 64-byte header. All 38 story files in this repo are classified correctly, and scripts, images and HTML are refused.
- **Loading.** While a story loads, the picker says so; a newer pick supersedes a load still fetching, and a failed load (a fetch, a refused file, an interpreter that does not load or start) puts the picker back with the error and drops the hash. A hash that names no story, or has malformed `%` escapes, shows the picker.
- **Blorb.** Neither front end unwraps a Blorb: the file goes to MEMFS as it is. Frotz's `init_memory()` (`fastmem.c`) finds the `ZCOD` chunk and sets `fileZCodeOffset`, which loading, `restart`, `save` and `restore` honour (tested with *Lost Pig*, `resources/Games/LostPig.zblorb`, not shipped); `git_web.c` validates a Glulx Blorb and git finds its `GLUL` chunk.
- **One interpreter per page.** Only one front end is ever loaded, because both drive the same command bar (and their top-level names would collide). Changing story while one runs reloads the page. If an interpreter fails to start, a story in the same format can be tried again in that page; one in the other format asks for a reload.
- **Hashed assets.** `ui.js`'s `asset(path)` and Emscripten's `locateFile` hook look each build file up in `self.WebFrotzAssets`, the map `deploy/build-site.js` writes into the deployed `index.html`. Served from `web/` there is no map and every path is used as it is.

### ASYNCIFY, not a worker

Both interpreters block for input in C. With ASYNCIFY, the C function that waits awaits a JS Promise (`EM_ASYNC_JS`), the C stack is unwound so `callMain` returns to the browser, and it is rewound when the player acts. The alternative, the interpreter in a worker blocking on `Atomics.wait`, would need cross-origin isolation (COOP/COEP headers), a message protocol and a second JS context.

**Decision: ASYNCIFY for every interpreter built so far.** Measured on git (below): turn time within 20% of a plain build (1.15× on *Adventure*, whose turns take 0.15 ms, so about 21 µs per turn; 0.92× on *Alabaster*, whose turns take 30–400 ms), 76 KB more wasm (`git.wasm` 267,216 vs 191,209 bytes), about 3 ms more startup, and at most 288 bytes of the 64 KB unwind buffer. That decision does not extend to glulxe or TADS without their own measurement.

#### Measurement

`make bench && node bench/measure.js --runs 9` plays the same stories with the same commands under (a) the ASYNCIFY build and (b) a plain build without ASYNCIFY. In (b) `glk_select` gets its event from a plain function call; it is compiled with `-DGLK_WEB_SYNC`, and nothing else differs. Each run is a fresh Node process, the builds alternate, and Date.now is pinned so both play identical games. A turn is the time from one input wait to the next, so under ASYNCIFY it includes the unwind and the rewind. "Module load" is `createGit` (compiling and instantiating the wasm), and "Startup" runs from before it to the first input wait, so it includes it. The run fails, after printing the table, if the transcripts differ between runs or builds, if the turn counts differ, or if any run did not play every command of its walkthrough to a normal end.

*Adventure* is no longer in `web/games` (see `games/LICENSES.md`, "Available after clearance"). To include it, put the IF Archive's `advent.ulx` at `bench/local/Advent.ulx` (ignored by git) and check its SHA-256, `264236f2c3504eb2f326ab560aef435902d357c1ef848127b6ea0329c10387f8`; without it only *Alabaster* runs. The table shows medians of 9 runs on the final build of this branch (Node 22.21.1, Apple Silicon):

| Story | Build | Turns | Module load ms | Startup ms | All turns ms | Mean turn ms | Slowest turn ms | Turn time vs plain | Asyncify buffer used |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Advent.ulx (Inform 6) | (b) plain | 234 | 2.3 | 6.4 | 34.0 | 0.145 | 0.6 | 1× | – |
| Advent.ulx (Inform 6) | (a) ASYNCIFY | 234 | 2.5 | 9.0 | 39.0 | 0.166 | 0.8 | 1.146× | 288 B |
| Alabaster.gblorb (Inform 7) | (b) plain | 43 | 2.3 | 8.2 | 5519.9 | 128.4 | 401.5 | 1× | – |
| Alabaster.gblorb (Inform 7) | (a) ASYNCIFY | 43 | 2.8 | 11.7 | 5049.7 | 117.4 | 364.8 | 0.915× | 268 B |

Sizes: `git.wasm` is 267,216 bytes with ASYNCIFY and 191,209 bytes without (+40%). `git.js` is 71,341 bytes. The deepest unwind is now 288 bytes (the awaited delete and the timer path added frames); 64 KB stays ample.

**Recommendation: ASYNCIFY for every interpreter.** On both stories (a) is within 20% of (b):

- On *Adventure*, whose turns take a seventh of a millisecond, ASYNCIFY adds a fixed ~21 µs per turn for the unwind, the Promise and the rewind. That is 15% of almost nothing, and no player can see it. This ratio is the noisiest number in the table: earlier sets gave 1.19×, 1.17× and 1.14×.
- On *Alabaster*, whose turns take 30–400 ms of interpreter work, the ASYNCIFY build was not slower. It was 5–9% faster in every set of runs, for reasons not investigated (the binary is laid out and optimised differently).
- The costs that remain are 76 KB more wasm and about 3 ms more startup. Module load (compile and instantiate) is about 2.5 ms under Node for either build; Safari's has not been measured.
- This holds for git only. It says nothing about glulxe or TADS (see "What glulxe and TADS need").

A worker with `SharedArrayBuffer` and `Atomics.wait` would also need the page to be cross-origin isolated (every response with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which neither `python3 -m http.server` nor GitHub Pages can send), a message protocol and a second JS context. Nothing here justifies that. Revisit it only if an interpreter needs a stack deeper than ASYNCIFY can unwind cheaply, or if a large game shows a cost that this measurement did not.

### Save store and the single-writer rule

`/saves` is plain MEMFS. Nothing mirrors the whole directory to browser storage; each file is stored on its own in IndexedDB by `saves.js` (database `web-frotz`; object store `saves` with key = file name and value `{bytes, mtime, story, rev}`, and a `meta` store with `{size, mtime, story, rev, sha256}` for listing). `saves.js` also holds the save session (`createSaveSession`) and the Saves list rendering; `ui.js` puts the Saves button, dialog and import on top of it for whichever interpreter is running.

- **One writer (Web Locks).** Each page asks for the exclusive Web Lock `webfrotz-saves` (Z-code and Glulx stories share it, as they share the database). The page that gets it holds it until it closes and is the only one that writes to browser storage. Any other page is **session-only**: the transcript says "Another Frotz tab owns browser storage; saves here are kept for this session only. Export any you need.", the Saves button is badged and the dialog repeats it. Its saves (and imports, and game deletes) stay in MEMFS; RESTORE still reads stored files; nothing is written. It waits for the lock in the background, and when the owning tab closes it takes over, says "This tab now saves to browser storage…", and persists from then on. Saves it made while session-only stay badged until saved again or kept with **Keep this one**.
- **Losing the lock.** A writer that loses the lock after it was granted (another page asked with `steal: true`, the held request rejected, or a save hit a revision conflict, which proves another page wrote) stops writing at once: it becomes session-only for the rest of the page's life, says "This tab no longer owns browser storage…", hides Keep this one, and abandons writes still in progress (a transaction that has not committed is aborted; every write also re-checks ownership in the callback that would write). Those files stay badged and in MEMFS. A conflict also gives the lock back, so a waiting tab can take over. This includes a tab that has just been granted the lock and is still taking its snapshot: it never becomes the writer. If the request a session-only tab is waiting with rejects, it stays session-only. Only when Web Locks are missing, or the very first request fails before any grant, does a page fall back to **unlocked** mode: every such page writes, protected only by the revisions below.
- **Back/forward cache.** On `pagehide` the page stops writing, abandons writes in progress (their files stay dirty and badged), aborts a request still waiting in line (an `AbortSignal`), and then releases the lock. A snapshot or read still in progress is cancelled too, so the release never waits on storage. On `pageshow` with `persisted` it asks again, as at start; if it gets the lock it takes a fresh snapshot before it writes, otherwise it is session-only and waits. An unlocked page does nothing on either event.
- **Pending local writes.** A save, an import, Keep this one or a game delete marks the file dirty in the same step that changes MEMFS, before anything is awaited. RESTORE never replaces a dirty file (nor brings back a dirty delete), whether the write is still being stored, failed, conflicted or was session-only. Only the operation that owns the file's latest local write may clear the mark (when it is stored) or set its badge; one overtaken by a newer local write changes nothing.
- **Revisions.** Each stored file has a revision, `rev`, which starts at 1 and goes up by one with every write. A write runs in one readwrite transaction that reads `meta` first. If the stored revision is the one this tab expects, it writes bytes and `meta` with `rev + 1`. If not, the store changed behind this tab's back (with one writer, only a closing owner's last write or a tab without Web Locks can do that), nothing is written, and the result is a **conflict**. The expected revision is a frozen baseline: it is read from the store once, when the page becomes the writer (every stored file at its revision, every other name as absent, revision 0), and afterwards moves only with this tab's own writes, a RESTORE that copies the stored file in, or **Keep this one**. Listing the store (opening the Saves dialog) never moves it, so after a conflict every plain save of that file conflicts again until the player resolves it. Save times are shown but play no part in this. If the stored bytes are identical to this tab's (same SHA-256), the save counts as stored without a write.
- **Save.** After a successful `save` (and also after a `save` with operands, which writes an auxiliary file), the core calls `os_mark_recent_save()`, and `web_os.c` awaits `js_persist_save(path)` with the path the core asked for. The outcome is always visible:
  - **stored**: no notice.
  - **session-only** (another tab is the writer): the notice above.
  - **conflict**: the transcript says "Another tab saved `<name>` more recently. Your save is kept in this session only: Export it, or open Saves and choose Keep this one." The Saves button gets a warning badge. In the writer tab a conflict also ends its ownership (see **Losing the lock**).
  - **failed or timed out** (5 seconds): the transcript says "Saved for this session only, not to browser storage. Export it from Saves." and the badge appears.

  The game continues either way, and the save is in MEMFS for this session. The badge stays while any file this tab saved is not in browser storage, and clears when a later save of that file is stored. A reply of "Ok." does not by itself mean the file is in browser storage: only the absence of a notice does.
- **Restore.** Before the core opens the file for `restore` (or a `restore` with operands), `os_read_file_name` awaits `js_load_save(path)`. If this tab's own latest save of that file is not known to be in browser storage (it is still being stored, or it conflicted, failed or was session-only), MEMFS keeps it, and the transcript says the restore uses this tab's own copy. Otherwise the stored file is read and copied into MEMFS if MEMFS lacks it or holds a different revision, and the tab adopts that revision, so its next save may replace it. If this tab writes the file in any way (a save, an import, Keep this one) while the read is still pending, the stored result is discarded and this tab's copy and its badge are kept. If the read fails or times out, the restore uses what MEMFS has and the transcript says so.
- **Replacing a file in MEMFS.** A restore's copy and an import are written to a new temporary file `.webfrotz-tmp-<random hex>-<name>` in `/saves`, created exclusively (another random name if it exists), and then renamed over the file. If anything fails, the previous file is untouched and only that temporary file is removed: a game's own files (say `foo.sav.tmp`) are never used or deleted. Temporary names are not listed in the Saves dialog, and `web_os.c` turns a game's request for such a name into `_webfrotz-tmp-…`.
- **Start.** Nothing is loaded at start. The page asks for the lock and, as the writer, lists the store once (names, sizes, times, revisions) to freeze the baselines; a save waits for that, the game's start does not.
- **Timeouts and cancelling.** Every IndexedDB operation settles within 5 seconds. There is at most one live operation per kind and file. Starting another one cancels the previous one at once: its transaction is aborted if it has not committed, its connection is closed, and its promise rejects. A timeout cancels the same way. The open, the creation of the transaction and each request callback check that their operation is still live before acting, and a connection that opens late is closed unused. A transaction that has already committed cannot be undone: cancelling it then only suppresses its result (the tab still records the revision it wrote, so its next save does not conflict with itself). Each operation opens its own connection and closes it when its transaction ends, so no connection is kept open between saves or held by a page in the back/forward cache.
- `quit` and fatal errors need no flush: a save is already stored or reported when the game continues.
- The **Saves** dialog lists every file in browser storage ("in browser storage") and every file this tab holds only in memory ("this tab only, not in browser storage"). For a conflict it lists **both versions**: the stored one (the other tab's) and this tab's own. Each has **Export**, which downloads exactly that version. This tab's version also has **Keep this one** (when this tab is the writer), which stores it over the stored version shown, and conflicts again if the store has changed since. **Import save…** checks that the file is a Quetzal save (an IFF `FORM` of type `IFZS`; Glulx saves are Quetzal too) of at most 4 MB, then writes it as the current story's save name and stores it like a save, so the game's next `RESTORE` loads it. Anything else is rejected and the previous save is kept. The Z-code save name is the one the core uses (`<story>.sav`, the story file name up to its first `.`, at most 236 bytes), which `web_os.c` passes to the page; a Glulx story's is `<story>.glksave`.
- The web client does not prompt for file names, so a save always uses the default name. To keep both versions after a conflict, export the one you would otherwise lose.
- Auxiliary files (`save`/`restore` with operands) are stored by the name the game gives them, lower-cased with `.aux` added when it has no extension, under the same rules.
- There is no delete button. A Glulx game can delete its own files ("The browser Glk", **Files and saves**); otherwise removing a save means clearing the site's data in the browser.

**Safari caveat.** WebKit deletes all script-writable storage (IndexedDB included) for a site that has not been visited for 7 days, unless the site has been added to the Home Screen as a web app. Treat browser storage as a cache and export saves you care about.

### Z-code front end

#### Input

`os_read_line` and `os_read_key` call `EM_ASYNC_JS` functions that `await` a Promise from `app.js`. ASYNCIFY unwinds the C stack at that point, so `callMain` returns to the browser. The stack is rewound when the player presses Enter, or when a timed-input timer resolves the Promise with a timeout. Lines submitted while the interpreter is still busy are queued (type-ahead), not dropped.

**Line input state.** `os_read_line` passes the line so far to the page, and the input field is set to it:

- On a new read, that is the game's initial text (V5+ `read` with a pre-filled buffer, usually empty). The game has already printed it, so `web_os.c` takes it back out of the output buffer. The player edits it in the field, and on Enter the whole line is echoed once. If the text had already reached the page (the buffer was flushed in between), it is left there and only the rest is echoed. With no initial text, the field keeps anything the player has started typing (but not submitted) while the game was busy, unless it is just the partial line of a read that a timeout ended. That stale line is cleared.
- On a timeout, the page returns what has been typed so far, and `os_read_line` puts it in `buf` and returns `ZC_TIME_OUT`. Nothing is echoed. The core runs the game's timeout routine. If the routine continues the read, the core calls `os_read_line` again with `continued` set and the partial line in `buf`, and the field still holds it. Text the routine printed is flushed first, so it appears before the line's echo. If a new line was started in the input window since the last read began (the routine printed a newline, or a word wrapped), the core redraws the partial line before continuing (`input_redraw` in `screen.c`). `web_os.c` mirrors that flag exactly: it is set by every lower-window new line and cleared only when `os_read_line` starts, never by a timeout, so a wrap during the shim's own flush is not forgotten. It also records the bytes the last `os_display_string` call wrote, and keeps such a call in one piece in its output buffer (flushing first if it might not fit), so the redraw is found exactly, even next to the 8 KB flush boundary, and taken back out. So the line is edited in the field and echoed once on Enter. If the routine ends the read, the game gets the partial line as typed, and the next read replaces the field.
- A line typed ahead (submitted while no read was waiting) was typed without the initial text in view, so it is taken as the whole line. Taking it also retires the timed-out-line marker, so a fresh, unsubmitted line typed later is never mistaken for the stale partial line and cleared.

This was checked in Node with the same objects and a scripted front end, using a small hand-assembled V5 story: initial text `abc`, a 1-second timed `aread`, and a timeout routine that prints `*` and continues the first time, then ends the read. Ending on the second timeout stored `abcXY` (length 5). Pressing Enter after one timeout echoed `*` and then `abcXZ`, and stored `abcxz`. Editing the initial text to `aBc` stored `abc`. That harness replaces `app.js`, so the input-field handling in `app.js` itself has not been run. Nothing has been tried in a browser with a real timed game.

#### Upper window

Window 1 (and the V3 status line, which Frotz draws in window 7) is a grid of `h_screen_rows` × `h_screen_cols` cells in `web_os.c`. Each cell holds a character and an attribute word (style, foreground and background colour). `os_set_cursor` positions writes, and `os_erase_area` and `os_scroll_area` act on the cells. `os_scroll_area` first intersects its rectangle with the upper-window grid (the lower window scrolls in the browser) and ignores an empty one. It scrolls up for positive units and down for negative units, and a displacement as tall as the rectangle or taller just clears it. When the interpreter waits for input, the grid goes to `app.js` in one call (pointers into the wasm heap), and it is drawn as rows of styled spans in a monospace font. Every span in the grid is exactly the grid font, so fixed-style or font-4 text keeps the column alignment (the transcript's slightly smaller fixed-pitch text applies only to the transcript). So status lines, boxes, quotation boxes and menus keep their layout.

**Screen size.** At load, `app.js` measures the grid font and picks as many columns as fit the reading column (at most 48rem, so about 79 at 15px). On a narrow screen it keeps at least 52 columns by shrinking the grid font (not the input). Rows come from the height left for the two windows: the page (pinned to the visual viewport) less the toolbar and the command bar, at least 10. The core reads this in `os_init_screen`. The upper window is at most 75% of the page and scrolls inside itself beyond that, so a full-screen menu or a short viewport never pushes the command bar off screen.

**Resize.** On a window resize the page refits the grid at once and passes the new column count to the core at its next read, both before the read and when the read returns, so the game's next status redraw uses it. `web_os.c` then sets `h_screen_cols`/`h_screen_width`, calls `resize_screen()` (the window sizes) and `restart_header()` (the header the game reads). Nothing is interrupted, so no `ZC_TIME_OUT` is sent. Only the width changes at runtime. The row count stays as sized at load, because shrinking it under a split upper window could leave the lower window with no rows. Most games redraw their status line every turn; an upper-window menu already on screen keeps its old layout (clipped) until the game redraws it.

#### Styles and colours

`os_set_text_style` (reverse, bold, italic, fixed) and `os_set_colour` both feed one attribute word (`style | fg << 8 | bg << 16`) that goes with every span of lower-window text and every upper-window cell. Font 4 (fixed pitch) counts as the fixed style.

- The header reports colour support (`CONFIG_COLOUR`, V5+) and, as `frotz/ios/ui_init.c` does, reports colour 1 as the default foreground and background. So "default" text follows the page's scheme.
- Colours 2–12 (black, red, green, yellow, blue, magenta, cyan, white, then the three greys) map to the CSS variables `--z2` … `--z12` in `index.html`. Each has a light and a dark value under `prefers-color-scheme`, tuned so that the default text stays readable.
- Reverse video swaps foreground and background, defaults included.
- Erasing the screen (`erase_window`) fills it with the current background colour by setting `--screen-bg`, which is the page background. Erased upper-window cells keep the background colour too.
- The toolbar and the command bar have their own surface and text colours (`--chrome-bg`, `--chrome-fg`, one pair per scheme), so a game's white or black screen never makes the input or the buttons unreadable.

### The browser Glk (`glk/glk_web.c`, `glk.js`)

The library owns the window tree and lays it out itself, in CSS pixels, from font metrics the page measures (grid and buffer character cell, window paddings). This is close to GlkOte's model. The window sizes in characters that games read with `glk_window_get_size` come from the same numbers. The page only draws:

- **Text buffer windows.** Output is batched per window as UTF-8 with a style marker at each style change, and handed over when the game waits. The page appends styled spans (and drops the oldest beyond 4000).
- **Text grid windows.** A cell grid (code point and style) is sent whole when it changed, and drawn as rows of spans in a monospace font with the toolbar's colours.
- **Pair windows.** Fixed and proportional splits in all four directions, key windows, `set_arrangement` and closing (the sibling takes the pair's place). `set_arrangement` follows `glkios/ipwindow.c`: changing Above to Below (or Left to Right) swaps the pair's children with the direction, so both windows stay where they are and only the side that gets the size moves. A change of split axis, and a fixed size on a blank key window, are refused. Blank windows are supported. Graphics windows are refused (`glk_window_open` returns NULL).
- **Styles.** The 11 standard styles map to CSS classes `.gs-0` … `.gs-10` in `index.html`. Style hints are accepted and ignored. `glk_style_distinguish` reports which styles look different under those classes.

**Input and events.** `glk_select` is where the interpreter waits for the player. (It is not the only asynchronous bridge: loading, persisting and deleting a `/saves` file are awaited too, so the C stack also unwinds inside those file calls.) It flushes output, tells the page which windows want line or char input, and awaits `Module.glkWeb.wait()` from an `EM_ASYNC_JS` function, so ASYNCIFY unwinds the C stack as `web_os.c` does. The page keeps one record per pending request (line or char, maxlen in code points, terminators, the line typed so far), so requests in several windows are independent. There is one command field, and it serves one request at a time: the first line request by default, else the first char request. Tapping another window that has a request switches the field to it (that window gets a thin outline), and the line typed so far in the previous one is kept. A char request takes a key, or the first code point of text that arrives without a usable key event (a soft keyboard, dictation, or the committed text of an input method; `compositionend` and `input` are handled). From `compositionstart` to `compositionend` the field holds uncommitted text, and nothing reads it: not a key, an `input` event, a submit, or a wait that starts after a timer or Arrange event ended the last one. The rest of such text waits for the next char request. Line length is limited in code points, not with the UTF-16 `maxlength` attribute, so a supplementary character fits in a maxlen of one. In a text grid, line input is limited to the rest of the cursor's row; when the grid is resized under a pending request the limit is recomputed from the new width (the page trims the field to it), and the echo is clamped to the row. Line input supports initial text, echo (in the Input style; `glk_set_echo_line_event` applies to the next request), cancelling (which returns the partial line, or the initial text if the line was never shown), and terminators (Escape, F1–F12, Up/Down, PageUp/PageDown, when the game asks for them). Lines typed while the game is busy are queued. Timers are kept in C: `glk_select` passes the time to the next tick as the wait's timeout, and `glk_select_poll` reports a due timer. Missed intervals make one timer event. A select may return an overdue timer at once only if the previous one did not; otherwise it waits on the page with a zero timeout, which is a `setTimeout` macrotask. So a game whose timer handler takes longer than its interval still lets the page paint, resize and deliver input between ticks. A page resize ends the wait with an Arrange event, after which the layout is recomputed and the game redraws (or `glk_select_poll` reports it).

**Files and saves.** Files live in MEMFS. Everything under `/saves` (saved games, data files, transcripts) is persisted one file at a time through `saves.js`: a write-mode stream is written to IndexedDB when it is closed, and a file is brought in from IndexedDB (with the same revision and conflict rules as Z-code stories, see "Save store") before it is opened or tested with `glk_fileref_does_file_exist`. Output is flushed before each of these, so a storage notice follows the game's own text. `glk_fileref_create_by_prompt` does not prompt. It uses one name per story and usage, like Z-code stories: `<story>.glksave`, `<story>.txt` (transcript), `<story>.rec` (command record), `<story>.glkdata`. `glk_fileref_create_by_name` gives `/saves/<name>.<suffix>`, shared between stories as the Glk spec intends. Temporary files go to `/tmp` and are not stored. The Saves dialog, Export and Import are the same as for Z-code stories (`ui.js`). Glulx saves are Quetzal files too, and Import replaces `<story>.glksave`. A file the game deletes (`glk_fileref_delete_file`) is removed from MEMFS and from IndexedDB: `saves.js`'s `remove` deletes the bytes and leaves a tombstone in `meta` at the next revision, so the file stays deleted after a reload, existence checks find nothing, the Saves dialog leaves it out, and a stale tab that saves the old version afterwards gets the usual conflict. The delete is awaited, like a save. If the tombstone cannot be written (no storage, a failure, or another tab saved the file since), a notice says so and the file is hidden for the rest of the session. When another tab deletes a file this tab holds a clean copy of (exactly a stored revision it read or wrote), the next open or existence check finds the tombstone (or no record) and removes the MEMFS copy too, with a notice; a copy with changes this tab could not store, or a file the game has open for writing, is kept.

**Gestalt.** Version 0.7.4, Unicode, timers, line echo, line terminators, date/time and resource streams are reported as supported. Mouse input, graphics, images, sound, hyperlinks and Unicode normalisation are reported as unsupported, and their calls are stubs.

### Mobile Safari

- `viewport-fit=cover`, with `env(safe-area-inset-*)` padding on the toolbar (top), the page sides (landscape notch), the input bar and the story picker (bottom, the home indicator).
- The file pickers (**Open a story file…**, **Import save…**) are visually hidden inputs inside their labels, so they can be reached with Tab and opened with Space.
- iOS does not shrink the layout viewport for the software keyboard; it shrinks and scrolls the *visual* viewport. `ui.js` listens to `visualViewport` `resize`/`scroll` and pins the body to it (`--app-top`, `--app-height`). So the input stays docked just above the keyboard and the story fills the rest; a Glulx story also gets an Arrange event, so its windows are laid out again. With the keyboard up, the bottom inset is dropped.
- The input is at least 16px (17px here), so iOS does not zoom the page when it gets focus. Only the upper-window grid font may shrink below that on narrow screens, and it is never focused.
- `manifest.webmanifest` and `icon-512.png` (a copy of `resources/Frotz-512x512.png`) give "Add to Home Screen" a name and icon, plus `apple-touch-icon`, `apple-mobile-web-app-capable` and `theme-color` for each scheme. A Home Screen web app also escapes Safari's 7-day storage eviction.
- On a touch screen (`pointer: coarse`) buttons and the file labels are at least 44px tall, and the command field covers its bar's full height, so a tap anywhere on the bar reaches it.
- Save rows in the Saves dialog wrap on a phone: a save kept only in this tab has its label on one line and its buttons (Export, Keep this one) on the next.
- There are no animations or transitions, so `prefers-reduced-motion` has nothing to turn off. Add a `@media (prefers-reduced-motion: reduce)` override with any animation that is added later.
- `python3 -m http.server` (`make serve-dev`) serves `.webmanifest` as `application/octet-stream`. Browsers parse it from `<link rel=manifest>` anyway; `make serve` and `deploy/README.md` use `application/manifest+json`.

Only desktop Safari has been tested, including windows sized to 390×844 and 430×932 (iPhone-shaped; Responsive Design Mode cannot be scripted), see "Status". Untested on a real iPhone/iPad: the keyboard docking, the safe-area insets, `pointer: coarse`, Add to Home Screen, and iOS's handling of `<input type=file>` for saves and stories.

### What glulxe and TADS need

These are the iOS (`glkios`) dependencies found in the sources, not a tested port. Each needs a web stand-in before the interpreter links against `glk/glk_web.c`.

**glulxe**

- `glkmain.c`, `exec.c` and `glkop.c` include `"iosfrotz.h"` unconditionally (an empty stand-in like `glk/shim/iosfrotz.h` covers that).
- `exec.c` (lines 35–54 and 648–666) uses the iOS autosave unconditionally: `do_autosave`, `AUTOSAVE_FILE`, `gli_new_fileref`, `gli_delete_stream`, `gli_delete_fileref` and `glk_game_loaded`. A web build needs `do_autosave = 0` and stubs, or the code compiled out.
- `glkop.c` (lines 1110–1116) tears down with `gli_delete_window`, `gli_delete_stream` and `gli_delete_fileref`, which are glkios internals; `glk_web.c` would need equivalents.
- `unixstrt.c` opens the story with `glkunix_stream_open_pathname` → `gli_stream_open_pathname`. A web startup file like `git_web.c` replaces it, and should validate the file as `git_web.c` does.

**TADS 2/3 (`tads/osglk.c` and friends)**

- `osglk.c` includes `"iosfrotz.h"`, `"glkios.h"` and `"git.h"` unconditionally (lines 29–31): iOS headers, and git's, in a TADS file.
- `os_term` (lines 193–194) closes `gli_rootwin`, a glkios global, and calls `git_shutdown_dispatch()`, a function of the iOS git integration.
- `os_gets` and the timed read (lines 560–576 and 685–703) test `do_autosave` and cancel the line read with it, and read lines through `os_get_buffer`/`os_fill_buffer`. Those two are in `tads/osbuffer.c` (portable, on top of `glk_request_line_event[_uni]`), so that file and its Unicode helpers must be compiled in.
- The file prompt (line 543) copies `fileref->filename` directly, which reaches into glkios's fileref struct. `glk_web.c`'s fileref has `path` instead, so a web build needs an accessor (or the `garglk_fileref_get_name` call that line replaces).
- Startup is `glkunix_startup_code`-style with `glkunix_stream_open_pathname` (`tads/tads2/glkstart.h`). `garglk_*` calls are only under `#ifdef GARGLK`.
- TADS games use char input, timers and status grids heavily; those now have checks in `make check`, but no TADS game has run.

**Both.** The measurement above is for git under Node only. glulxe and TADS have their own interpreter loops and Glk use: measure each one's own build, with representative 200+ turn workloads, warm and cold, in Safari, before fixing their architecture (ASYNCIFY or a worker).
