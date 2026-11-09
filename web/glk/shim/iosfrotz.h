/*
 * web/glk/shim/iosfrotz.h
 *
 * git/git.c and git/memory.c include "iosfrotz.h" unconditionally, but use
 * it only under FROTZ_IOS, which the web build does not define. This empty
 * stand-in keeps them from pulling in include/iosfrotz.h (CoreGraphics, the
 * iOS Glk). It is only on the include path of the Glulx build; the Frotz
 * build has its own web/shim/iosfrotz.h.
 */
#ifndef WEB_GLK_IOSFROTZ_SHIM_H
#define WEB_GLK_IOSFROTZ_SHIM_H
#endif
