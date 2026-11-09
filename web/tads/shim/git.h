/*
 * web/tads/shim/git.h
 *
 * tads/osglk.c includes git's header unconditionally, for the one call
 * os_term makes into the iOS git integration: git_shutdown_dispatch(),
 * which there unregisters the Glk dispatch objects between games. A web
 * page runs one game per WebAssembly instance, so web/tads/tads_web.c
 * defines it as a no-op. git/ is not on the TADS include path.
 */
#ifndef WEB_TADS_GIT_SHIM_H
#define WEB_TADS_GIT_SHIM_H

#ifdef __cplusplus
extern "C" {
#endif

void git_shutdown_dispatch(void);

#ifdef __cplusplus
}
#endif

#endif
