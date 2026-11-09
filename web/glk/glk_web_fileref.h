/*
 * web/glk/glk_web_fileref.h: the browser Glk's fileref (glk_web.c).
 *
 * Only glk_web.c creates and frees these. The definition is shared because
 * tads/osglk.c (os_askfile) copies a prompted file's name straight out of
 * the iOS library's struct, as fileref->filename; web/tads/shim/glkios.h
 * includes this header so that line compiles unmodified. The name is held
 * once: `filename` is the same pointer as `path`.
 */
#ifndef WEB_GLK_WEB_FILEREF_H
#define WEB_GLK_WEB_FILEREF_H

#include "glk.h"
#include "gi_dispa.h"

struct glk_fileref_struct {
    glui32 rock;
    union {
        char *path;     /* glk_web.c's name for it */
        char *filename; /* glkios's name, which osglk.c uses */
    };
    glui32 usage;
    struct glk_fileref_struct *next, *prev;
    gidispatch_rock_t disprock;
};

#endif
