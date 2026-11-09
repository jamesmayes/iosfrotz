/*
 * web/tads/tads_web.h: the startup helpers in tads_web.c, shared by the
 * TADS 2 and TADS 3 startup files.
 */
#ifndef WEB_TADS_WEB_H
#define WEB_TADS_WEB_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Refuse (glkweb_fatal) a story file whose first len bytes are not magic;
   `what` names the format in the message. */
void tadsweb_validate(const char *path, const char *magic, size_t len,
                      const char *what);

#ifdef __cplusplus
}
#endif

#endif
