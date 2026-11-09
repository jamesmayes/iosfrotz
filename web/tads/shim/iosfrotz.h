/*
 * web/tads/shim/iosfrotz.h
 *
 * Stands in for include/iosfrotz.h (CoreGraphics, the iOS Glk) in the TADS
 * builds. tads/osglk.c, tads3/vmrun.cpp and tads3/vmconsol.cpp include it
 * unconditionally and use the iOS autosave hooks from it; the web client
 * has no autosave, so web/tads/tads_web.c defines do_autosave as 0 and
 * nothing ever sets it.
 */
#ifndef WEB_TADS_IOSFROTZ_SHIM_H
#define WEB_TADS_IOSFROTZ_SHIM_H

#ifdef __cplusplus
extern "C" {
#endif

extern int do_autosave, autosave_done;
extern char AUTOSAVE_FILE[];
void iosif_mark_recent_save(void);

#ifdef __cplusplus
}
#endif

#endif
