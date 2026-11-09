# Web Frotz (WebAssembly spike)

This is the Z-machine interpreter from `frotz/common`, compiled unmodified to WebAssembly with emscripten. A small browser OS layer (`src/web_os.c`) and a plain HTML/JS front end (`index.html`, `app.js`) sit on top of it. It is a spike. It shows that the toolchain works and that the interpreter's blocking input can run in the browser's event loop.

## Build

Requires emscripten (`emcc`, tested with 7.0.0 from Homebrew).

```sh
cd web
make            # -> dist/frotz.js (~62 KB) + dist/frotz.wasm (~142 KB)
make clean
```

`dist/` (including the object files in `dist/obj/`) is git-ignored.

### How the core is compiled

- `-DFROTZ_IOS=1`: the core in this repo has iOS changes, and it references iOS-only globals (`do_autosave`, `fileZCodeOffset`, `AUTOSAVE_FILE`) even when `FROTZ_IOS` is not set, so it only compiles in iOS mode.
- `-Ishim` comes before `-I../frotz/common`. `screen.c` includes `"iosfrotz.h"` unconditionally. `shim/iosfrotz.h` stands in for `include/iosfrotz.h` (which pulls in CoreGraphics and Glk) and declares only what the core needs.
- `frotz/dumb/` is **not** used. It no longer compiles against this core: `zchar` is 16-bit because `USE_UTF8` is hard-wired in `frotz.h`, and it has conflicting `os_display_char` and `getline` signatures. `src/web_os.c` implements the `os_*` interface directly, modelled on `frotz/ios/ui_*.c`.
- Link flags: `-sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 -sALLOW_MEMORY_GROWTH -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sMODULARIZE -sEXPORT_NAME=createFrotz -sEXPORTED_RUNTIME_METHODS=callMain,FS -sENVIRONMENT=web`.

## Serve

The page fetches `dist/frotz.wasm`, `games/stories.json` and the chosen story, so it has to be served over HTTP. Opening it with `file://` does not work.

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

`/saves` is mounted on IDBFS (`-lidbfs.js`), so save files live in the browser's IndexedDB:

- At start, `app.js` mounts `/saves` and calls `FS.syncfs(true)` to load earlier saves before the game runs.
- After every successful `save` or `restore`, the core calls `os_mark_recent_save()`. `web_os.c` then awaits `FS.syncfs(false)` through an `EM_ASYNC_JS` call, so the file is in IndexedDB before the game prints "Ok.". `quit` (the end of `main()`) and `os_fatal` sync the same way.
- `syncfs(false)` makes IndexedDB a mirror of `/saves`, deleting files it does not have. So before each sync, `app.js` first copies in any save that exists only in IndexedDB (written by another tab since this one loaded).
- Each sync gives up after 5 seconds, so the game cannot hang on storage. During testing, Safari twice left the saves database locked: transactions on it never completed until the tab was closed. The first time a second, backgrounded tab was open (an earlier build synced on `visibilitychange`). The second time the previous page in the same tab had been navigated away from, and was probably held in the back/forward cache. Neither could be reproduced on demand. So the page no longer syncs on `visibilitychange`, it closes its IndexedDB connection on `pagehide` (IDBFS reopens it on the next sync, which was checked with a page restored from the back/forward cache), and it reports the problem in the Saves dialog when storage does not respond. Opening the Saves dialog also retries loading saves that the start-up sync missed.
- The **Saves** button lists the files in `/saves`. **Export** downloads one as a file. **Import save…** reads a `.sav` file and writes it as the current story's save name (`<story>.sav`), so the game's next `RESTORE` loads it.

**Safari caveat.** WebKit deletes all script-writable storage (IndexedDB included) for a site that has not been visited for 7 days, unless the site has been added to the Home Screen as a web app. Treat browser storage as a cache and export saves you care about.

## What works

- Z-code v3–v8 text games (tested with `Balances.z5`, v5).
- Status line / upper window as a real fixed-pitch grid (see below).
- Text styles and colours in both windows (see below).
- Timed input (`read` with a timeout).
- `save`, `restore`, `undo`, `restart`, `quit`. Saves persist across reloads (see below).

## What does not work (yet)

- There is no file-name prompt. Every save and restore uses `<story>.sav`.
- No sound, no pictures (V6). No true colour (`set_true_colour`): colours outside the standard table fall back to the default.
- No `[MORE]` paging. The transcript just scrolls.
- Games that position the cursor inside the lower window (window 0) still look wrong: window 0 is a reflowing stream, not a grid.
- No visible cursor in the upper window, and no mouse/menu input.
- Transcripts (`script`) and command recording write to MEMFS only.

## Games

Every file in `games/` is a byte-for-byte copy of a file in `resources/Games`, which the iOS app already redistributes. The list, with authors, is in `games/stories.json`.
