/*
 * web/tads/tads_stdio.h: forced into tads/osansi1.c only (-include).
 *
 * TADS opens files with stdio (osfoprb, osfopwb, ... in osansi1.c), not
 * with Glk streams, so the browser Glk never sees its saves. Renaming
 * fopen and fclose in that one file routes them through tads_web.c, which
 * brings a /saves file in from browser storage before it is opened and
 * stores it after a write-mode close, as a Glk file stream does
 * (glkweb_file_will_open / glkweb_file_did_write in web/glk/glk_web.h).
 * Every other file keeps the real fopen and fclose.
 */
#ifndef WEB_TADS_STDIO_H
#define WEB_TADS_STDIO_H

#include <stdio.h>

FILE *tadsweb_fopen(const char *path, const char *mode);
int tadsweb_fclose(FILE *fp);

#define fopen tadsweb_fopen
#define fclose tadsweb_fclose

#endif
