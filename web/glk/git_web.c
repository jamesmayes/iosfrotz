/*
 * web/glk/git_web.c: startup code for git/ on the browser Glk (glk_web.c).
 *
 * git/README.txt asks a port for glk_main() and fatalError(). This plays the
 * part of git/git_unix.c: the page writes the story into MEMFS and calls
 * main() with its path. The file is read into memory and handed to git(),
 * which finds the Glulx chunk itself if it is a Blorb (gi_blorb.c).
 *
 * A story can be any file the player opens, and neither gi_blorb.c nor git
 * checks a Blorb's declared sizes against the real file: a chunk that claims
 * more bytes than there are would have git copy past the end of the image.
 * So the file is validated here first (validate_story), with 64-bit
 * arithmetic, and refused with a message in the story window if anything in
 * it points outside the file.
 */

#include <stdint.h>
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

static uint32_t be32(const git_uint8 *p)
{
    return ((uint32_t) p[0] << 24) | ((uint32_t) p[1] << 16) |
           ((uint32_t) p[2] << 8) | (uint32_t) p[3];
}

#define ID(a, b, c, d) (((uint32_t) (a) << 24) | ((uint32_t) (b) << 16) | \
                        ((uint32_t) (c) << 8) | (uint32_t) (d))

/* A Glulx image of len bytes: the magic number, and a header whose memory
   map fits the image (RAMSTART <= EXTSTART <= len, EXTSTART <= ENDMEM, all
   multiples of 256; git/memory.c makes the same checks). NULL if it is
   sound, else what is wrong. */
static const char *validate_glulx(const git_uint8 *g, uint64_t len)
{
    uint32_t ram, ext, end;
    if (len < 36 || be32(g) != ID('G', 'l', 'u', 'l'))
        return "This is not a Glulx story file.";
    ram = be32(g + 8);
    ext = be32(g + 12);
    end = be32(g + 16);
    if (ram < 36 || ram > ext || (uint64_t) ext > len || ext > end ||
        (ram & 255) || (ext & 255) || (end & 255))
        return "This Glulx file is damaged: its header does not match its length.";
    return NULL;
}

/* A Blorb (IFF FORM of type IFRS) of len bytes, len >= 12. Checks, before
   gi_blorb.c sees it: the FORM fits the file; every chunk header and
   payload fits the FORM; the resource index has its count and as many
   12-byte entries as it claims, each at the start of a real chunk; and the
   executable (Exec 0) is a GLUL chunk holding a sound Glulx image. */
static const char *validate_blorb(const git_uint8 *b, uint64_t len)
{
    static const char *damaged = "This Blorb file is damaged: a part of it "
                                 "claims more bytes than the file has.";
    uint64_t end, pos, ridx = 0, ridxlen = 0, exec = 0;
    uint64_t count, i, j;
    int have_ridx = 0, have_exec = 0;

    if (be32(b + 8) != ID('I', 'F', 'R', 'S'))
        return "This is not a Blorb file.";
    end = 8 + (uint64_t) be32(b + 4);
    if (end > len)
        return damaged;

    for (pos = 12; pos < end; ) {
        uint64_t size;
        if (pos + 8 > end)
            return damaged;
        size = be32(b + pos + 4);
        if (pos + 8 + size > end)
            return damaged;
        if (be32(b + pos) == ID('R', 'I', 'd', 'x')) {
            if (have_ridx)
                return "This Blorb file is damaged: it has two resource indexes.";
            have_ridx = 1;
            ridx = pos + 8;
            ridxlen = size;
        }
        pos += 8 + size + (size & 1);
    }

    if (!have_ridx)
        return "This Blorb file has no resource index.";
    if (ridxlen < 4)
        return damaged;
    count = be32(b + ridx);
    if (count * 12 > ridxlen - 4)
        return damaged;

    for (i = 0; i < count; i++) {
        const git_uint8 *e = b + ridx + 4 + i * 12;
        uint64_t start = be32(e + 8);
        int found = 0;
        /* The entry must name the start of a chunk walked above. */
        for (j = 12; j < end; ) {
            uint64_t size = be32(b + j + 4);
            if (j == start) { found = 1; break; }
            j += 8 + size + (size & 1);
        }
        if (!found)
            return "This Blorb file is damaged: its index points outside its chunks.";
        if (be32(e) == ID('E', 'x', 'e', 'c') && be32(e + 4) == 0) {
            have_exec = 1;
            exec = start;
        }
    }

    if (!have_exec)
        return "This Blorb file does not contain a Glulx game.";
    if (be32(b + exec) != ID('G', 'L', 'U', 'L'))
        return "This Blorb file's game is not a Glulx game.";
    return validate_glulx(b + exec + 8, be32(b + exec + 4));
}

static const char *validate_story(const git_uint8 *g, uint64_t len)
{
    if (len >= 12 && be32(g) == ID('F', 'O', 'R', 'M'))
        return validate_blorb(g, len);
    return validate_glulx(g, len);
}

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

    {
        const char *why = validate_story(game, (uint64_t) size);
        if (why)
            fatalError(why);
    }

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
