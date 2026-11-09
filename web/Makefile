# Build the interpreters to WebAssembly with emscripten:
#
#   - Frotz (Z-machine): the core in frotz/common plus the browser OS layer
#     web/src/web_os.c;
#   - Git (Glulx): git/ plus the browser Glk in web/glk/.
#
#   make            -> dist/frotz.js + dist/frotz.wasm, dist/git.js + dist/git.wasm,
#                      dist/tads2.js + dist/tads2.wasm, dist/tads3.js + dist/tads3.wasm
#   make frotz      -> dist/frotz.js + dist/frotz.wasm
#   make git        -> dist/git.js + dist/git.wasm
#   make tads2      -> dist/tads2.js + dist/tads2.wasm (TADS 2, tads/tads2 on
#                      the browser Glk, through tads/osglk.c and web/tads/)
#   make tads3      -> dist/tads3.js + dist/tads3.wasm (TADS 3, tads/tads3,
#                      C++, longjmp through emscripten's JS wrappers; TADS 2
#                      uses wasm setjmp instead)
#   make bench-tads -> dist/bench/tads{2,3}-{async,sync}.{js,wasm}, Node
#                      builds for bench/measure.js --tads
#   make asyncify-lists -> regenerates tads/asyncify-tads{2,3}.txt, the
#                      functions ASYNCIFY instruments in TADS (see "ASYNCIFY
#                      for TADS" below); run it after changing tads/ or the
#                      TADS flags, and commit the lists
#   make asyncify-check -> dist/bench/tads{2,3}-check.{js,wasm} (the
#                      ASYNCIFY_ONLY builds with ASYNCIFY assertions), played
#                      on every TADS walkthrough against the plain builds
#   make bench      -> dist/bench/git-async.{js,wasm} and git-sync.{js,wasm},
#                      Node builds of git for bench/run-bench.js
#   make check      -> builds dist/bench/glk-check.{js,wasm} (bench/glk-check.c
#                      on the browser Glk), git-sync, tads2-sync,
#                      tads3-sync and tads3-async (for check-page.js's QUIT
#                      through the page), then runs bench/check-glk.js,
#                      bench/check-malformed.js, bench/check-page.js (glk.js
#                      and saves.js on fakes) and bench/check-tads.js
#   make dist       -> dist-site/: the static site to deploy (deploy/build-site.js;
#                      hashed asset names, see deploy/README.md)
#   make serve      -> make dist, then serve dist-site/ on 127.0.0.1:8000 with
#                      the headers deploy/README.md asks for (deploy/serve.py)
#   make serve-dev  -> python3 -m http.server on :8000 from web/ (unhashed)
#   make clean      -> removes dist/ and dist-site/
#
# Flag changes. Every link records the flags it was made with
# (dist/obj/<output>.ldflags) and relinks when they change. Every object is
# in one compile-flag group (by the flag variables it is built with and the
# outputs that link it, listed under "Compile flags of the objects" below)
# with its own stamp, dist/obj/<group>.ccflags, so changing a flag
# rebuilds exactly the objects built with it, whichever output is built
# first.

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
# bridge uses, so they are named here. TADS's text adapter
# (tads/tads_text.c) is linked too: its handling of Glk streams (a
# character held back for a window that is then closed) is checked there,
# where no TADS game is needed to reach it.
CHECK_OBJ := $(GIDISP_OBJ) $(OBJDIR)/glk/glk_unicode.o $(OBJDIR)/glk/glk_date.o \
             $(OBJDIR)/glk/glk_web_sync.o $(OBJDIR)/glk/glk-check.o \
             $(OBJDIR)/tads/tads_text.o
CHECK_LIBS := -sEXPORTED_RUNTIME_METHODS=callMain,FS,stringToUTF8,UTF8ToString

GIT_CFLAGS := -O2 -DUSE_INLINE -Iglk/shim -Iglk -I$(GLKIOS) -I$(GIT)
GIT_HEADERS := $(wildcard $(GIT)/*.h) $(GIT)/labels.inc $(GLKIOS)/glk.h \
               $(GLKIOS)/gi_dispa.h $(GLKIOS)/gi_blorb.h glk/shim/iosfrotz.h \
               glk/glk_web.h glk/glk_web_fileref.h glk/glkios_compat.h

# ---- TADS 2 ----
#
# The sources and defines of the Xcode target `tads` (Frotz.xcodeproj),
# less what is only for TADS 3: tads/tads2 for the VM, tads/*.c for the OS
# layer on Glk (osglk.c, osglkban.c, ...), and tads2/osportable.cc
# (C++), the portable half of the OS layer. Compiled unmodified; what they
# need from the iOS app comes from web/tads/ (README.md, "TADS"):
#   - web/tads/shim comes first on the include path, so osglk.c's
#     unconditional "iosfrotz.h", "glkios.h" and "git.h" are stand-ins;
#   - osansi1.c, which opens TADS's files, gets -include tads/tads_stdio.h,
#     so /saves files go through browser storage (tads_web.c);
#   - tads/osbuffer.c is replaced by tads/tads_text.c, which converts the
#     game's text (UTF-8 for TADS 3) to and from Glk's characters; osbuffer.c
#     hands the browser Glk bytes, which it takes as Latin-1 (README.md,
#     "Text encoding");
#   - tads/tads2_web.c is the startup file (main_t2 of tads/t23run.cpp).
#
# TADS 2 raises its errors with setjmp/longjmp (ERRBEGIN, tads2/ler.h). It
# is built with -sSUPPORT_LONGJMP=wasm: setjmp/longjmp are wasm exception
# handling (Safari 15.2+), not emscripten's default JS invoke_ wrappers.
# Under ASYNCIFY every call through an invoke_ wrapper also goes through
# a JS wrapper of the dynCall_ export it calls, and runexe, TADS 2's
# bytecode loop, makes nearly all its calls inside ERRBEGIN: ~81 million of
# them in the CPU-bound walkthrough, 1.37x the plain build's time (README.md,
# "Measurement"). Only the TADS 2 objects that are not shared with TADS 3
# get the flag (TADS2_SJLJ_OBJ); the shared ones have no setjmp. TADS 2 is C
# and has no C++ catch, so emcc does not warn, unlike -fwasm-exceptions.
TADS      := $(ROOT)/tads
TADS_CFLAGS := -O2 -DGLKUNIX -DGLK_TIMERS -Itads/shim -Itads -Iglk -I$(GLKIOS) \
               -I$(TADS) -I$(TADS)/tads2 -I$(TADS)/tads3
TADS_CXXFLAGS := $(TADS_CFLAGS) -std=gnu++11
TADS2_SRC := argize bif bifgdum cmap cmd dat dbgtr emt errmsg execmd fio fioxor \
             getstr ler linfdum lst mch mcm mcs obj objcomp oem_glk oserr osifc \
             osrestad osstzprs ostzposix out output ply qas regex run runstat \
             suprun tcgdum trd voc vocab voccomp
TADS_OS_SRC := memicmp osansi1 osansi2 osansi3 osglk osglkban osparse
TADS2_SJLJ := -sSUPPORT_LONGJMP=wasm
# The four tads/tads2 OS files TADS 3 links too (see "TADS 3").
TADS2_SHARED := osifc osrestad osstzprs ostzposix
TADS2_SJLJ_OBJ := $(addprefix $(OBJDIR)/tads2/,$(addsuffix .o,$(filter-out $(TADS2_SHARED),$(TADS2_SRC)) osportable))
TADS2_OBJ := $(addprefix $(OBJDIR)/tads2/,$(addsuffix .o,$(TADS2_SRC) osportable)) \
             $(addprefix $(OBJDIR)/tads/,$(addsuffix .o,$(TADS_OS_SRC) t2askf t2indlg)) \
             $(OBJDIR)/tads/tads_web.o $(OBJDIR)/tads/tads_text.o $(OBJDIR)/tads/tads2_web.o
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
# throws no C++ exceptions. TADS3_EH is empty, so longjmp is emscripten's
# default JS invoke_ wrappers (TADS 2 differs: wasm setjmp, TADS2_SJLJ, for
# the reason given under "TADS 2"). -fwasm-exceptions also works
# (README.md, "How TADS 3 is built") but is 4% larger, no faster, and emcc
# warns that it does not mix with ASYNCIFY (an await inside a C++ catch
# traps). Every TADS 3 object is compiled with TADS3_CXXFLAGS; when they
# change (TADS3_EH=-fwasm-exceptions, an edit here), the tads3 and tads3web
# stamps below rebuild them all. The Glk and plain C objects have no setjmp
# and are shared with TADS 2.
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
TADS3_EH :=
TADS3_CXXFLAGS := $(TADS_CFLAGS) -I$(TADS)/tads3/unix -std=gnu++11 \
                  -DVMGLOB_STRUCT -DOS_DECLARATIVE_TLS -DTC_TARGET_T3 -DTADSNET \
                  $(TADS3_EH) -include sys/stat.h
TADS3_OBJ := $(addprefix $(OBJDIR)/tads3/,$(addsuffix .o,$(TADS3_SRC) osnetunix \
                  vmuni_cs t3askf t3indlg osportable tads3_web)) \
             $(addprefix $(OBJDIR)/tads/,$(addsuffix .o,$(TADS_OS_SRC) tads_web tads_text)) \
             $(addprefix $(OBJDIR)/tads2/,$(addsuffix .o,osifc osrestad osstzprs ostzposix))
TADS3_HEADERS := $(TADS_HEADERS) $(wildcard $(TADS)/tads3/*.h $(TADS)/tads3/unix/*.h)

# ---- ASYNCIFY for TADS ----
#
# Instrumenting every function that might be on the stack when the C code
# awaits the page cost TADS 1.35-1.42x on CPU-bound turns: the wait is
# reached through indirect calls (the builtin tables, metaclass methods), so
# emcc must assume nearly every function can be. The TADS links instead pass
# -sASYNCIFY_ONLY with a list of the functions that can be on that stack
# (README.md, "ASYNCIFY for TADS"); calls to functions not in it, and their
# code, are left alone. The lists are generated, not written by hand
# (make asyncify-lists, below), from
#   - the wasm frames seen on the stack whenever the C code awaits, playing
#     every TADS walkthrough, including the stress games bench/tads/stress2,
#     stress3 and fin3 (finalizers that wait; a build with --profiling-funcs,
#     bench/run-bench.js --frames);
#   - seeds written by hand, tads/asyncify-seeds-tads{2,3}.txt: the
#     dispatchers (builtin tables, metaclass methods, comparators, the
#     garbage collector's call of a finalizer) through
#     which code the walkthroughs do not run could reach the wait;
#   - every direct caller of those, and their callers, which emcc's
#     ASYNCIFY_ADVISE finds (with ASYNCIFY_IGNORE_INDIRECT, so that indirect
#     calls do not pull in the whole VM again).
# A function wrongly left out of a list breaks an unwind through it, so
# make asyncify-check plays every walkthrough on builds with ASYNCIFY
# assertions, which stop at such a frame. Regenerate the lists after any
# change to tads/, web/tads/, web/glk/ or the TADS flags: the names are the
# functions as they are after inlining, so a list from other code or flags
# is wrong.
TADS2_ASYNC_LIST := tads/asyncify-tads2.txt
TADS3_ASYNC_LIST := tads/asyncify-tads3.txt
TADS2_ASYNC_ONLY := -sASYNCIFY_ONLY=@$(TADS2_ASYNC_LIST)
TADS3_ASYNC_ONLY := -sASYNCIFY_ONLY=@$(TADS3_ASYNC_LIST)

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

# TADS 2: the same flags again, with wasm setjmp/longjmp (TADS2_SJLJ, see
# "TADS 2") and only the functions in its list instrumented.
TADS2_LDFLAGS := $(LDFLAGS_COMMON) $(TADS2_SJLJ) \
           -sASYNCIFY $(TADS2_ASYNC_ONLY) \
           -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK) \
           -sEXPORT_NAME=createTads2 \
           -sENVIRONMENT=web

# TADS 3: the same again (TADS3_EH is empty: JS longjmp, as above), with
# only the functions in its list instrumented.
TADS3_LDFLAGS := $(LDFLAGS_COMMON) $(TADS3_EH) \
           -sASYNCIFY $(TADS3_ASYNC_ONLY) \
           -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK) \
           -sEXPORT_NAME=createTads3 \
           -sENVIRONMENT=web

# Node builds for the measurement: the same code, with and without ASYNCIFY.
BENCH_LDFLAGS := $(LDFLAGS_COMMON) -sEXPORT_NAME=createGit -sENVIRONMENT=node

all: frotz git tads2 tads3

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

check: $(BENCH)/glk-check.js $(BENCH)/glk-check.wasm $(BENCH)/git-sync.js $(BENCH)/git-sync.wasm \
       $(BENCH)/tads2-sync.js $(BENCH)/tads2-sync.wasm $(BENCH)/tads3-sync.js $(BENCH)/tads3-sync.wasm \
       $(BENCH)/tads3-async.js $(BENCH)/tads3-async.wasm
	node bench/check-glk.js
	node bench/check-malformed.js
	node bench/check-page.js
	node bench/check-tads.js

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
# tadsN-full: every function instrumented, as before the lists, for
# --profiling-funcs builds (frames) and ASYNCIFY_ADVISE (callers); see
# asyncify-lists. tadsN-check: the -async build with ASYNCIFY assertions.
TADS2_NODE := $(LDFLAGS_COMMON) $(TADS2_SJLJ) -sEXPORT_NAME=createTads2 -sENVIRONMENT=node
TADS2_FULL := $(TADS2_NODE) -sASYNCIFY -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK)
LINK_tads2-async := $(TADS2_FULL) $(TADS2_ASYNC_ONLY)
LINK_tads2-sync  := $(TADS2_NODE)
LINK_tads2-check := $(LINK_tads2-async) -sASSERTIONS=2
LINK_tads3     := $(TADS3_LDFLAGS)
TADS3_NODE := $(LDFLAGS_COMMON) $(TADS3_EH) -sEXPORT_NAME=createTads3 -sENVIRONMENT=node
TADS3_FULL := $(TADS3_NODE) -sASYNCIFY -sASYNCIFY_STACK_SIZE=$(GIT_ASYNC_STACK)
LINK_tads3-async := $(TADS3_FULL) $(TADS3_ASYNC_ONLY)
LINK_tads3-sync  := $(TADS3_NODE)
LINK_tads3-check := $(LINK_tads3-async) -sASSERTIONS=2
LINK_OUTPUTS   := frotz git git-async git-sync glk-check tads2 tads2-async tads2-sync \
                  tads2-check tads3 tads3-async tads3-sync tads3-check
OUT_frotz      := $(DIST)/frotz
OUT_git        := $(DIST)/git
OUT_git-async  := $(BENCH)/git-async
OUT_git-sync   := $(BENCH)/git-sync
OUT_glk-check  := $(BENCH)/glk-check
OUT_tads2      := $(DIST)/tads2
OUT_tads2-async := $(BENCH)/tads2-async
OUT_tads2-sync  := $(BENCH)/tads2-sync
OUT_tads2-check := $(BENCH)/tads2-check
OUT_tads3      := $(DIST)/tads3
OUT_tads3-async := $(BENCH)/tads3-async
OUT_tads3-sync  := $(BENCH)/tads3-sync
OUT_tads3-check := $(BENCH)/tads3-check

stale_link = $(shell printf '%s\n' '$(LINK_$(1))' | cmp -s - $(OBJDIR)/$(1).ldflags 2>/dev/null || echo stale)
$(foreach n,$(LINK_OUTPUTS),$(if $(call stale_link,$(n)),$(eval $(OUT_$(n)).js $(OUT_$(n)).wasm: FORCE)))
# Recipe line: record the flags an output was just linked with, and the
# compile flags of every group it links (below).
stamp_link = printf '%s\n' '$(LINK_$(1))' > $(OBJDIR)/$(1).ldflags && \
	$(call stamp_cc_groups,$(CCG_$(1)))
# Compile flags of the objects, the same way. Every object is in exactly
# one group below; a group's objects are compiled with the same flag
# variables (CC_<group>) and linked by the same outputs.
# dist/obj/<group>.ccflags holds the flags the group was last built with,
# and every link writes the stamp of each group it links (CCG_<output>, in
# stamp_link), after all its objects were compiled. If a group's flags
# differ from its stamp, that group, and only that group, is rebuilt. So
# objects built for two longjmp modes are never linked together, and a
# change to CFLAGS, CORE_CFLAGS, GIT_CFLAGS, WEB_CFLAGS, TADS_CFLAGS,
# TADS_CXXFLAGS, TADS2_SJLJ, TADS3_EH or TADS3_CXXFLAGS rebuilds every
# object built with it and nothing else, whichever output is built first:
#   frotz     frotz/common                            CFLAGS CORE_CFLAGS
#   frotzweb  src/web_os.c                            CFLAGS WEB_CFLAGS
#   git       git/                                    GIT_CFLAGS
#   gitweb    glk/git_web.c: the git outputs          GIT_CFLAGS WEB_CFLAGS
#   glk       gi_dispa, gi_blorb, glk_unicode,
#             glk_date: everything but Frotz          GIT_CFLAGS
#   glkweb    glk/glk_web.c for git and the
#             ASYNCIFY TADS outputs                   GIT_CFLAGS WEB_CFLAGS
#   glksync   glk/glk_web.c with -DGLK_WEB_SYNC for
#             git-sync, tadsN-sync, glk-check          GIT_CFLAGS WEB_CFLAGS
#   glkcheck  bench/glk-check.c                       GIT_CFLAGS WEB_CFLAGS
#   tads2     tads/tads2 objects only TADS 2 links    TADS_CFLAGS TADS2_SJLJ
#   tads2cxx  tads2/osportable.cc for TADS 2          TADS_CXXFLAGS TADS2_SJLJ
#   tads2os   t2askf.c, t2indlg.c                     TADS_CFLAGS
#   tads2web  web/tads/tads2_web.c                    TADS_CFLAGS WEB_CFLAGS
#   tads3     tads/tads3 (and the TADS 3 builds of
#             osportable, vmuni_cs, t3askf, t3indlg)   TADS3_CXXFLAGS
#   tads3web  web/tads/tads3_web.cpp                  TADS3_CXXFLAGS WEB_CFLAGS
#   tadsos    the Glk OS layer (tads/*.c) and the
#             four shared tads/tads2 files: both link  TADS_CFLAGS
#   tadsweb   web/tads/tads_web.c: both               TADS_CFLAGS WEB_CFLAGS
#   tadstext  web/tads/tads_text.c: both, glk-check   TADS_CFLAGS WEB_CFLAGS
# A group is stamped only by the outputs that link all of its objects, and
# by all of them: otherwise, after a flag change, a TADS 3 link would stamp,
# unbuilt, objects that only TADS 2 links, or an output that compiled an
# object without stamping it would leave it built with flags its stamp does
# not name, and other outputs would link it so. Flags written
# into a single rule (osansi1's -include, sha2's -D__GNU_LIBRARY__,
# tads3_web's -Wno-unused-parameter, glk_web_sync's -DGLK_WEB_SYNC) are not
# stamped: like any other edit to a recipe, changing them needs a clean
# build.
CC_frotz    := $(CFLAGS) $(CORE_CFLAGS)
CC_frotzweb := $(CFLAGS) $(WEB_CFLAGS)
CC_git      := $(GIT_CFLAGS)
CC_gitweb   := $(GIT_CFLAGS) $(WEB_CFLAGS)
CC_glk      := $(GIT_CFLAGS)
CC_glkweb   := $(GIT_CFLAGS) $(WEB_CFLAGS)
CC_glksync  := $(GIT_CFLAGS) $(WEB_CFLAGS)
CC_glkcheck := $(GIT_CFLAGS) $(WEB_CFLAGS)
CC_tads2    := $(TADS_CFLAGS) $(TADS2_SJLJ)
CC_tads2cxx := $(TADS_CXXFLAGS) $(TADS2_SJLJ)
CC_tads2os  := $(TADS_CFLAGS)
CC_tads2web := $(TADS_CFLAGS) $(WEB_CFLAGS)
CC_tads3    := $(TADS3_CXXFLAGS)
CC_tads3web := $(TADS3_CXXFLAGS) $(WEB_CFLAGS)
CC_tadsos   := $(TADS_CFLAGS)
CC_tadsweb  := $(TADS_CFLAGS) $(WEB_CFLAGS)
CC_tadstext := $(TADS_CFLAGS) $(WEB_CFLAGS)
CCOBJ_frotz    := $(CORE_OBJ)
CCOBJ_frotzweb := $(WEB_OBJ)
CCOBJ_git      := $(GIT_OBJ)
CCOBJ_gitweb   := $(OBJDIR)/glk/git_web.o
CCOBJ_glk      := $(GIDISP_OBJ) $(OBJDIR)/glk/glk_unicode.o $(OBJDIR)/glk/glk_date.o
CCOBJ_glkweb   := $(OBJDIR)/glk/glk_web.o
CCOBJ_glksync  := $(OBJDIR)/glk/glk_web_sync.o
CCOBJ_glkcheck := $(OBJDIR)/glk/glk-check.o
CCOBJ_tads2    := $(filter-out $(OBJDIR)/tads2/osportable.o,$(TADS2_SJLJ_OBJ))
CCOBJ_tads2cxx := $(OBJDIR)/tads2/osportable.o
CCOBJ_tads2os  := $(OBJDIR)/tads/t2askf.o $(OBJDIR)/tads/t2indlg.o
CCOBJ_tads2web := $(OBJDIR)/tads/tads2_web.o
CCOBJ_tads3    := $(filter-out $(OBJDIR)/tads3/tads3_web.o,$(filter $(OBJDIR)/tads3/%,$(TADS3_OBJ)))
CCOBJ_tads3web := $(OBJDIR)/tads3/tads3_web.o
CCOBJ_tadsos   := $(addprefix $(OBJDIR)/tads/,$(addsuffix .o,$(TADS_OS_SRC))) \
                  $(addprefix $(OBJDIR)/tads2/,$(addsuffix .o,$(TADS2_SHARED)))
CCOBJ_tadsweb  := $(OBJDIR)/tads/tads_web.o
CCOBJ_tadstext := $(OBJDIR)/tads/tads_text.o
CC_GROUPS := frotz frotzweb git gitweb glk glkweb glksync glkcheck tads2 tads2cxx tads2os \
             tads2web tads3 tads3web tadsos tadsweb tadstext
# The groups each output links.
TADS2_CC_GROUPS := tads2 tads2cxx tads2os tads2web tadsos tadsweb tadstext glk
TADS3_CC_GROUPS := tads3 tads3web tadsos tadsweb tadstext glk
CCG_frotz       := frotz frotzweb
CCG_git         := git gitweb glk glkweb
CCG_git-async   := $(CCG_git)
CCG_git-sync    := git gitweb glk glksync
CCG_glk-check   := glk glksync glkcheck tadstext
CCG_tads2       := $(TADS2_CC_GROUPS) glkweb
CCG_tads2-async := $(CCG_tads2)
CCG_tads2-check := $(CCG_tads2)
CCG_tads2-sync  := $(TADS2_CC_GROUPS) glksync
CCG_tads3       := $(TADS3_CC_GROUPS) glkweb
CCG_tads3-async := $(CCG_tads3)
CCG_tads3-check := $(CCG_tads3)
CCG_tads3-sync  := $(TADS3_CC_GROUPS) glksync
stale_cc = $(shell printf '%s\n' '$(CC_$(1))' | cmp -s - $(OBJDIR)/$(1).ccflags 2>/dev/null || echo stale)
$(foreach n,$(CC_GROUPS),$(if $(call stale_cc,$(n)),$(eval $(CCOBJ_$(n)): FORCE)))
stamp_cc = printf '%s\n' '$(CC_$(1))' > $(OBJDIR)/$(1).ccflags
# Recipe line: stamp each of the compile-flag groups $(1).
stamp_cc_groups = $(foreach g,$(sort $(1)),$(call stamp_cc,$(g)) &&) true
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

# TADS2_OWN is TADS2_SJLJ for the objects in TADS2_SJLJ_OBJ, else empty.
$(TADS2_SJLJ_OBJ): TADS2_OWN := $(TADS2_SJLJ)

$(OBJDIR)/tads2/%.o: $(TADS)/tads2/%.c $(TADS_HEADERS) | $(OBJDIR)/tads2
	$(EMCC) $(TADS_CFLAGS) $(TADS2_OWN) -c $< -o $@

$(OBJDIR)/tads2/osportable.o: $(TADS)/tads2/osportable.cc $(TADS_HEADERS) | $(OBJDIR)/tads2
	$(EMXX) $(TADS_CXXFLAGS) $(TADS2_OWN) -c $< -o $@

$(OBJDIR)/tads/osansi1.o: $(TADS)/osansi1.c $(TADS_HEADERS) | $(OBJDIR)/tads
	$(EMCC) $(TADS_CFLAGS) -include tads/tads_stdio.h -c $< -o $@

$(OBJDIR)/tads/%.o: $(TADS)/%.c $(TADS_HEADERS) | $(OBJDIR)/tads
	$(EMCC) $(TADS_CFLAGS) -c $< -o $@

$(OBJDIR)/tads/tads_web.o: tads/tads_web.c $(TADS_HEADERS) | $(OBJDIR)/tads
	$(EMCC) $(TADS_CFLAGS) $(WEB_CFLAGS) -c $< -o $@

$(OBJDIR)/tads/tads_text.o: tads/tads_text.c $(TADS_HEADERS) | $(OBJDIR)/tads
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

$(DIST)/tads2%js $(DIST)/tads2%wasm: $(TADS2_OBJ) $(TADS_GLK_ASYNC) $(TADS2_ASYNC_LIST) | $(OBJDIR)
	$(EMXX) $(LINK_tads2) $(TADS2_OBJ) $(TADS_GLK_ASYNC) -o $(DIST)/tads2.js
	$(call stamp_link,tads2)

$(BENCH)/tads2-async%js $(BENCH)/tads2-async%wasm: $(TADS2_OBJ) $(TADS_GLK_ASYNC) $(TADS2_ASYNC_LIST) | $(BENCH)
	$(EMXX) $(LINK_tads2-async) $(TADS2_OBJ) $(TADS_GLK_ASYNC) -o $(BENCH)/tads2-async.js
	$(call stamp_link,tads2-async)

$(BENCH)/tads2-sync%js $(BENCH)/tads2-sync%wasm: $(TADS2_OBJ) $(TADS_GLK_SYNC) | $(BENCH)
	$(EMXX) $(LINK_tads2-sync) $(TADS2_OBJ) $(TADS_GLK_SYNC) -o $(BENCH)/tads2-sync.js
	$(call stamp_link,tads2-sync)

$(DIST)/tads3%js $(DIST)/tads3%wasm: $(TADS3_OBJ) $(TADS_GLK_ASYNC) $(TADS3_ASYNC_LIST) | $(OBJDIR)
	$(EMXX) $(LINK_tads3) $(TADS3_OBJ) $(TADS_GLK_ASYNC) -o $(DIST)/tads3.js
	$(call stamp_link,tads3)

$(BENCH)/tads3-async%js $(BENCH)/tads3-async%wasm: $(TADS3_OBJ) $(TADS_GLK_ASYNC) $(TADS3_ASYNC_LIST) | $(BENCH)
	$(EMXX) $(LINK_tads3-async) $(TADS3_OBJ) $(TADS_GLK_ASYNC) -o $(BENCH)/tads3-async.js
	$(call stamp_link,tads3-async)

$(BENCH)/tads3-sync%js $(BENCH)/tads3-sync%wasm: $(TADS3_OBJ) $(TADS_GLK_SYNC) | $(BENCH)
	$(EMXX) $(LINK_tads3-sync) $(TADS3_OBJ) $(TADS_GLK_SYNC) -o $(BENCH)/tads3-sync.js
	$(call stamp_link,tads3-sync)

$(BENCH)/tads2-check%js $(BENCH)/tads2-check%wasm: $(TADS2_OBJ) $(TADS_GLK_ASYNC) $(TADS2_ASYNC_LIST) | $(BENCH)
	$(EMXX) $(LINK_tads2-check) $(TADS2_OBJ) $(TADS_GLK_ASYNC) -o $(BENCH)/tads2-check.js
	$(call stamp_link,tads2-check)

$(BENCH)/tads3-check%js $(BENCH)/tads3-check%wasm: $(TADS3_OBJ) $(TADS_GLK_ASYNC) $(TADS3_ASYNC_LIST) | $(BENCH)
	$(EMXX) $(LINK_tads3-check) $(TADS3_OBJ) $(TADS_GLK_ASYNC) -o $(BENCH)/tads3-check.js
	$(call stamp_link,tads3-check)

# make asyncify-lists: regenerate tads/asyncify-tads{2,3}.txt (see "ASYNCIFY
# for TADS"). For each interpreter: link it with every function instrumented
# and --profiling-funcs (dist/bench/tadsN-names), play every walkthrough of
# its games on it, noting the frames on the stack at each await
# (dist/obj/tadsN-frames.txt); add the seeds; link with ASYNCIFY_ADVISE and
# those as the add-list (dist/obj/tadsN-advise.txt), and keep every function
# it names. The analysis links are not stamped or kept up to date: this
# target always redoes them. Then `git diff tads/asyncify-*.txt` shows what
# changed, and make asyncify-check tests the result.
TADS2_WALKS := errand.gam:errand errand.gam:errand-cpu stress2.gam:stress2
TADS3_WALKS := belfry.t3:belfry belfry.t3:belfry-cpu stress3.t3:stress3 fin3.t3:fin3
define asyncify_list
	$(EMXX) $(TADS$(1)_FULL) --profiling-funcs $(2) -o $(BENCH)/tads$(1)-names.js
	rm -f $(OBJDIR)/tads$(1)-frames.txt
	$(foreach w,$(TADS$(1)_WALKS),node bench/run-bench.js async bench/tads/$(word 1,$(subst :, ,$(w))) \
	    bench/tads/$(word 2,$(subst :, ,$(w))).walk --engine tads$(1) --module $(BENCH)/tads$(1)-names.js \
	    --frames $(OBJDIR)/tads$(1)-frames.txt > /dev/null &&) true
	cat tads/asyncify-seeds-tads$(1).txt $(OBJDIR)/tads$(1)-frames.txt > $(OBJDIR)/tads$(1)-add.txt
	$(EMXX) $(TADS$(1)_FULL) -sASYNCIFY_IGNORE_INDIRECT -sASYNCIFY_ADVISE \
	    -sASYNCIFY_ADD=@$(OBJDIR)/tads$(1)-add.txt $(2) -o $(BENCH)/tads$(1)-advise.js \
	    > $(OBJDIR)/tads$(1)-advise.txt 2>&1
	node bench/asyncify-list.js $(OBJDIR)/tads$(1)-advise.txt tads/asyncify-tads$(1).txt \
	    "Functions ASYNCIFY instruments in TADS $(1) (-sASYNCIFY_ONLY). Generated by" \
	    "make asyncify-lists; do not edit (web/Makefile, \"ASYNCIFY for TADS\")."
endef

asyncify-lists: $(TADS2_OBJ) $(TADS3_OBJ) $(TADS_GLK_ASYNC) | $(BENCH)
	$(call asyncify_list,2,$(TADS2_OBJ) $(TADS_GLK_ASYNC))
	$(call asyncify_list,3,$(TADS3_OBJ) $(TADS_GLK_ASYNC))
	$(call stamp_cc_groups,$(CCG_tads2) $(CCG_tads3))

asyncify-check: $(BENCH)/tads2-check.js $(BENCH)/tads2-check.wasm $(BENCH)/tads3-check.js \
                $(BENCH)/tads3-check.wasm $(BENCH)/tads2-sync.js $(BENCH)/tads2-sync.wasm \
                $(BENCH)/tads3-sync.js $(BENCH)/tads3-sync.wasm
	node bench/check-asyncify.js

# Objects reached only through a pattern rule would count as intermediate
# and be deleted after the link; keep them so rebuilds are incremental.
.SECONDARY: $(CORE_OBJ) $(WEB_OBJ) $(GIT_OBJ) $(GLK_ASYNC_OBJ) $(GLK_SYNC_OBJ) $(CHECK_OBJ) \
            $(TADS2_OBJ) $(TADS3_OBJ)

# The site is rebuilt from scratch every time: it is a copy, and a stale
# hashed file left behind would be harmless but confusing.
dist: all
	node deploy/build-site.js $(SITE)

# The checks that need a real Safari (bench/safari-check.js): run before any
# release, on an unlocked Mac. Writes bench/last-safari-check.md.
safari-check: dist
	node bench/safari-check.js

serve: dist
	python3 deploy/serve.py $(SITE) 8000

serve-dev: all
	python3 -m http.server 8000

clean:
	rm -rf $(DIST) $(SITE)

.PHONY: all frotz git tads2 tads3 bench bench-tads check asyncify-lists asyncify-check dist safari-check serve \
        serve-dev clean FORCE
