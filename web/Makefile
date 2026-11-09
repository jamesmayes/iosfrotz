# Build the Frotz Z-machine core (frotz/common) plus the browser OS layer
# (web/src/web_os.c) to WebAssembly with emscripten.
#
#   make            -> dist/frotz.js + dist/frotz.wasm
#   make serve      -> python3 -m http.server on :8000 from web/
#   make clean

EMCC    ?= emcc
ROOT    := ..
CORE    := $(ROOT)/frotz/common
OBJDIR  := dist/obj
DIST    := dist

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

LDFLAGS := -O2 \
           -sASYNCIFY \
           -sASYNCIFY_STACK_SIZE=65536 \
           -sALLOW_MEMORY_GROWTH \
           -sINVOKE_RUN=0 \
           -sEXIT_RUNTIME=1 \
           -sMODULARIZE -sEXPORT_NAME=createFrotz \
           -sEXPORTED_RUNTIME_METHODS=callMain,FS \
           -sENVIRONMENT=web

all: $(DIST)/frotz.js $(DIST)/frotz.wasm

$(OBJDIR) $(DIST):
	mkdir -p $@

$(OBJDIR)/%.o: $(CORE)/%.c $(HEADERS) | $(OBJDIR)
	$(EMCC) $(CFLAGS) $(CORE_CFLAGS) -c $< -o $@

$(OBJDIR)/web_os.o: src/web_os.c $(HEADERS) | $(OBJDIR)
	$(EMCC) $(CFLAGS) $(WEB_CFLAGS) -c $< -o $@

# One link writes both files. A pattern rule with two targets is a single
# recipe for both (in every GNU make), so a missing or stale frotz.wasm
# relinks too.
$(DIST)/%.js $(DIST)/%.wasm: $(CORE_OBJ) $(WEB_OBJ) | $(DIST)
	$(EMCC) $(LDFLAGS) $(CORE_OBJ) $(WEB_OBJ) -o $(DIST)/$*.js

# Objects reached only through a pattern rule would count as intermediate
# and be deleted after the link; keep them so rebuilds are incremental.
.SECONDARY: $(CORE_OBJ) $(WEB_OBJ)

serve: all
	python3 -m http.server 8000

clean:
	rm -rf $(DIST)

.PHONY: all serve clean
