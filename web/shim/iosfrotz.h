/*
 * web/shim/iosfrotz.h
 *
 * Stand-in for include/iosfrotz.h when building the Frotz core for
 * WebAssembly. frotz/common/screen.c includes "iosfrotz.h" unconditionally,
 * and the core references iOS-only globals (do_autosave, fileZCodeOffset,
 * AUTOSAVE_FILE, ...) whether or not FROTZ_IOS is set, so the web build
 * compiles the core with -DFROTZ_IOS=1 and this header supplies the subset
 * of declarations the core needs, without CoreGraphics or Glk.
 */
#ifndef __IOSFROTZ_H
#define __IOSFROTZ_H 1
#define FROTZ_IOS_FILE 1

#include <stdbool.h>
#ifndef FALSE
#define FALSE 0
#endif
#ifndef TRUE
#define TRUE 1
#endif

#include "frotz.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <time.h>

#define QUETZAL_DEF 1
#define NO_SOUND 1

#define MAX_ROWS 100
#define MAX_COLS 100

extern f_setup_t f_setup;
extern int finished; /* set by z_quit */

bool is_terminator (zchar);

#define XYZZY()
extern int do_autosave, autosave_done, refresh_savedir;
extern char SAVE_PATH[], AUTOSAVE_FILE[];

#endif /* __IOSFROTZ_H */
