# Build the interpreters to WebAssembly with emscripten:
#
#   - Frotz (Z-machine): the core in frotz/common plus the browser OS layer
#     web/src/web_os.c;
#   - Git (Glulx): git/ plus the browser Glk in web/glk/.
#
#   make            -> dist/frotz.js + dist/frotz.wasm, dist/git.js + dist/git.wasm
#   make frotz      -> dist/frotz.js + dist/frotz.wasm
#   make git        -> dist/git.js + dist/git.wasm
#   make bench      -> dist/bench/git-async.{js,wasm} and git-sync.{js,wasm},
#                      Node builds of git for bench/run-bench.js
#   make check      -> builds dist/bench/glk-check.{js,wasm} (bench/glk-check.c
#                      on the browser Glk) and git-sync, then runs
#                      bench/check-glk.js, bench/check-malformed.js and
#                      bench/check-page.js (glk.js and saves.js on fakes)
#   make dist       -> dist-site/: the static site to deploy (deploy/build-site.js;
#                      hashed asset names, see deploy/README.md)
#   make serve      -> make dist, then serve dist-site/ on 127.0.0.1:8000 with
#                      the headers deploy/README.md asks for (deploy/serve.py)
#   make serve-dev  -> python3 -m http.server on :8000 from web/ (unhashed)
#   make clean      -> removes dist/ and dist-site/

EMCC    ?= emcc
ROOT    := ..
CORE    := $(ROOT)/frotz/common
OBJDIR  := dist/obj
DIST    := dist
BENCH   := dist/bench
SITE    := dist-site

CORE_SRC := buffer err fastmem files hotkey input main math object process \
            quetzal random redirect screen sound stream table text variable
CORE_OBJ := $(addprefix $(OBJDIR)/,$(addsuffix .o,$(CORE_SRC)))
WEB_OBJ  := $(OBJDIR)/web_os.o

# FROTZ_IOS=1: the core references iOS-only globals (do_autosave,
# fileZCodeOffset, ...) unconditionally, so it only compiles in iOS mode.
# web/shim comes first so screen.c's #include "iosfrotz.h" finds the web
# stand-in instead of include/iosfrotz.h (which pulls in CoreGraphics/Glk).
CFLAGS  := -O2 -DFROTZ_IOS=1 -Ishim -I$(CORE)

# Diagnostics: the browser layer is built with -Wall -Wextra. The core
# (frotz/common) gets the compiler's default diagnostics and, with
# shim/iosfrotz.h, compiles without a warning, so it needs no -Wno-*
# suppressions. If a legacy core file ever needs one, add it to
# CORE_CFLAGS, which applies to frotz/common objects only.
CORE_CFLAGS :=
WEB_CFLAGS  := -Wall -Wextra

HEADERS := $(wildcard $(CORE)/*.h) shim/iosfrotz.h

# ---- Git (Glulx) ----
#
# git/ is compiled without FROTZ_IOS, so none of its iOS code is used.
# git.c and memory.c include "iosfrotz.h" anyway; glk/shim/iosfrotz.h is an
# empty stand-in. Glk headers (glk.h, gi_dispa.h, gi_blorb.h) and the two
# platform-independent Glk files (gi_dispa.c, gi_blorb.c) come from
# glkios/, unmodified. USE_INLINE is what git's own Makefile suggests for
# GCC and Clang; git/config.h already turns on USE_DIRECT_THREADING.
GIT       := $(ROOT)/git
GLKIOS    := $(ROOT)/glkios
GIT_SRC   := git memory compiler opcodes operands peephole terp glkop search \
             savefile saveundo gestalt heap accel
GIT_OBJ   := $(addprefix $(OBJDIR)/git/,$(addsuffix .o,$(GIT_SRC)))
GIDISP_OBJ := $(OBJDIR)/glk/gi_dispa.o $(OBJDIR)/glk/gi_blorb.o
GLK_COMMON := $(GIDISP_OBJ) $(OBJDIR)/glk/glk_unicode.o $(OBJDIR)/glk/glk_date.o \
              $(OBJDIR)/glk/git_web.o
GLK_ASYNC_OBJ := $(GLK_COMMON) $(OBJDIR)/glk/glk_web.o
GLK_SYNC_OBJ  := $(GLK_COMMON) $(OBJDIR)/glk/glk_web_sync.o
# The Glk checks: the library without git (bench/glk-check.c is the game).
# Without git, nothing else pulls in the string helpers glk_web.c's EM_JS
# bridge uses, so they are named here.
CHECK_OBJ := $(GIDISP_OBJ) $(OBJDIR)/glk/glk_unicode.o $(OBJDIR)/glk/glk_date.o \
             $(OBJDIR)/glk/glk_web_sync.o $(OBJDIR)/glk/glk-check.o
CHECK_LIBS := -sEXPORTED_RUNTIME_METHODS=callMain,FS,stringToUTF8,UTF8ToString

GIT_CFLAGS := -O2 -DUSE_INLINE -Iglk/shim -Iglk -I$(GLKIOS) -I$(GIT)
GIT_HEADERS := $(wildcard $(GIT)/*.h) $(GIT)/labels.inc $(GLKIOS)/glk.h \
               $(GLKIOS)/gi_dispa.h $(GLKIOS)/gi_blorb.h glk/shim/iosfrotz.h \
               glk/glk_web.h glk/glkios_compat.h

LDFLAGS_COMMON := -O2 \
           -sALLOW_MEMORY_GROWTH \
           -sINVOKE_RUN=0 \
           -sEXIT_RUNTIME=1 \
           -sMODULARIZE \
           -sEXPORTED_RUNTIME_METHODS=callMain,FS

LDFLAGS := $(LDFLAGS_COMMON) \
           -sASYNCIFY \
           -sASYNCIFY_STACK_SIZE=65536 \
           -sEXPORT_NAME=createFrotz \
           -sENVIRONMENT=web

# Git: the same flags as Frotz. ASYNCIFY_STACK_SIZE is the size of the
# buffer the unwound C stack is saved in. bench/run-bench.js measures how
# much of it an unwind uses (236 bytes at most for git; README.md, "Glulx"),
# so 64 KB is ample headroom.
GIT_ASYNC_STACK ?= 65536
GIT_LDFLAGS := $(LDFLAGS_COMMON) \
           -sASYNCIFY \
           -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK) \
           -sEXPORT_NAME=createGit \
           -sENVIRONMENT=web

# Node builds for the measurement: the same code, with and without ASYNCIFY.
BENCH_LDFLAGS := $(LDFLAGS_COMMON) -sEXPORT_NAME=createGit -sENVIRONMENT=node

all: frotz git

frotz: $(DIST)/frotz.js $(DIST)/frotz.wasm
git: $(DIST)/git.js $(DIST)/git.wasm
# Each link writes a .js and a .wasm; both are named, so a missing .wasm is
# rebuilt even when its .js is present.
bench: $(BENCH)/git-async.js $(BENCH)/git-async.wasm $(BENCH)/git-sync.js $(BENCH)/git-sync.wasm

check: $(BENCH)/glk-check.js $(BENCH)/glk-check.wasm $(BENCH)/git-sync.js $(BENCH)/git-sync.wasm
	node bench/check-glk.js
	node bench/check-malformed.js
	node bench/check-page.js

# dist/ itself is created with dist/obj (the links order on $(OBJDIR)), so
# that `dist` can be the phony target that builds the site.
$(OBJDIR) $(OBJDIR)/git $(OBJDIR)/glk $(BENCH):
	mkdir -p $@

# Link flags per output. dist/obj/<name>.ldflags holds the flags the output
# was last linked with; the link recipe writes it after a successful link.
# When make reads this file it only compares the flags with the stamp (a
# read-only cmp): if they differ, or there is no stamp, that output's .js
# and .wasm get the phony prerequisite FORCE and are relinked. So changing
# a flag (GIT_ASYNC_STACK=..., an edit here) relinks just the outputs it
# affects, and nothing is written or removed while the Makefile is parsed,
# so `make -n` never touches dist/. The decision does not depend on the
# stamp's mtime, which matters on GNU make 3.81: its timestamps are whole
# seconds, so a stamp written in the same second as the last link would not
# count as newer.
LINK_frotz     := $(LDFLAGS)
LINK_git       := $(GIT_LDFLAGS)
LINK_git-async := $(BENCH_LDFLAGS) -sASYNCIFY -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK)
LINK_git-sync  := $(BENCH_LDFLAGS)
LINK_glk-check := $(BENCH_LDFLAGS) $(CHECK_LIBS)
LINK_OUTPUTS   := frotz git git-async git-sync glk-check
OUT_frotz      := $(DIST)/frotz
OUT_git        := $(DIST)/git
OUT_git-async  := $(BENCH)/git-async
OUT_git-sync   := $(BENCH)/git-sync
OUT_glk-check  := $(BENCH)/glk-check

stale_link = $(shell printf '%s\n' '$(LINK_$(1))' | cmp -s - $(OBJDIR)/$(1).ldflags 2>/dev/null || echo stale)
$(foreach n,$(LINK_OUTPUTS),$(if $(call stale_link,$(n)),$(eval $(OUT_$(n)).js $(OUT_$(n)).wasm: FORCE)))
# Recipe line: record the flags an output was just linked with.
stamp_link = printf '%s\n' '$(LINK_$(1))' > $(OBJDIR)/$(1).ldflags
FORCE:

$(OBJDIR)/%.o: $(CORE)/%.c $(HEADERS) | $(OBJDIR)
	$(EMCC) $(CFLAGS) $(CORE_CFLAGS) -c $< -o $@

$(OBJDIR)/web_os.o: src/web_os.c $(HEADERS) | $(OBJDIR)
	$(EMCC) $(CFLAGS) $(WEB_CFLAGS) -c $< -o $@

$(OBJDIR)/git/%.o: $(GIT)/%.c $(GIT_HEADERS) | $(OBJDIR)/git
	$(EMCC) $(GIT_CFLAGS) -c $< -o $@

$(OBJDIR)/glk/gi_%.o: $(GLKIOS)/gi_%.c $(GIT_HEADERS) | $(OBJDIR)/glk
	$(EMCC) $(GIT_CFLAGS) -c $< -o $@

$(OBJDIR)/glk/glk_unicode.o: glk/glk_unicode.c $(GLKIOS)/cgunicod.c $(GLKIOS)/cgunigen.c \
                             $(GIT_HEADERS) | $(OBJDIR)/glk
	$(EMCC) $(GIT_CFLAGS) -c $< -o $@

$(OBJDIR)/glk/glk_date.o: glk/glk_date.c $(GLKIOS)/cgdate.c $(GIT_HEADERS) | $(OBJDIR)/glk
	$(EMCC) $(GIT_CFLAGS) -c $< -o $@

$(OBJDIR)/glk/glk_web.o: glk/glk_web.c $(GIT_HEADERS) | $(OBJDIR)/glk
	$(EMCC) $(GIT_CFLAGS) $(WEB_CFLAGS) -c $< -o $@

$(OBJDIR)/glk/glk_web_sync.o: glk/glk_web.c $(GIT_HEADERS) | $(OBJDIR)/glk
	$(EMCC) $(GIT_CFLAGS) $(WEB_CFLAGS) -DGLK_WEB_SYNC -c $< -o $@

$(OBJDIR)/glk/git_web.o: glk/git_web.c $(GIT_HEADERS) | $(OBJDIR)/glk
	$(EMCC) $(GIT_CFLAGS) $(WEB_CFLAGS) -c $< -o $@

$(OBJDIR)/glk/glk-check.o: bench/glk-check.c $(GIT_HEADERS) | $(OBJDIR)/glk
	$(EMCC) $(GIT_CFLAGS) $(WEB_CFLAGS) -c $< -o $@

# One link writes both files. A pattern rule with two targets is a single
# recipe for both (in every GNU make), so a missing or stale .wasm relinks
# too. Each rule's pattern only matches its own pair ("frotz%js" matches
# dist/frotz.js with the stem "."), so the two interpreters cannot pick up
# each other's link rule.
$(DIST)/frotz%js $(DIST)/frotz%wasm: $(CORE_OBJ) $(WEB_OBJ) | $(OBJDIR)
	$(EMCC) $(LINK_frotz) $(CORE_OBJ) $(WEB_OBJ) -o $(DIST)/frotz.js
	$(call stamp_link,frotz)

$(DIST)/git%js $(DIST)/git%wasm: $(GIT_OBJ) $(GLK_ASYNC_OBJ) | $(OBJDIR)
	$(EMCC) $(LINK_git) $(GIT_OBJ) $(GLK_ASYNC_OBJ) -o $(DIST)/git.js
	$(call stamp_link,git)

$(BENCH)/git-async%js $(BENCH)/git-async%wasm: $(GIT_OBJ) $(GLK_ASYNC_OBJ) | $(BENCH)
	$(EMCC) $(LINK_git-async) $(GIT_OBJ) $(GLK_ASYNC_OBJ) -o $(BENCH)/git-async.js
	$(call stamp_link,git-async)

$(BENCH)/git-sync%js $(BENCH)/git-sync%wasm: $(GIT_OBJ) $(GLK_SYNC_OBJ) | $(BENCH)
	$(EMCC) $(LINK_git-sync) $(GIT_OBJ) $(GLK_SYNC_OBJ) -o $(BENCH)/git-sync.js
	$(call stamp_link,git-sync)

$(BENCH)/glk-check%js $(BENCH)/glk-check%wasm: $(CHECK_OBJ) | $(BENCH)
	$(EMCC) $(LINK_glk-check) $(CHECK_OBJ) -o $(BENCH)/glk-check.js
	$(call stamp_link,glk-check)

# Objects reached only through a pattern rule would count as intermediate
# and be deleted after the link; keep them so rebuilds are incremental.
.SECONDARY: $(CORE_OBJ) $(WEB_OBJ) $(GIT_OBJ) $(GLK_ASYNC_OBJ) $(GLK_SYNC_OBJ) $(CHECK_OBJ)

# The site is rebuilt from scratch every time: it is a copy, and a stale
# hashed file left behind would be harmless but confusing.
dist: all
	node deploy/build-site.js $(SITE)

serve: dist
	python3 deploy/serve.py $(SITE) 8000

serve-dev: all
	python3 -m http.server 8000

clean:
	rm -rf $(DIST) $(SITE)

.PHONY: all frotz git bench check dist serve serve-dev clean FORCE
