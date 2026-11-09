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
 *     same browser storage as a Glk file stream; a /saves file that could
 *     not be stored on its close is not opened at all.
 *   - tadsweb_validate, the startup check on the story file's signature.
 */

#include <errno.h>
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

/* The /saves files osansi1.c has open for writing, with their paths, so a
   close knows what to store. Files elsewhere (MEMFS only) are not tracked.

   A slot (and the copy of the path) is reserved before the file is opened,
   so an open is never let through, truncating the file, when its close
   could not then store it: if the table cannot grow, or is at
   MAX_TRACKED, or the path cannot be copied, the open fails (errno ENOMEM
   or EMFILE) and the game reports a failed save, as it would for a full
   disk. TADS keeps a handful open at most (a save, a log, a command file),
   so the bound is far above what a game uses; it only keeps a game that
   leaks open files from growing the table without end. */
#define MAX_TRACKED 256
static struct tracked_file {
    FILE *fp;
    char *path;
} *tracked = NULL;
static size_t ntracked = 0, tracked_cap = 0;

static int writes(const char *mode)
{
    return strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+');
}

static int under_saves(const char *path)
{
    return strncmp(path, "/saves/", 7) == 0;
}

/* Room for one more entry; 0 if there is none (errno set). */
static int reserve(void)
{
    struct tracked_file *t;
    size_t cap;
    if (ntracked < tracked_cap)
        return 1;
    if (tracked_cap >= MAX_TRACKED) {
        errno = EMFILE;
        return 0;
    }
    cap = tracked_cap ? tracked_cap * 2 : 8;
    if (cap > MAX_TRACKED)
        cap = MAX_TRACKED;
    t = realloc(tracked, cap * sizeof *t);
    if (!t) {
        errno = ENOMEM;
        return 0;
    }
    tracked = t;
    tracked_cap = cap;
    return 1;
}

FILE *tadsweb_fopen(const char *path, const char *mode)
{
    FILE *fp;
    char *copy = NULL;
    if (!path || !mode)
        return NULL;
    if (writes(mode) && under_saves(path)) {
        if (!reserve())
            return NULL;
        copy = strdup(path);
        if (!copy) {
            errno = ENOMEM;
            return NULL;
        }
    }
    glkweb_file_will_open(path);
    fp = fopen(path, mode);
    if (!copy)
        return fp;
    if (!fp) {
        free(copy);
        return NULL;
    }
    tracked[ntracked].fp = fp;
    tracked[ntracked].path = copy;
    ntracked++;
    return fp;
}

int tadsweb_fclose(FILE *fp)
{
    size_t i;
    int r;
    char *path = NULL;
    for (i = 0; fp && i < ntracked; i++) {
        if (tracked[i].fp == fp) {
            path = tracked[i].path;
            tracked[i] = tracked[--ntracked];
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
