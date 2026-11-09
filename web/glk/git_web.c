/*
 * web/glk/git_web.c: startup code for git/ on the browser Glk (glk_web.c).
 *
 * git/README.txt asks a port for glk_main() and fatalError(). This plays the
 * part of git/git_unix.c: the page writes the story into MEMFS and calls
 * main() with its path. The file is read into memory and handed to git(),
 * which finds the Glulx chunk itself if it is a Blorb (gi_blorb.c).
 */

#include <stdio.h>
#include <stdlib.h>

#include "git.h"
#include "glk.h"
#include "glk_web.h"

/* The sizes git_unix.c uses, unless the build says otherwise. */
#ifndef CACHE_SIZE
#define CACHE_SIZE (256 * 1024L)
#endif
#ifndef UNDO_SIZE
#define UNDO_SIZE (2 * 1024 * 1024L)
#endif

static const char *story_path = NULL;

void fatalError(const char *s)
{
    glkweb_fatal(s);
}

void glk_main(void)
{
    FILE *f;
    long size = 0;
    git_uint8 *game;

    f = fopen(story_path, "rb");
    if (!f)
        fatalError("Could not open the story file.");
    if (fseek(f, 0, SEEK_END) != 0 || (size = ftell(f)) < 0)
        fatalError("Could not read the story file.");
    if (size < 256)
        fatalError("This is too small to be a Glulx file.");
    rewind(f);
    game = malloc((size_t) size);
    if (!game)
        fatalError("Not enough memory to load the story file.");
    if (fread(game, 1, (size_t) size, f) != (size_t) size)
        fatalError("Could not read the story file.");
    fclose(f);

    /* git keeps a pointer to the image (and the Blorb map reads from it),
       so it is not freed. */
    git(game, (git_uint32) size, CACHE_SIZE, UNDO_SIZE);
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: git story.ulx\n");
        return 1;
    }
    story_path = argv[1];
    glkweb_init(story_path);
    glk_main();
    glkweb_finish();
    return 0;
}
