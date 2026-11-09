# Build the interpreters to WebAssembly with emscripten:
#
#   - Frotz (Z-machine): the core in frotz/common plus the browser OS layer
#     web/src/web_os.c;
#   - Git (Glulx): git/ plus the browser Glk in web/glk/.
#
#   make            -> dist/frotz.js + dist/frotz.wasm, dist/git.js + dist/git.wasm
#   make frotz      -> dist/frotz.js + dist/frotz.wasm
#   make git        -> dist/git.js + dist/git.wasm
#   make tads2      -> dist/tads2.js + dist/tads2.wasm (TADS 2, tads/tads2 on
#                      the browser Glk, through tads/osglk.c and web/tads/)
#   make tads3      -> dist/tads3.js + dist/tads3.wasm (TADS 3, tads/tads3,
#                      C++, with -fwasm-exceptions)
#   make bench-tads -> dist/bench/tads{2,3}-{async,sync}.{js,wasm}, Node
#                      builds for bench/measure.js --tads
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
               glk/glk_web.h glk/glk_web_fileref.h glk/glkios_compat.h

# ---- TADS 2 ----
#
# The sources and defines of the Xcode target `tads` (Frotz.xcodeproj),
# less what is only for TADS 3: tads/tads2 for the VM, tads/*.c for the OS
# layer on Glk (osglk.c, osglkban.c, osbuffer.c, ...), and tads2/osportable.cc
# (C++), the portable half of the OS layer. Compiled unmodified; what they
# need from the iOS app comes from web/tads/ (README.md, "TADS"):
#   - web/tads/shim comes first on the include path, so osglk.c's
#     unconditional "iosfrotz.h", "glkios.h" and "git.h" are stand-ins;
#   - osansi1.c, which opens TADS's files, gets -include tads/tads_stdio.h,
#     so /saves files go through browser storage (tads_web.c);
#   - tads/tads2_web.c is the startup file (main_t2 of tads/t23run.cpp).
TADS      := $(ROOT)/tads
TADS_CFLAGS := -O2 -DGLKUNIX -DGLK_TIMERS -Itads/shim -Itads -Iglk -I$(GLKIOS) \
               -I$(TADS) -I$(TADS)/tads2 -I$(TADS)/tads3
TADS_CXXFLAGS := $(TADS_CFLAGS) -std=gnu++11
TADS2_SRC := argize bif bifgdum cmap cmd dat dbgtr emt errmsg execmd fio fioxor \
             getstr ler linfdum lst mch mcm mcs obj objcomp oem_glk oserr osifc \
             osrestad osstzprs ostzposix out output ply qas regex run runstat \
             suprun tcgdum trd voc vocab voccomp
TADS_OS_SRC := memicmp osansi1 osansi2 osansi3 osbuffer osglk osglkban osparse
TADS2_OBJ := $(addprefix $(OBJDIR)/tads2/,$(addsuffix .o,$(TADS2_SRC) osportable)) \
             $(addprefix $(OBJDIR)/tads/,$(addsuffix .o,$(TADS_OS_SRC) t2askf t2indlg)) \
             $(OBJDIR)/tads/tads_web.o $(OBJDIR)/tads/tads2_web.o
TADS_HEADERS := $(wildcard $(TADS)/*.h $(TADS)/tads2/*.h) $(wildcard tads/shim/*.h) \
                tads/tads_web.h tads/tads_stdio.h $(GLKIOS)/glk.h $(GLKIOS)/gi_dispa.h \
                glk/glk_web.h glk/glk_web_fileref.h
# The browser Glk without git's startup file.
TADS_GLK_ASYNC := $(GIDISP_OBJ) $(OBJDIR)/glk/glk_unicode.o $(OBJDIR)/glk/glk_date.o \
                  $(OBJDIR)/glk/glk_web.o
TADS_GLK_SYNC  := $(GIDISP_OBJ) $(OBJDIR)/glk/glk_unicode.o $(OBJDIR)/glk/glk_date.o \
                  $(OBJDIR)/glk/glk_web_sync.o
EMXX ?= em++

# ---- TADS 3 ----
#
# The Xcode target's TADS 3 sources (tads/tads3, C++) and C++ defines
# (-DVMGLOB_STRUCT -DOS_DECLARATIVE_TLS -DTC_TARGET_T3 -DTADSNET), the same
# Glk OS layer objects as TADS 2, the four OS files from tads/tads2 that
# TADS 3 needs too (osifc, osrestad, osstzprs, ostzposix), and the startup
# file tads/tads3_web.cpp (main_t3 of tads/t23run.cpp). Two things differ
# from Apple's headers, and are fixed on the command line, not in the
# sources: -include sys/stat.h (rcmain, vmfilnam, vmnetfil, vmnetfillcl
# use S_IFDIR and friends, which Apple's headers bring in indirectly), and
# -D__GNU_LIBRARY__ for sha2.cpp only (its byte-order probe otherwise does
# `#include _ENDIAN_H`, which musl defines as an empty include guard; with
# it, sha2.cpp takes its glibc branch: <endian.h> and <byteswap.h>).
#
# TADS 3 raises its errors with setjmp/longjmp (err_try, tads3/vmerr.h); it
# throws no C++ exceptions. -fwasm-exceptions makes both wasm exception
# handling (Safari 15.2+), and every TADS 3 object is built with it. The
# Glk and plain C objects have no setjmp and are shared with TADS 2.
TADS3_SRC := charmap md5 osifcnet rcmain resload resnoexe sha2 std_dbg std \
             tccmdutl tcerr tcerrmsg tcgen tcglob tchostsi tclibprs tcmain \
             tcprs_rt tcprs tcprsnf tcprsnl tcprsstm tcsrc tct3_d tct3 tct3nl \
             tct3stm tct3unas tctok utf8 vmanonfn vmbif vmbifl vmbifnet \
             vmbifreg vmbift3 vmbiftad vmbiftio vmbignum vmbignumlib vmbt3_nd \
             vmbytarr vmcfgmem vmcoll vmconhmp vmconnom vmconsol vmcrc vmcset \
             vmdate vmdict vmdynfunc vmerr vmerrmsg vmfile vmfilnam vmfilobj \
             vmfref vmfunc vmglob vmgram vmhash vmhostsi vmhosttx vmhttpreq \
             vmhttpsrv vmimage vmimg_nd vmimgrb vmini_nd vminit vminitim \
             vmintcls vmisaac vmiter vmlog vmlookup vmlst vmmain vmmcreg vmmeta \
             vmnet vmnetcfg vmnetfil vmnetfillcl vmnetui vmobj vmop vmpack vmpat \
             vmpool vmpoolim vmpreini vmrefcnt vmregex vmrun vmrunsym vmsa \
             vmsave vmsort vmsortv vmsrcf vmstack vmstr vmstrbuf vmstrcmp \
             vmtmpfil vmtobj vmtype vmtypedh vmtz vmtzobj vmundo vmvec vmwrtimg
TADS3_EH := -fwasm-exceptions
TADS3_CXXFLAGS := $(TADS_CFLAGS) -I$(TADS)/tads3/unix -std=gnu++11 \
                  -DVMGLOB_STRUCT -DOS_DECLARATIVE_TLS -DTC_TARGET_T3 -DTADSNET \
                  $(TADS3_EH) -include sys/stat.h
TADS3_OBJ := $(addprefix $(OBJDIR)/tads3/,$(addsuffix .o,$(TADS3_SRC) osnetunix \
                  vmuni_cs t3askf t3indlg osportable tads3_web)) \
             $(addprefix $(OBJDIR)/tads/,$(addsuffix .o,$(TADS_OS_SRC) tads_web)) \
             $(addprefix $(OBJDIR)/tads2/,$(addsuffix .o,osifc osrestad osstzprs ostzposix))
TADS3_HEADERS := $(TADS_HEADERS) $(wildcard $(TADS)/tads3/*.h $(TADS)/tads3/unix/*.h)

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

# TADS 2: the same flags again. TADS uses setjmp/longjmp for its errors,
# which emscripten implements by default with JS invoke_ wrappers
# (-sSUPPORT_LONGJMP=emscripten); ASYNCIFY unwinds through them.
TADS2_LDFLAGS := $(LDFLAGS_COMMON) \
           -sASYNCIFY \
           -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK) \
           -sEXPORT_NAME=createTads2 \
           -sENVIRONMENT=web

# TADS 3: the same again, linked with wasm exceptions.
TADS3_LDFLAGS := $(LDFLAGS_COMMON) $(TADS3_EH) \
           -sASYNCIFY \
           -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK) \
           -sEXPORT_NAME=createTads3 \
           -sENVIRONMENT=web

# Node builds for the measurement: the same code, with and without ASYNCIFY.
BENCH_LDFLAGS := $(LDFLAGS_COMMON) -sEXPORT_NAME=createGit -sENVIRONMENT=node

all: frotz git

frotz: $(DIST)/frotz.js $(DIST)/frotz.wasm
git: $(DIST)/git.js $(DIST)/git.wasm
tads2: $(DIST)/tads2.js $(DIST)/tads2.wasm
tads3: $(DIST)/tads3.js $(DIST)/tads3.wasm
# Each link writes a .js and a .wasm; both are named, so a missing .wasm is
# rebuilt even when its .js is present.
bench: $(BENCH)/git-async.js $(BENCH)/git-async.wasm $(BENCH)/git-sync.js $(BENCH)/git-sync.wasm
bench-tads: $(BENCH)/tads2-async.js $(BENCH)/tads2-async.wasm \
            $(BENCH)/tads2-sync.js $(BENCH)/tads2-sync.wasm \
            $(BENCH)/tads3-async.js $(BENCH)/tads3-async.wasm \
            $(BENCH)/tads3-sync.js $(BENCH)/tads3-sync.wasm

check: $(BENCH)/glk-check.js $(BENCH)/glk-check.wasm $(BENCH)/git-sync.js $(BENCH)/git-sync.wasm
	node bench/check-glk.js
	node bench/check-malformed.js
	node bench/check-page.js

# dist/ itself is created with dist/obj (the links order on $(OBJDIR)), so
# that `dist` can be the phony target that builds the site.
$(OBJDIR) $(OBJDIR)/git $(OBJDIR)/glk $(OBJDIR)/tads $(OBJDIR)/tads2 $(OBJDIR)/tads3 $(BENCH):
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
LINK_tads2     := $(TADS2_LDFLAGS)
LINK_tads2-async := $(LDFLAGS_COMMON) -sEXPORT_NAME=createTads2 -sENVIRONMENT=node \
                    -sASYNCIFY -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK)
LINK_tads2-sync  := $(LDFLAGS_COMMON) -sEXPORT_NAME=createTads2 -sENVIRONMENT=node
LINK_tads3     := $(TADS3_LDFLAGS)
LINK_tads3-async := $(LDFLAGS_COMMON) $(TADS3_EH) -sEXPORT_NAME=createTads3 -sENVIRONMENT=node \
                    -sASYNCIFY -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK)
LINK_tads3-sync  := $(LDFLAGS_COMMON) $(TADS3_EH) -sEXPORT_NAME=createTads3 -sENVIRONMENT=node
LINK_OUTPUTS   := frotz git git-async git-sync glk-check tads2 tads2-async tads2-sync \
                  tads3 tads3-async tads3-sync
OUT_frotz      := $(DIST)/frotz
OUT_git        := $(DIST)/git
OUT_git-async  := $(BENCH)/git-async
OUT_git-sync   := $(BENCH)/git-sync
OUT_glk-check  := $(BENCH)/glk-check
OUT_tads2      := $(DIST)/tads2
OUT_tads2-async := $(BENCH)/tads2-async
OUT_tads2-sync  := $(BENCH)/tads2-sync
OUT_tads3      := $(DIST)/tads3
OUT_tads3-async := $(BENCH)/tads3-async
OUT_tads3-sync  := $(BENCH)/tads3-sync

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

$(OBJDIR)/tads2/%.o: $(TADS)/tads2/%.c $(TADS_HEADERS) | $(OBJDIR)/tads2
	$(EMCC) $(TADS_CFLAGS) -c $< -o $@

$(OBJDIR)/tads2/osportable.o: $(TADS)/tads2/osportable.cc $(TADS_HEADERS) | $(OBJDIR)/tads2
	$(EMXX) $(TADS_CXXFLAGS) -c $< -o $@

$(OBJDIR)/tads/osansi1.o: $(TADS)/osansi1.c $(TADS_HEADERS) | $(OBJDIR)/tads
	$(EMCC) $(TADS_CFLAGS) -include tads/tads_stdio.h -c $< -o $@

$(OBJDIR)/tads/%.o: $(TADS)/%.c $(TADS_HEADERS) | $(OBJDIR)/tads
	$(EMCC) $(TADS_CFLAGS) -c $< -o $@

$(OBJDIR)/tads/tads_web.o: tads/tads_web.c $(TADS_HEADERS) | $(OBJDIR)/tads
	$(EMCC) $(TADS_CFLAGS) $(WEB_CFLAGS) -c $< -o $@

$(OBJDIR)/tads/tads2_web.o: tads/tads2_web.c $(TADS_HEADERS) | $(OBJDIR)/tads
	$(EMCC) $(TADS_CFLAGS) $(WEB_CFLAGS) -c $< -o $@

$(OBJDIR)/tads3/%.o: $(TADS)/tads3/%.cpp $(TADS3_HEADERS) | $(OBJDIR)/tads3
	$(EMXX) $(TADS3_CXXFLAGS) -c $< -o $@

$(OBJDIR)/tads3/sha2.o: $(TADS)/tads3/sha2.cpp $(TADS3_HEADERS) | $(OBJDIR)/tads3
	$(EMXX) $(TADS3_CXXFLAGS) -D__GNU_LIBRARY__ -c $< -o $@

$(OBJDIR)/tads3/osnetunix.o: $(TADS)/tads3/unix/osnetunix.cpp $(TADS3_HEADERS) | $(OBJDIR)/tads3
	$(EMXX) $(TADS3_CXXFLAGS) -c $< -o $@

$(OBJDIR)/tads3/%.o: $(TADS)/%.cpp $(TADS3_HEADERS) | $(OBJDIR)/tads3
	$(EMXX) $(TADS3_CXXFLAGS) -c $< -o $@

$(OBJDIR)/tads3/osportable.o: $(TADS)/tads2/osportable.cc $(TADS3_HEADERS) | $(OBJDIR)/tads3
	$(EMXX) $(TADS3_CXXFLAGS) -c $< -o $@

# -Wno-unused-parameter: the TADS 3 headers this includes (t3std.h,
# vmconsol.h, vmmaincn.h) have unused parameters in inline methods.
$(OBJDIR)/tads3/tads3_web.o: tads/tads3_web.cpp $(TADS3_HEADERS) | $(OBJDIR)/tads3
	$(EMXX) $(TADS3_CXXFLAGS) $(WEB_CFLAGS) -Wno-unused-parameter -c $< -o $@

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

$(DIST)/tads2%js $(DIST)/tads2%wasm: $(TADS2_OBJ) $(TADS_GLK_ASYNC) | $(OBJDIR)
	$(EMXX) $(LINK_tads2) $(TADS2_OBJ) $(TADS_GLK_ASYNC) -o $(DIST)/tads2.js
	$(call stamp_link,tads2)

$(BENCH)/tads2-async%js $(BENCH)/tads2-async%wasm: $(TADS2_OBJ) $(TADS_GLK_ASYNC) | $(BENCH)
	$(EMXX) $(LINK_tads2-async) $(TADS2_OBJ) $(TADS_GLK_ASYNC) -o $(BENCH)/tads2-async.js
	$(call stamp_link,tads2-async)

$(BENCH)/tads2-sync%js $(BENCH)/tads2-sync%wasm: $(TADS2_OBJ) $(TADS_GLK_SYNC) | $(BENCH)
	$(EMXX) $(LINK_tads2-sync) $(TADS2_OBJ) $(TADS_GLK_SYNC) -o $(BENCH)/tads2-sync.js
	$(call stamp_link,tads2-sync)

$(DIST)/tads3%js $(DIST)/tads3%wasm: $(TADS3_OBJ) $(TADS_GLK_ASYNC) | $(OBJDIR)
	$(EMXX) $(LINK_tads3) $(TADS3_OBJ) $(TADS_GLK_ASYNC) -o $(DIST)/tads3.js
	$(call stamp_link,tads3)

$(BENCH)/tads3-async%js $(BENCH)/tads3-async%wasm: $(TADS3_OBJ) $(TADS_GLK_ASYNC) | $(BENCH)
	$(EMXX) $(LINK_tads3-async) $(TADS3_OBJ) $(TADS_GLK_ASYNC) -o $(BENCH)/tads3-async.js
	$(call stamp_link,tads3-async)

$(BENCH)/tads3-sync%js $(BENCH)/tads3-sync%wasm: $(TADS3_OBJ) $(TADS_GLK_SYNC) | $(BENCH)
	$(EMXX) $(LINK_tads3-sync) $(TADS3_OBJ) $(TADS_GLK_SYNC) -o $(BENCH)/tads3-sync.js
	$(call stamp_link,tads3-sync)

# Objects reached only through a pattern rule would count as intermediate
# and be deleted after the link; keep them so rebuilds are incremental.
.SECONDARY: $(CORE_OBJ) $(WEB_OBJ) $(GIT_OBJ) $(GLK_ASYNC_OBJ) $(GLK_SYNC_OBJ) $(CHECK_OBJ) \
            $(TADS2_OBJ) $(TADS3_OBJ)

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

.PHONY: all frotz git tads2 tads3 bench bench-tads check dist serve serve-dev clean FORCE
