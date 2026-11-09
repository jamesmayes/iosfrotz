/*
 * web/tads/tads_web.c: what both TADS builds need from the browser that
 * the iOS app supplies elsewhere (web/README.md, "TADS").
 *
 *   - The iOS autosave hooks that tads/osglk.c, tads3/vmrun.cpp and
 *     tads3/vmconsol.cpp read (web/tads/shim/iosfrotz.h): there is no
 *     autosave on the web, so do_autosave stays 0.
 *   - git_shutdown_dispatch(), which tads/osglk.c's os_term calls into the
 *     iOS git integration: nothing to do with one game per instance.
 *   - `finished` (tads2/ply.c's main loop runs until it is set; on iOS it
 *     is Frotz's global, which the app sets to stop a game) and
 *     os_more_prompt (tads2/output.c; on iOS, Frotz's, which pauses only
 *     for V4 Z-code): the page never stops a game this way, and has no
 *     [MORE] paging, as for Z-code.
 *   - tadsweb_fopen/tadsweb_fclose, which tads/osansi1.c calls in place of
 *     fopen/fclose (web/tads/tads_stdio.h), so TADS's saves go through the
 *     same browser storage as a Glk file stream.
 *   - tadsweb_validate, the startup check on the story file's signature.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "glk.h"
#include "glk_web.h"
#include "tads_web.h"

int do_autosave = 0, autosave_done = 0;
char AUTOSAVE_FILE[] = "/tmp/autosave.tads";

void iosif_mark_recent_save(void)
{
}

void git_shutdown_dispatch(void)
{
}

int finished = 0;

void os_more_prompt(void)
{
}

/* ---- stdio files under /saves ---- */

/* The files osansi1.c has open for writing, with their paths, so a close
   knows what to store. TADS keeps a handful open at most (the game, a
   save, a log or command file); past the table's size a file is still
   opened, it is just not stored. */
#define MAX_TRACKED 16
static struct {
    FILE *fp;
    char *path;
} tracked[MAX_TRACKED];

static int writes(const char *mode)
{
    return strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+');
}

FILE *tadsweb_fopen(const char *path, const char *mode)
{
    FILE *fp;
    int i;
    if (!path || !mode)
        return NULL;
    glkweb_file_will_open(path);
    fp = fopen(path, mode);
    if (fp && writes(mode)) {
        for (i = 0; i < MAX_TRACKED; i++) {
            if (!tracked[i].fp) {
                tracked[i].path = strdup(path);
                if (tracked[i].path)
                    tracked[i].fp = fp;
                break;
            }
        }
    }
    return fp;
}

int tadsweb_fclose(FILE *fp)
{
    int i, r;
    char *path = NULL;
    for (i = 0; i < MAX_TRACKED; i++) {
        if (fp && tracked[i].fp == fp) {
            path = tracked[i].path;
            tracked[i].fp = NULL;
            tracked[i].path = NULL;
            break;
        }
    }
    r = fclose(fp);
    if (path) {
        glkweb_file_did_write(path);
        free(path);
    }
    return r;
}

/* ---- Startup ---- */

void tadsweb_validate(const char *path, const char *magic, size_t len,
                      const char *what)
{
    char head[16];
    char msg[128];
    FILE *f = fopen(path, "rb");
    size_t got = 0;
    if (!f)
        glkweb_fatal("Could not open the story file.");
    if (len > sizeof head)
        len = sizeof head;
    got = fread(head, 1, len, f);
    fclose(f);
    if (got != len || memcmp(head, magic, len) != 0) {
        snprintf(msg, sizeof msg, "This is not a %s story file.", what);
        glkweb_fatal(msg);
    }
}
