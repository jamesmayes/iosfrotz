/*
 * web/tads/tads_web.h: the helpers in tads_web.c and tads_text.c that the
 * TADS 2 and TADS 3 startup files call.
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

/* tads_text.c: on (TADS 3), the game's text is always UTF-8; off (TADS 2,
   the default), it is UTF-8 until a string is not, then Windows-1252. */
void tadsweb_text_utf8(int on);
/* Has a TADS 2 game's text been taken as Windows-1252? */
int tadsweb_text_legacy(void);

#ifdef __cplusplus
}
#endif

#endif
