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

The page fetches `dist/frotz.wasm` and `games/Balances.z5`, so it has to be served over HTTP. Opening it with `file://` does not work.

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

## What works

- Z-code v3–v8 text games (tested with `Balances.z5`, v5).
- Status line / upper window, drawn as a monospaced grid above the transcript.
- Text styles (bold, italic, fixed, reverse) as CSS classes.
- Timed input (`read` with a timeout).
- `save`, `restore`, `undo`, `restart`, `quit`. Saves go to MEMFS under `/saves`.

## What does not work (yet)

- Saves do not persist across page reloads. MEMFS only; there is no IDBFS or download.
- There is no file-name prompt. Every save and restore uses `<story>.sav`.
- No choice of story: `app.js` hard-codes `games/Balances.z5`. Blorb-wrapped stories (`.zblorb`) have not been tried.
- No sound, no pictures (V6), no colours (colour is turned off in the header).
- No `[MORE]` paging. The transcript just scrolls.
- Upper-window games that position the cursor in window 0 or rely on `os_scroll_area` (cursor-driven layouts) will look wrong.
- Transcripts (`script`) and command recording write to MEMFS only.

## Game

`games/Balances.z5` is Graham Nelson's *Balances* (1994–96, Release 5). It is one of the example games shipped with the Inform design system, it is freely distributed on the IF Archive, and the iOS app already bundles it (`resources/Games/Balances.z5`).
