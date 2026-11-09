# Deploying Web Frotz

`make dist` (from `web/`) builds the interpreters if needed and writes `web/dist-site/`, a static site that any static host can serve as it is. `make serve` builds it and serves it on <http://127.0.0.1:8000/> with the headers below. `dist-site/` is ignored by git and rebuilt from scratch each time.

## What is in `dist-site/`

| Path | What | Cache |
|---|---|---|
| `index.html` | the start page, with an inline map of the hashed asset names | revalidate |
| `glulx.html` | redirect for old `glulx.html#story=…` links | revalidate |
| `manifest.webmanifest`, `icon-512.png` | Home Screen web app | revalidate |
| `assets/<name>.<hash>.js`, `assets/<name>.<hash>.wasm` | `saves.js`, `ui.js`, `main.js`, `app.js`, `glk.js`, `frotz.js`/`.wasm`, `git.js`/`.wasm`, `tads2.js`/`.wasm`, `tads3.js`/`.wasm` | forever |
| `games/stories.json`, the stories it lists, `games/LICENSES.md` | the catalogue | revalidate |

The hash is the first 10 hex digits of the file's SHA-256, so a changed file always gets a new name, and a page that revalidates `index.html` picks it up. The same sources give the same names (`deploy/build-site.js`). Every URL in the site is relative, so it works at a domain's root or under a path (`https://example.org/frotz/`).

The site is about 3.8 MB, of which `icon-512.png` is 0.34 MB and the four `.wasm` files 2.7 MB (1.7 MB of it `tads3.wasm`); the per-file sizes are in the web README ("Deploy"). Only the interpreter a story needs is fetched: Frotz for Z-code, git for Glulx, TADS 2 or TADS 3 for theirs.

## Headers to send

| Files | Header |
|---|---|
| `*.wasm` | `Content-Type: application/wasm` |
| `*.webmanifest` | `Content-Type: application/manifest+json` |
| `*.js` | `Content-Type: text/javascript` |
| `assets/*` | `Cache-Control: public, max-age=31536000, immutable` |
| everything else | `Cache-Control: no-cache` (or a short `max-age`) |

- **Without `application/wasm`** the page still works. Emscripten's streaming compile refuses the response, logs a warning and falls back to fetching the whole file and compiling it, which is a little slower.
- **No COOP/COEP is needed.** The build uses no threads and no `SharedArrayBuffer`, so the page does not have to be cross-origin isolated. Leave `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` unset unless something else on the host needs them.
- **Serve over HTTPS.** Saves use IndexedDB and Web Locks, and Web Locks (the one-writer-tab rule, `../README.md`, "Architecture") exist only in a secure context. Over plain HTTP from another machine, every tab writes and conflicts are caught by the per-file revisions instead. `localhost` and `127.0.0.1` count as secure.
- **Compression.** gzip or brotli for `.js`, `.wasm`, `.json` and `.html` is worth turning on; the two `.wasm` files shrink by about two thirds.
- Story files (`.z5`, `.ulx`, `.gblorb`, …) can be sent as `application/octet-stream`. The page reads their bytes and ignores the type.

`deploy/serve.py`, used by `make serve`, sends exactly these headers (without compression), so `curl -I` against it shows what a host should match.

## GitHub Pages

GitHub Pages can host `dist-site/` as it is:

- Publish the *contents* of `dist-site/` (for example to a `gh-pages` branch, or as the artifact of the `actions/upload-pages-artifact` workflow step). Add an empty `.nojekyll` file next to `index.html` so that Pages serves the files without running Jekyll over them.
- Pages serves `.wasm` as `application/wasm` and serves over HTTPS, so both of the requirements above are met.
- Pages does not let a site set headers. It sends `Cache-Control: max-age=600` for every file, so the hashed assets are re-checked every 10 minutes instead of cached for good. That costs a revalidation, not correctness: a new deploy is seen within 10 minutes, and the hashed names mean the page never mixes old and new scripts.
- Check the content types after the first deploy, for example `curl -sI https://<user>.github.io/<repo>/assets/<name>.wasm`.

## Before publishing

Read `../games/LICENSES.md`: the catalogue ships only stories whose redistribution has been recorded, and the interpreters' own licences (Frotz, git) apply to the `.wasm` builds.
