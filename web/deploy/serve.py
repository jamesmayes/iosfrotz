#!/usr/bin/env python3
# web/deploy/serve.py: serve the built site locally (`make serve`) with the
# headers deploy/README.md asks a host for:
#
#   .wasm -> application/wasm, .webmanifest -> application/manifest+json
#   assets/* (content-hashed) -> Cache-Control: public, max-age=31536000, immutable
#   everything else           -> Cache-Control: no-cache (revalidate)
#
#   python3 deploy/serve.py [dir] [port]   (defaults: dist-site 8000)
#
# Binds to 127.0.0.1 only. Not for production; any static host will do.

import http.server
import os
import sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "dist-site")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".json": "application/json",
        ".md": "text/markdown; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        if self.path.split("?")[0].startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if not os.path.isfile(os.path.join(ROOT, "index.html")):
    sys.exit(f"serve.py: no index.html in {ROOT} (run make dist)")
print(f"Serving {ROOT} on http://127.0.0.1:{PORT}/")
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
