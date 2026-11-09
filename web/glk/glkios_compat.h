/*
 * web/glk/glkios_compat.h
 *
 * glkios/cgunicod.c and glkios/cgdate.c (copied there from CheapGlk) are
 * reused unmodified for Unicode case conversion and the date/time calls.
 * They include "glkios.h", the iOS library's private header, which drags in
 * the iOS window structures. Defining its include guard first skips it, and
 * this header supplies the few things those two files use from it.
 */
#ifndef WEB_GLKIOS_COMPAT_H
#define WEB_GLKIOS_COMPAT_H

#define GLKTERM_H 1     /* glkios/glkios.h's include guard */

#include <stdio.h>
#include <wchar.h>
#include "glk.h"
#include "gi_dispa.h"

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

/* Library warnings go to the console. */
#define gli_strict_warning(msg) (fputws(msg, stderr), fputwc(L'\n', stderr))

/* The tables in glkios/cgunigen.c use these (from cheapglk.h). */
typedef glui32 gli_case_block_t[2];   /* upper, lower */
typedef glui32 gli_case_special_t[3]; /* upper, lower, title */
typedef glui32 gli_decomp_block_t[2]; /* count, position */

#endif
