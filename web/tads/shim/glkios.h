/*
 * web/tads/shim/glkios.h
 *
 * Stands in for glkios/glkios.h, the iOS Glk library's private header,
 * which tads/osglk.c includes unconditionally. osglk.c uses two things
 * from it:
 *
 *   - gli_rootwin (os_term closes it): the browser Glk keeps its root
 *     window private, so this is the standard glk_window_get_root();
 *   - the fileref struct (os_askfile reads fileref->filename): the browser
 *     Glk's own, where `filename` is another name for its path.
 */
#ifndef WEB_TADS_GLKIOS_SHIM_H
#define WEB_TADS_GLKIOS_SHIM_H

#include "glk.h"
#include "glk_web_fileref.h"

#define gli_rootwin (glk_window_get_root())

#endif
