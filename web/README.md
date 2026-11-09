# Web Frotz (WebAssembly spike)

This is the Z-machine interpreter from `frotz/common`, compiled unmodified to WebAssembly with emscripten. A small browser OS layer (`src/web_os.c`) and a plain HTML/JS front end (`index.html`, `app.js`) sit on top of it. It is a spike. It shows that the toolchain works and that the interpreter's blocking input can run in the browser's event loop.

## Build

Requires emscripten (`emcc`, tested with 7.0.0 from Homebrew).

```sh
cd web
make            # -> dist/frotz.js (~70 KB) + dist/frotz.wasm (~144 KB)
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
- On a timeout, the page returns what has been typed so far, and `os_read_line` puts it in `buf` and returns `ZC_TIME_OUT`. Nothing is echoed. The core runs the game's timeout routine. If the routine continues the read, the core calls `os_read_line` again with `continued` set and the partial line in `buf`, and the field still holds it. Text the routine printed is flushed first, so it appears before the line's echo. If the routine ends the read, the game gets the partial line as typed, and the next read replaces the field.
- A line typed ahead (submitted while no read was waiting) was typed without the initial text in view, so it is taken as the whole line.

This was checked in Node with the same objects and a scripted front end, using a small hand-assembled V5 story: initial text `abc`, a 1-second timed `aread`, and a timeout routine that prints `*` and continues the first time, then ends the read. Ending on the second timeout stored `abcXY` (length 5). Pressing Enter after one timeout echoed `*` and then `abcXZ`, and stored `abcxz`. Editing the initial text to `aBc` stored `abc`. That harness replaces `app.js`, so the input-field handling in `app.js` itself has not been run. Nothing has been tried in a browser with a real timed game.

## Upper window

Window 1 (and the V3 status line, which Frotz draws in window 7) is a grid of `h_screen_rows` × `h_screen_cols` cells in `web_os.c`. Each cell holds a character and an attribute word (style, foreground and background colour). `os_set_cursor` positions writes, and `os_erase_area` and `os_scroll_area` act on the cells. When the interpreter waits for input, the grid goes to `app.js` in one call (pointers into the wasm heap), and it is drawn as rows of styled spans in a monospace font. So status lines, boxes, quotation boxes and menus keep their layout.

**Screen size.** At load, `app.js` measures the grid font and picks as many columns as fit the reading column (at most 48rem, so about 79 at 15px). On a narrow screen it keeps at least 52 columns by shrinking the grid font (not the input). Rows come from the window height. The core reads this in `os_init_screen`.

**Resize.** On a window resize the page refits the grid at once and passes the new column count to the core at its next read, both before the read and when the read returns, so the game's next status redraw uses it. `web_os.c` then sets `h_screen_cols`/`h_screen_width`, calls `resize_screen()` (the window sizes) and `restart_header()` (the header the game reads). Nothing is interrupted, so no `ZC_TIME_OUT` is sent. Only the width changes at runtime. The row count stays as sized at load, because shrinking it under a split upper window could leave the lower window with no rows. Most games redraw their status line every turn; an upper-window menu already on screen keeps its old layout (clipped) until the game redraws it.

## Styles and colours

`os_set_text_style` (reverse, bold, italic, fixed) and `os_set_colour` both feed one attribute word (`style | fg << 8 | bg << 16`) that goes with every span of lower-window text and every upper-window cell. Font 4 (fixed pitch) counts as the fixed style.

- The header reports colour support (`CONFIG_COLOUR`, V5+) and, as `frotz/ios/ui_init.c` does, reports colour 1 as the default foreground and background. So "default" text follows the page's scheme.
- Colours 2–12 (black, red, green, yellow, blue, magenta, cyan, white, then the three greys) map to the CSS variables `--z2` … `--z12` in `index.html`. Each has a light and a dark value under `prefers-color-scheme`, tuned so that the default text stays readable.
- Reverse video swaps foreground and background, defaults included.
- Erasing the screen (`erase_window`) fills it with the current background colour by setting `--screen-bg`, which is the page background. Erased upper-window cells keep the background colour too.

## Mobile Safari

- `viewport-fit=cover`, with `env(safe-area-inset-*)` padding on the toolbar (top), the page sides (landscape notch) and the input bar (bottom, the home indicator).
- iOS does not shrink the layout viewport for the software keyboard; it shrinks and scrolls the *visual* viewport. `app.js` listens to `visualViewport` `resize`/`scroll` and pins the body to it (`--app-top`, `--app-height`). So the input stays docked just above the keyboard and the transcript fills the rest. With the keyboard up, the bottom inset is dropped.
- The input is at least 16px (17px here), so iOS does not zoom the page when it gets focus. Only the upper-window grid font may shrink below that on narrow screens, and it is never focused.
- `manifest.webmanifest` and `icon-512.png` (a copy of `resources/Frotz-512x512.png`) give "Add to Home Screen" a name and icon, plus `apple-touch-icon`, `apple-mobile-web-app-capable` and `theme-color` for each scheme. A Home Screen web app also escapes Safari's 7-day storage eviction.
- `python3 -m http.server` serves `.webmanifest` as `application/octet-stream`. Browsers parse it from `<link rel=manifest>` anyway, but a real host should send `application/manifest+json`.

Only desktop Safari has been tested. Untested on a real iPhone/iPad: the keyboard docking, the safe-area insets, Add to Home Screen, and iOS's handling of `<input type=file>` for saves and stories.

## Stories

The start screen lists `games/stories.json`. Picking a story sets the URL hash, for example `#story=Balances` (the file name without its extension, case-insensitive), so a link opens that story directly. Changing story while one is running reloads the page, since a story is loaded once per WebAssembly instance.

**Open a story file…** plays a Z-code file from the device (`.z3`–`.z8`, `.zblorb`, `.zlb`). Nothing is uploaded. A local file cannot be linked to, so the hash is cleared.

Blorb-wrapped Z-code needs no extra code: `init_memory()` in `frotz/common/fastmem.c` finds the `ZCOD` chunk in a `FORM`/`IFRS` file and sets `fileZCodeOffset`, which loading, `restart`, `save` and `restore` all honour. This was tested with *Lost Pig* (`resources/Games/LostPig.zblorb`, not copied into `web/`): play, `save`, then `restore` in a fresh instance.

### Bundled stories

`games/` holds the 21 `.z5`/`.z8` files from `resources/Games`, which the iOS app already ships (the Xcode project bundles that folder as a resource). The `.zblorb` files there are not copied. V6 (`.z6`) games load, but pictures are not drawn.

## Saves

`/saves` is plain MEMFS. Nothing mirrors the whole directory to browser storage; each save file is stored on its own in IndexedDB by `saves.js` (database `web-frotz`, object store `saves` with key = file name and value `{bytes, mtime, story}`, plus a `meta` store with `{size, mtime, story}` for listing):

- **Save.** After a successful `save`, the core calls `os_mark_recent_save()`, and `web_os.c` awaits `js_persist_save(path)`. That writes this one file in one readwrite transaction (both stores). If it fails or times out (5 seconds), the game still continues, the transcript shows "Saved for this session only, not to browser storage. Export it from Saves.", and the **Saves** button gets a warning badge. The badge clears only when a later save is written to storage. The game does wait for the write before it prints its reply, but a reply of "Ok." does not by itself mean the file is in browser storage: only the absence of that notice does.
- **Restore.** Before the core opens the file for `restore`, `os_read_file_name` awaits `js_load_save(path)`. That reads this one file and copies it into MEMFS if MEMFS lacks it or the stored copy is newer. If the read fails or times out, the restore uses what MEMFS has (if anything) and the transcript says so. A slow read delays only that restore.
- **Start.** Nothing is loaded at start. The page only lists the store (names, sizes, times) for the Saves dialog, and the game does not wait for it.
- **Several tabs.** Each file is decided on its own, and the copy saved later wins: `put` reads the stored record in the same transaction and does not replace one with a later save time. A tab only ever writes the file it just saved, so it cannot overwrite or delete another tab's other files, and a tab that loaded an old save cannot overwrite a newer one written by another tab. If two tabs save the same file, the later save is kept.
- **Timeouts.** Every IndexedDB operation settles within 5 seconds. Each one carries a generation number for its file name, and once it times out (or a newer operation of the same kind on the same file starts) it is superseded: its late result is ignored, a write still in its transaction is aborted, and a connection that opens late is closed unused. Each operation opens its own connection and closes it when its transaction ends, so no connection is kept open between saves or held by a page in the back/forward cache.
- `quit` and fatal errors need no flush: a save is already stored when the game continues.
- The **Saves** button lists the saves in browser storage and any newer ones this page holds only in memory (marked "this session only"). **Export** downloads one. **Import save…** checks that the file is a Quetzal save (an IFF `FORM` of type `IFZS`) of at most 4 MB, then writes it as the current story's save name and stores it, so the game's next `RESTORE` loads it. Anything else is rejected and the previous save is kept. The save name is the one the core uses (`<story>.sav`, the story file name up to its first `.`, at most 236 bytes), which `web_os.c` passes to the page.
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

Every file in `games/` is a byte-for-byte copy of a file in `resources/Games`, which the iOS app already redistributes. The list, with authors, is in `games/stories.json`.

Redistribution terms are in [`games/LICENSES.md`](games/LICENSES.md). *Balances* is one of Graham Nelson's Inform 6 example games, and the Inform licence lets anyone distribute those freely if the copy is unchanged (ours is byte-identical to the IF Archive's), the copyright messages are kept and no profit is involved. That file quotes the permission and shows how each condition is met. The terms of the other 20 stories have not been checked yet. Each needs the same evidence, or should be removed, before the web client is published.
