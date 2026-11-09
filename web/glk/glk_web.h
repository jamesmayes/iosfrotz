/*
 * web/glk/glk_web.h: what the browser Glk (glk_web.c) offers its startup
 * files (git_web.c, web/tads/). Everything else goes through glk.h.
 */
#ifndef WEB_GLK_WEB_H
#define WEB_GLK_WEB_H

/* Before glk_main: measure the page, open nothing yet. story_path names the
   story file in MEMFS; its stem (up to the first '.') names the saves. */
void glkweb_init(const char *story_path);

/* For an interpreter that opens files with stdio instead of Glk streams
   (TADS, through web/tads/tads_web.c): bring a /saves file in from browser
   storage before it is opened, and store it after a write-mode close, with
   the same rules as a Glk file stream. Other paths are ignored. */
void glkweb_file_will_open(const char *path);
void glkweb_file_did_write(const char *path);

/* After glk_main returns: flush output and tell the page the game ended. */
void glkweb_finish(void);

/* Print a fatal error in the story window (opening one if there is none),
   flush, and exit. */
void glkweb_fatal(const char *msg) __attribute__((noreturn));

#endif
