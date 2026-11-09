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
CFLAGS  := -O2 -DFROTZ_IOS=1 -Ishim -I$(CORE) \
           -Wno-implicit-function-declaration -Wno-int-conversion \
           -Wno-incompatible-pointer-types -Wno-deprecated-non-prototype

LDFLAGS := -O2 \
           -sASYNCIFY \
           -sASYNCIFY_STACK_SIZE=65536 \
           -sALLOW_MEMORY_GROWTH \
           -sINVOKE_RUN=0 \
           -sEXIT_RUNTIME=1 \
           -sMODULARIZE -sEXPORT_NAME=createFrotz \
           -sEXPORTED_RUNTIME_METHODS=callMain,FS \
           -sENVIRONMENT=web

all: $(DIST)/frotz.js

$(OBJDIR) $(DIST):
	mkdir -p $@

$(OBJDIR)/%.o: $(CORE)/%.c | $(OBJDIR)
	$(EMCC) $(CFLAGS) -c $< -o $@

$(OBJDIR)/web_os.o: src/web_os.c shim/iosfrotz.h | $(OBJDIR)
	$(EMCC) $(CFLAGS) -c $< -o $@

$(DIST)/frotz.js: $(CORE_OBJ) $(WEB_OBJ) | $(DIST)
	$(EMCC) $(LDFLAGS) $^ -o $@

serve: all
	python3 -m http.server 8000

clean:
	rm -rf $(DIST)

.PHONY: all serve clean
