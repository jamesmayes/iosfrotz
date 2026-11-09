# Web Frotz (WebAssembly spike)

This is the Z-machine interpreter from `frotz/common`, compiled unmodified to WebAssembly with emscripten. A small browser OS layer (`src/web_os.c`) and a plain HTML/JS front end (`index.html`, `app.js`) sit on top of it. It is a spike. It shows that the toolchain works and that the interpreter's blocking input can run in the browser's event loop.

## Build

Requires emscripten (`emcc`, tested with 7.0.0 from Homebrew).

```sh
cd web
make            # both interpreters
make frotz      # -> dist/frotz.js (~63 KB) + dist/frotz.wasm (~145 KB)
make git        # -> dist/git.js (~71 KB) + dist/git.wasm (~265 KB), see "Glulx"
make bench      # -> dist/bench/git-{async,sync}.{js,wasm}, Node builds for the measurement
make clean
```

`dist/` (including the object files in `dist/obj/`) is git-ignored.

### How the core is compiled

- `-DFROTZ_IOS=1`: the core in this repo has iOS changes, and it references iOS-only globals (`do_autosave`, `fileZCodeOffset`, `AUTOSAVE_FILE`) even when `FROTZ_IOS` is not set, so it only compiles in iOS mode.
- `-Ishim` comes before `-I../frotz/common`. `screen.c` includes `"iosfrotz.h"` unconditionally. `shim/iosfrotz.h` stands in for `include/iosfrotz.h` (which pulls in CoreGraphics and Glk) and declares only what the core needs.
- `frotz/dumb/` is **not** used. It no longer compiles against this core: `zchar` is 16-bit because `USE_UTF8` is hard-wired in `frotz.h`, and it has conflicting `os_display_char` and `getline` signatures. `src/web_os.c` implements the `os_*` interface directly, modelled on `frotz/ios/ui_*.c`.
- Diagnostics: `src/web_os.c` is compiled with `-Wall -Wextra` and builds without warnings. The core gets the compiler's default diagnostics and also builds without warnings, so no `-Wno-*` suppressions are used. If a legacy core file ever needs one, `CORE_CFLAGS` in the Makefile applies to `frotz/common` objects only.
- Every object depends on the core headers and `shim/iosfrotz.h`. One link rule writes both `dist/frotz.js` and `dist/frotz.wasm`, so a missing or stale file of either relinks.
- Link flags: `-sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 -sALLOW_MEMORY_GROWTH -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sMODULARIZE -sEXPORT_NAME=createFrotz -sEXPORTED_RUNTIME_METHODS=callMain,FS -sENVIRONMENT=web`. Saves do not use IDBFS (see "Saves").

## Serve

The page loads `dist/frotz.js`, `saves.js` and `app.js`, and fetches `dist/frotz.wasm`, `games/stories.json` and the chosen story, so it has to be served over HTTP. Opening it with `file://` does not work.

```sh
cd web
python3 -m http.server 8000     # or: make serve
open -a Safari http://localhost:8000/
```

The ASYNCIFY build needs no special headers. A worker + `SharedArrayBuffer` + `Atomics.wait` build would need the page to be cross-origin isolated, which means serving every response with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`python3 -m http.server` cannot set these. You would need a small custom handler or a real server for that approach.

## How input works

`os_read_line` and `os_read_key` call `EM_ASYNC_JS` functions that `await` a Promise from `app.js`. ASYNCIFY unwinds the C stack at that point, so `callMain` returns to the browser. The stack is rewound when the player presses Enter, or when a timed-input timer resolves the Promise with a timeout. Lines submitted while the interpreter is still busy are queued (type-ahead), not dropped.

**Line input state.** `os_read_line` passes the line so far to the page, and the input field is set to it:

- On a new read, that is the game's initial text (V5+ `read` with a pre-filled buffer, usually empty). The game has already printed it, so `web_os.c` takes it back out of the output buffer. The player edits it in the field, and on Enter the whole line is echoed once. If the text had already reached the page (the buffer was flushed in between), it is left there and only the rest is echoed. With no initial text, the field keeps anything the player has started typing (but not submitted) while the game was busy, unless it is just the partial line of a read that a timeout ended. That stale line is cleared.
- On a timeout, the page returns what has been typed so far, and `os_read_line` puts it in `buf` and returns `ZC_TIME_OUT`. Nothing is echoed. The core runs the game's timeout routine. If the routine continues the read, the core calls `os_read_line` again with `continued` set and the partial line in `buf`, and the field still holds it. Text the routine printed is flushed first, so it appears before the line's echo. If a new line was started in the input window since the last read began (the routine printed a newline, or a word wrapped), the core redraws the partial line before continuing (`input_redraw` in `screen.c`). `web_os.c` mirrors that flag exactly: it is set by every lower-window new line and cleared only when `os_read_line` starts, never by a timeout, so a wrap during the shim's own flush is not forgotten. It also records the bytes the last `os_display_string` call wrote, and keeps such a call in one piece in its output buffer (flushing first if it might not fit), so the redraw is found exactly, even next to the 8 KB flush boundary, and taken back out. So the line is edited in the field and echoed once on Enter. If the routine ends the read, the game gets the partial line as typed, and the next read replaces the field.
- A line typed ahead (submitted while no read was waiting) was typed without the initial text in view, so it is taken as the whole line. Taking it also retires the timed-out-line marker, so a fresh, unsubmitted line typed later is never mistaken for the stale partial line and cleared.

This was checked in Node with the same objects and a scripted front end, using a small hand-assembled V5 story: initial text `abc`, a 1-second timed `aread`, and a timeout routine that prints `*` and continues the first time, then ends the read. Ending on the second timeout stored `abcXY` (length 5). Pressing Enter after one timeout echoed `*` and then `abcXZ`, and stored `abcxz`. Editing the initial text to `aBc` stored `abc`. That harness replaces `app.js`, so the input-field handling in `app.js` itself has not been run. Nothing has been tried in a browser with a real timed game.

## Upper window

Window 1 (and the V3 status line, which Frotz draws in window 7) is a grid of `h_screen_rows` × `h_screen_cols` cells in `web_os.c`. Each cell holds a character and an attribute word (style, foreground and background colour). `os_set_cursor` positions writes, and `os_erase_area` and `os_scroll_area` act on the cells. `os_scroll_area` first intersects its rectangle with the upper-window grid (the lower window scrolls in the browser) and ignores an empty one. It scrolls up for positive units and down for negative units, and a displacement as tall as the rectangle or taller just clears it. When the interpreter waits for input, the grid goes to `app.js` in one call (pointers into the wasm heap), and it is drawn as rows of styled spans in a monospace font. Every span in the grid is exactly the grid font, so fixed-style or font-4 text keeps the column alignment (the transcript's slightly smaller fixed-pitch text applies only to the transcript). So status lines, boxes, quotation boxes and menus keep their layout.

**Screen size.** At load, `app.js` measures the grid font and picks as many columns as fit the reading column (at most 48rem, so about 79 at 15px). On a narrow screen it keeps at least 52 columns by shrinking the grid font (not the input). Rows come from the height left for the two windows: the page (pinned to the visual viewport) less the toolbar and the command bar, at least 10. The core reads this in `os_init_screen`. The upper window is at most 75% of the page and scrolls inside itself beyond that, so a full-screen menu or a short viewport never pushes the command bar off screen.

**Resize.** On a window resize the page refits the grid at once and passes the new column count to the core at its next read, both before the read and when the read returns, so the game's next status redraw uses it. `web_os.c` then sets `h_screen_cols`/`h_screen_width`, calls `resize_screen()` (the window sizes) and `restart_header()` (the header the game reads). Nothing is interrupted, so no `ZC_TIME_OUT` is sent. Only the width changes at runtime. The row count stays as sized at load, because shrinking it under a split upper window could leave the lower window with no rows. Most games redraw their status line every turn; an upper-window menu already on screen keeps its old layout (clipped) until the game redraws it.

## Styles and colours

`os_set_text_style` (reverse, bold, italic, fixed) and `os_set_colour` both feed one attribute word (`style | fg << 8 | bg << 16`) that goes with every span of lower-window text and every upper-window cell. Font 4 (fixed pitch) counts as the fixed style.

- The header reports colour support (`CONFIG_COLOUR`, V5+) and, as `frotz/ios/ui_init.c` does, reports colour 1 as the default foreground and background. So "default" text follows the page's scheme.
- Colours 2–12 (black, red, green, yellow, blue, magenta, cyan, white, then the three greys) map to the CSS variables `--z2` … `--z12` in `index.html`. Each has a light and a dark value under `prefers-color-scheme`, tuned so that the default text stays readable.
- Reverse video swaps foreground and background, defaults included.
- Erasing the screen (`erase_window`) fills it with the current background colour by setting `--screen-bg`, which is the page background. Erased upper-window cells keep the background colour too.
- The toolbar and the command bar have their own surface and text colours (`--chrome-bg`, `--chrome-fg`, one pair per scheme), so a game's white or black screen never makes the input or the buttons unreadable.

## Mobile Safari

- `viewport-fit=cover`, with `env(safe-area-inset-*)` padding on the toolbar (top), the page sides (landscape notch), the input bar and the story picker (bottom, the home indicator).
- The file pickers (**Open a story file…**, **Import save…**) are visually hidden inputs inside their labels, so they can be reached with Tab and opened with Space.
- iOS does not shrink the layout viewport for the software keyboard; it shrinks and scrolls the *visual* viewport. `app.js` listens to `visualViewport` `resize`/`scroll` and pins the body to it (`--app-top`, `--app-height`). So the input stays docked just above the keyboard and the transcript fills the rest. With the keyboard up, the bottom inset is dropped.
- The input is at least 16px (17px here), so iOS does not zoom the page when it gets focus. Only the upper-window grid font may shrink below that on narrow screens, and it is never focused.
- `manifest.webmanifest` and `icon-512.png` (a copy of `resources/Frotz-512x512.png`) give "Add to Home Screen" a name and icon, plus `apple-touch-icon`, `apple-mobile-web-app-capable` and `theme-color` for each scheme. A Home Screen web app also escapes Safari's 7-day storage eviction.
- `python3 -m http.server` serves `.webmanifest` as `application/octet-stream`. Browsers parse it from `<link rel=manifest>` anyway, but a real host should send `application/manifest+json`.

Only desktop Safari has been tested. Untested on a real iPhone/iPad: the keyboard docking, the safe-area insets, Add to Home Screen, and iOS's handling of `<input type=file>` for saves and stories.

## Stories

The start screen lists `games/stories.json`. Picking a story sets the URL hash, for example `#story=Balances` (the file name without its extension; the parameter and the name are both case-insensitive), so a link opens that story directly. A hash that names no story, or has malformed `%` escapes, shows the picker. While a story loads, the picker says so; a newer pick supersedes a load still fetching, and a failed load puts the picker back with the error. Changing story while one is running reloads the page, since a story is loaded once per WebAssembly instance.

**Open a story file…** plays a Z-code file from the device (`.z3`–`.z8`, `.zblorb`, `.zlb`). Nothing is uploaded. A local file cannot be linked to, so the hash is cleared.

Blorb-wrapped Z-code needs no extra code: `init_memory()` in `frotz/common/fastmem.c` finds the `ZCOD` chunk in a `FORM`/`IFRS` file and sets `fileZCodeOffset`, which loading, `restart`, `save` and `restore` all honour. This was tested with *Lost Pig* (`resources/Games/LostPig.zblorb`, not copied into `web/`): play, `save`, then `restore` in a fresh instance.

### Bundled stories

`games/` holds one story, *Balances* (`Balances.z5`), with its redistribution permission in [`games/LICENSES.md`](games/LICENSES.md). Any other Z-code file can be played with **Open a story file…**. V6 (`.z6`) games load, but pictures are not drawn.

### Adding a story to the catalogue

A story goes into `games/` and `games/stories.json` only with all of this recorded for it in `games/LICENSES.md`:

1. **Release.** Title, author, release and serial number, and the file's SHA-256.
2. **Source.** Where this exact file comes from (for example its IF Archive path), checked to be byte-identical.
3. **Permission.** The text that allows redistribution, quoted, with where it was found (the game's own banner or documentation, a licence file, or a statement from the author). "The iOS app already bundles it" or "it is on the IF Archive" is not permission.
4. **Notices.** The copyright and licence notices the permission requires, and how the web client keeps them (for example a banner the game prints itself), plus any condition the host has to meet, such as no charge.

A story that lacks any of these stays out of the catalogue.

## Saves

`/saves` is plain MEMFS. Nothing mirrors the whole directory to browser storage; each file is stored on its own in IndexedDB by `saves.js` (database `web-frotz`; object store `saves` with key = file name and value `{bytes, mtime, story, rev}`, and a `meta` store with `{size, mtime, story, rev, sha256}` for listing). `saves.js` also holds the save session (`createSaveSession`) and the Saves dialog rendering that this page and the Glulx page share.

- **Revisions.** Each stored file has a revision, `rev`, which starts at 1 and goes up by one with every write. A tab remembers, per file, the revision it last saw: from the first listing that shows the file, from its own writes, and from a restore that copied the stored file into memory. A write runs in one readwrite transaction that reads `meta` first. If the stored revision is the one this tab last saw, it writes bytes and `meta` with `rev + 1`. If not, another tab has saved that file in between, and nothing is written: the result is a **conflict**. Save times are shown but play no part in this, so two saves in the same millisecond are ordered correctly. If the stored bytes are identical to this tab's (same SHA-256), the save counts as stored without a write. A file with no stored record counts as revision 0.
- **Save.** After a successful `save` (and also after a `save` with operands, which writes an auxiliary file), the core calls `os_mark_recent_save()`, and `web_os.c` awaits `js_persist_save(path)` with the path the core asked for. The outcome is always visible:
  - **stored**: no notice.
  - **conflict**: the transcript says "Another tab saved `<name>` more recently. Your save is kept in this session only: Export it, or open Saves and choose Keep this one." The Saves button gets a warning badge.
  - **failed or timed out** (5 seconds): the transcript says "Saved for this session only, not to browser storage. Export it from Saves." and the badge appears.

  The game continues either way, and the save is in MEMFS for this session. The badge stays while any file this tab saved is not in browser storage, and clears when a later save of that file is stored. A reply of "Ok." does not by itself mean the file is in browser storage: only the absence of a notice does.
- **Restore.** Before the core opens the file for `restore` (or a `restore` with operands), `os_read_file_name` awaits `js_load_save(path)`. If this tab's own latest save of that file is not in browser storage (it conflicted or failed), MEMFS keeps it, and the transcript says the restore uses this tab's own copy. Otherwise the stored file is read and copied into MEMFS if MEMFS lacks it or holds a different revision, and the tab adopts that revision, so its next save may replace it. If the read fails or times out, the restore uses what MEMFS has and the transcript says so.
- **Replacing a file in MEMFS.** A restore's copy and an import are written to `<name>.tmp` first and then renamed over the file. If anything fails, the previous file is untouched.
- **Start.** Nothing is loaded at start. The page only lists the store (names, sizes, times, revisions) for the Saves dialog, and the game does not wait for it.
- **Timeouts and cancelling.** Every IndexedDB operation settles within 5 seconds. There is at most one live operation per kind and file. Starting another one cancels the previous one at once: its transaction is aborted if it has not committed, its connection is closed, and its promise rejects. A timeout cancels the same way. The open, the creation of the transaction and each request callback check that their operation is still live before acting, and a connection that opens late is closed unused. A transaction that has already committed cannot be undone: cancelling it then only suppresses its result (the tab still records the revision it wrote, so its next save does not conflict with itself). Each operation opens its own connection and closes it when its transaction ends, so no connection is kept open between saves or held by a page in the back/forward cache.
- `quit` and fatal errors need no flush: a save is already stored or reported when the game continues.
- The **Saves** dialog lists every file in browser storage ("in browser storage") and every file this tab holds only in memory ("this tab only, not in browser storage"). For a conflict it lists **both versions**: the stored one (the other tab's) and this tab's own. Each has **Export**, which downloads exactly that version. This tab's version also has **Keep this one**, which stores it over the stored version shown, and conflicts again if another tab has saved since. **Import save…** checks that the file is a Quetzal save (an IFF `FORM` of type `IFZS`) of at most 4 MB, then writes it as the current story's save name and stores it like a save, so the game's next `RESTORE` loads it. Anything else is rejected and the previous save is kept. The save name is the one the core uses (`<story>.sav`, the story file name up to its first `.`, at most 236 bytes), which `web_os.c` passes to the page.
- The web client does not prompt for file names, so a save always uses the default name. To keep both versions after a conflict, export the one you would otherwise lose.
- Auxiliary files (`save`/`restore` with operands) are stored by the name the game gives them, lower-cased with `.aux` added when it has no extension, under the same rules.
- There is no delete. Removing a save means clearing the site's data in the browser.

**Safari caveat.** WebKit deletes all script-writable storage (IndexedDB included) for a site that has not been visited for 7 days, unless the site has been added to the Home Screen as a web app. Treat browser storage as a cache and export saves you care about.

## What works

- Z-code v3–v8 text games (tested with `Balances.z5`, v5).
- Status line / upper window as a real fixed-pitch grid (see below).
- Text styles and colours in both windows (see below).
- Timed line input (`read` with a timeout and a timeout routine), with V5+ initial text (see "Line input state"). This was checked in Node, not in a browser. Timed `read_char` uses the same timer but has not been tested.
- `save`, `restore`, `undo`, `restart`, `quit`. Saves persist across reloads (see below).

## What does not work (yet)

- There is no file-name prompt. Every save and restore uses `<story>.sav`.
- No sound, no pictures (V6). No true colour (`set_true_colour`): colours outside the standard table fall back to the default.
- No `[MORE]` paging. The transcript just scrolls.
- Games that position the cursor inside the lower window (window 0) still look wrong: window 0 is a reflowing stream, not a grid.
- No visible cursor in the upper window, and no mouse/menu input.
- Transcripts (`script`) and command recording write to MEMFS only.
- A backspace in the output stream (`ZC_BACKSPACE`, rare in games) removes one whole character from text still in `web_os.c`'s output buffer, but cannot remove text already handed to the page. Text is flushed when the interpreter waits for input, when the style, font or colour changes, and when the 8 KB buffer fills.

## Games

The catalogue is *Balances* only. `games/Balances.z5` is a byte-for-byte copy of `resources/Games/Balances.z5` and of the IF Archive's file. *Balances* is one of Graham Nelson's Inform 6 example games, and the Inform licence lets anyone distribute those freely if the copy is unchanged, the copyright messages are kept and no profit is involved. [`games/LICENSES.md`](games/LICENSES.md) quotes the permission and shows how each condition is met.

The other 20 stories in `resources/Games`, which the iOS app bundles, are not in the web client: their terms have not been recorded for it. Each can come back once it has the evidence listed under "Adding a story to the catalogue".

## Glulx

`glulx.html` plays Glulx stories (`.ulx`, `.gblorb`) with `git/` (the faster of the repo's two Glulx interpreters) compiled unmodified to WebAssembly on a small browser Glk library in `glk/`. `index.html` links to it from the story picker. The page looks like the Z-machine client and uses the same save store (`saves.js`).

### How it is built

- `git/` is compiled **without** `FROTZ_IOS`, so none of its iOS code is used. `git.c` and `memory.c` include `"iosfrotz.h"` unconditionally, so `glk/shim/iosfrotz.h` is an empty stand-in for them. `git/config.h` turns on `USE_DIRECT_THREADING` (computed goto), which clang compiles for wasm. `-DUSE_INLINE` is set, as git's own Makefile suggests.
- The Glk headers and the two platform-independent Glk files (`gi_dispa.c` for the dispatch layer, `gi_blorb.c` for Blorb) come unmodified from `glkios/`. `glk/glk_unicode.c` and `glk/glk_date.c` compile `glkios/cgunicod.c` (Unicode case tables) and `glkios/cgdate.c` unmodified. `glk/glkios_compat.h` stands in for the iOS private header they include.
- `glk/git_web.c` is the startup file (the part `git_unix.c` plays on Unix). It reads the story from MEMFS and calls `git()`, which finds the Glulx chunk of a Blorb itself. `fatalError` prints in the story window and exits.
- Before calling `git()`, `git_web.c` validates the file, because neither `gi_blorb.c` nor git checks a Blorb's declared sizes against the real file. It checks that the FORM fits the file, that every chunk fits the FORM, that the resource index has room for its count and its entries, that each entry starts a real chunk, and that the executable is a GLUL chunk whose Glulx header fits it. A bare `.ulx` must have the Glulx magic and a RAMSTART/EXTSTART/ENDMEM map that fits its length. A damaged file is refused with a message in the story window. `node bench/check-malformed.js` (after `make bench`) runs damaged files through the Node build and fails if any of them reaches the game: a truncated FORM, an oversized GLUL chunk (alone, with the FORM length raised to match, and near 4 GB), a short resource index, an index count whose entries do not fit, and a header larger than its image.
- Link flags are Frotz's (`-sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 -sALLOW_MEMORY_GROWTH -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sMODULARIZE -sEXPORTED_RUNTIME_METHODS=callMain,FS -sENVIRONMENT=web`), with `-sEXPORT_NAME=createGit`. The deepest unwind measured uses 236 bytes of the 64 KB Asyncify buffer (see "Measurement").
- `glk/glk_web.c` and `glk/git_web.c` build with `-Wall -Wextra` and no warnings. The `git/` and `glkios/` files also build without warnings at the default level.

### The browser Glk (`glk/glk_web.c`, `glk.js`)

The library owns the window tree and lays it out itself, in CSS pixels, from font metrics the page measures (grid and buffer character cell, window paddings). This is close to GlkOte's model. The window sizes in characters that games read with `glk_window_get_size` come from the same numbers. The page only draws:

- **Text buffer windows.** Output is batched per window as UTF-8 with a style marker at each style change, and handed over when the game waits. The page appends styled spans (and drops the oldest beyond 4000).
- **Text grid windows.** A cell grid (code point and style) is sent whole when it changed, and drawn as rows of spans in a monospace font with the toolbar's colours.
- **Pair windows.** Fixed and proportional splits in all four directions, key windows, `set_arrangement` and closing (the sibling takes the pair's place). `set_arrangement` follows `glkios/ipwindow.c`: changing Above to Below (or Left to Right) swaps the pair's children with the direction, so both windows stay where they are and only the side that gets the size moves. A change of split axis, and a fixed size on a blank key window, are refused. Blank windows are supported. Graphics windows are refused (`glk_window_open` returns NULL).
- **Styles.** The 11 standard styles map to CSS classes `.gs-0` … `.gs-10` in `glulx.html`. Style hints are accepted and ignored. `glk_style_distinguish` reports which styles look different under those classes.

**Input and events.** `glk_select` is the one place the interpreter waits. It flushes output, tells the page which windows want line or char input, and awaits `Module.glkWeb.wait()` from an `EM_ASYNC_JS` function, so ASYNCIFY unwinds the C stack as `web_os.c` does. The page keeps one record per pending request (line or char, maxlen in code points, terminators, the line typed so far), so requests in several windows are independent. There is one command field, and it serves one request at a time: the first line request by default, else the first char request. Tapping another window that has a request switches the field to it (that window gets a thin outline), and the line typed so far in the previous one is kept. A char request takes a key, or the first code point of text that arrives without a usable key event (a soft keyboard, dictation, or the committed text of an input method; `compositionend` and `input` are handled). The rest of such text waits for the next char request. Line length is limited in code points, not with the UTF-16 `maxlength` attribute, so a supplementary character fits in a maxlen of one. In a text grid, line input is limited to the rest of the cursor's row. Line input supports initial text, echo (in the Input style; `glk_set_echo_line_event` applies to the next request), cancelling (which returns the partial line, or the initial text if the line was never shown), and terminators (Escape, F1–F12, Up/Down, PageUp/PageDown, when the game asks for them). Lines typed while the game is busy are queued. Timers are kept in C: `glk_select` passes the time to the next tick as the wait's timeout, and `glk_select_poll` reports a due timer. Missed intervals make one timer event. A select may return an overdue timer at once only if the previous one did not; otherwise it waits on the page with a zero timeout, which is a `setTimeout` macrotask. So a game whose timer handler takes longer than its interval still lets the page paint, resize and deliver input between ticks. A page resize ends the wait with an Arrange event, after which the layout is recomputed and the game redraws (or `glk_select_poll` reports it).

**Files and saves.** Files live in MEMFS. Everything under `/saves` (saved games, data files, transcripts) is persisted one file at a time through `saves.js`: a write-mode stream is written to IndexedDB when it is closed, and a file is brought in from IndexedDB (with the same revision and conflict rules as the Z-machine client, see "Saves") before it is opened or tested with `glk_fileref_does_file_exist`. Output is flushed before each of these, so a storage notice follows the game's own text. `glk_fileref_create_by_prompt` does not prompt. It uses one name per story and usage, like the Z-machine client: `<story>.glksave`, `<story>.txt` (transcript), `<story>.rec` (command record), `<story>.glkdata`. `glk_fileref_create_by_name` gives `/saves/<name>.<suffix>`, shared between stories as the Glk spec intends. Temporary files go to `/tmp` and are not stored. The Saves dialog, Export and Import work as in the Z-machine client. Glulx saves are Quetzal files too, and Import replaces `<story>.glksave`. A file the game deletes (`glk_fileref_delete_file`) is removed from MEMFS and from IndexedDB: `saves.js`'s `remove` deletes the bytes and leaves a tombstone in `meta` at the next revision, so the file stays deleted after a reload, existence checks find nothing, the Saves dialog leaves it out, and a stale tab that saves the old version afterwards gets the usual conflict. The delete is awaited, like a save. If the tombstone cannot be written (no storage, a failure, or another tab saved the file since), a notice says so and the file is hidden for the rest of the session.

**Gestalt.** Version 0.7.4, Unicode, timers, line echo, line terminators, date/time and resource streams are reported as supported. Mouse input, graphics, images, sound, hyperlinks and Unicode normalisation are reported as unsupported, and their calls are stubs.

### What has been checked, and how

`make check` builds `bench/glk-check.c`, a small Glk program on the plain bridge, and runs it with `bench/check-glk.js`: `set_arrangement` direction and axis changes, a nested key, closing a key, a blank fixed key, grid line limits and echo wrapping, cancelling a line before it is shown, echo per request, consecutive overdue timers (each waits on the page with a zero timeout), and deleting a `/saves` file. It then runs `bench/check-malformed.js`.

There is no browser test from this branch yet. Everything below ran in Node, with the same objects:

- `bench/run-bench.js` plays a story through a Node build with a scripted `Module.glkWeb`. *Adventure* ran 234 turns, including a SAVE and a RESTORE. `git/test/Alabaster.gblorb` (Blorb, Inform 7, git's own test case) played to its ending. Its story text matches `git/test/Alabaster.golden` line for line (164 of 164 lines), once the golden file's CheapGlk status-window errors and the echoed commands are set aside.
- `glk.js` ran in Node on a minimal DOM stub against the ASYNCIFY build. Covered: window layout (status grid plus buffer), the grid's status line, buffer text with styles, typing commands, type-ahead, SAVE and RESTORE (with no IndexedDB, so the "session only" notice and badge appear), and a resize (an Arrange event; the game redrew a narrower status line).
- Not run at all: Safari or any real browser, IndexedDB persistence for Glulx saves, timers, char input, line terminators and multi-window games beyond a status line.

### Measurement: ASYNCIFY or a worker?

`make bench && node bench/measure.js --runs 9` plays the same stories with the same commands under (a) the ASYNCIFY build and (b) a plain build without ASYNCIFY. In (b) `glk_select` gets its event from a plain function call; it is compiled with `-DGLK_WEB_SYNC`, and nothing else differs. Each run is a fresh Node process, the builds alternate, and Date.now is pinned so both play identical games (the transcript hashes match). A turn is the time from one input wait to the next, so under ASYNCIFY it includes the unwind and the rewind. The table shows medians of 9 runs (Node 22.21.1, Apple Silicon):

| Story | Build | Turns | Startup ms | All turns ms | Mean turn ms | Slowest turn ms | Turn time vs plain | Asyncify buffer used |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Advent.ulx (Inform 6) | (b) plain | 234 | 3.7 | 33.3 | 0.142 | 0.6 | 1× | – |
| Advent.ulx (Inform 6) | (a) ASYNCIFY | 234 | 6.2 | 39.6 | 0.169 | 0.8 | 1.19× | 236 B |
| Alabaster.gblorb (Inform 7) | (b) plain | 43 | 5.6 | 5449.5 | 126.7 | 396.4 | 1× | – |
| Alabaster.gblorb (Inform 7) | (a) ASYNCIFY | 43 | 8.5 | 5189.7 | 120.7 | 378.1 | 0.95× | 216 B |

Sizes: `git.wasm` is 264,700 bytes with ASYNCIFY and 189,365 bytes without (+40%). `git.js` is 71,156 bytes.

**Recommendation: ASYNCIFY for every interpreter.** On both stories (a) is within 20% of (b):

- On *Adventure*, whose turns take a seventh of a millisecond, ASYNCIFY adds a fixed ~27 µs per turn for the unwind, the Promise and the rewind. That is 19% of almost nothing, and no player can see it. This ratio is the noisiest number in the table. An earlier 7-run measurement gave 1.17×.
- On *Alabaster*, whose turns take 30–400 ms of interpreter work, the ASYNCIFY build was not slower. It was about 5% faster in every set of runs, for reasons not investigated (the binary is laid out and optimised differently).
- The costs that remain are 75 KB more wasm and a little more startup time (2–3 ms).

A worker with `SharedArrayBuffer` and `Atomics.wait` would also need COOP/COEP headers (see "Serve"), a message protocol and a second JS context. Nothing here justifies that. Revisit it only if an interpreter needs a stack deeper than ASYNCIFY can unwind cheaply, or if a large game shows a cost that this measurement did not.

### Not done yet

- Graphics windows, images, sound, hyperlinks, mouse input: stubbed, gestalt false.
- Style hints are ignored. There is no per-game colour.
- `glulxe/` is not built. It should only need its own startup file next to `glk/git_web.c`.
