/*
 * web/glk/glk_web.c
 *
 * A small browser implementation of the Glk 0.7.4 API (glkios/glk.h), for
 * the Glulx interpreters in this repo compiled to WebAssembly. It is written
 * for git/ first; glulxe/ uses the same API.
 *
 * Model (close to GlkOte's): the library owns the window tree and computes
 * the layout itself, in CSS pixels, from font metrics the page measures
 * (Module.glkWeb.metrics). Window sizes in characters, which games read
 * with glk_window_get_size, come from the same numbers. The page only draws:
 *
 *   - text buffer windows: text is batched per window as UTF-8, with a
 *     style marker byte (0x01, then 'a' + style) at each style change, and
 *     handed to the page when the game waits for input;
 *   - text grid windows: a cell grid (code point + style) sent whole when
 *     it changed;
 *   - the layout: one record per leaf window (id, type, rectangle) when the
 *     tree or the page size changed.
 *
 * glk_select is where the interpreter waits for the player. It flushes the above,
 * tells the page which windows want line or char input, and awaits
 * Module.glkWeb.wait() through EM_ASYNC_JS, so under -sASYNCIFY the C stack
 * unwinds and the browser event loop runs. Timers are kept here: select
 * passes the time left to the next tick as the wait's timeout. The file
 * bridges (load, persist and delete of a /saves file) are awaited too, so
 * the C stack also unwinds inside file calls.
 *
 * Built with -DGLK_WEB_SYNC (the benchmark's non-ASYNCIFY build), the same
 * bridge functions are plain EM_JS and Module.glkWeb.wait() must return
 * the event synchronously.
 *
 * Files live in MEMFS. Everything under /saves (saved games, data files,
 * transcripts) is persisted one file at a time through web/saves.js: a
 * write-mode stream is written to IndexedDB when it is closed, and a file
 * is brought in from IndexedDB (by revision; see saves.js) before it is
 * opened or tested for existence. glk_fileref_create_by_prompt does not prompt: it uses a
 * fixed name per story and usage, as the Z-machine client does.
 *
 * Not implemented (gestalt says so): graphics windows, images, sound,
 * hyperlinks, mouse input, Unicode normalisation. Style hints are accepted
 * and ignored; the 11 styles map to fixed CSS classes.
 */

#include <emscripten.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "glk.h"
#include "gi_dispa.h"
#include "gi_blorb.h"
#include "glk_web.h"
#include "glk_web_fileref.h"

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

typedef struct glk_window_struct window_t;
typedef struct glk_stream_struct stream_t;
typedef struct glk_fileref_struct fileref_t;

#define SAVE_DIR "/saves"
#define STYLE_MARK '\x01'

/* ---- JavaScript bridge (Module.glkWeb, see web/glk.js) ---- */

/* For the measurement (bench/run-bench.js): after an await, the C stack has
   been unwound into the Asyncify buffer and not yet rewound, so the
   buffer's stack_ptr (the first field of asyncify_data_s, whose header is
   12 bytes on wasm32) tells how much of ASYNCIFY_STACK_SIZE this wait used.
   Each async bridge function below reports it to Module.glkWeb.asyncifyUsed
   if defined; the page does not define it. (Written out in each body:
   macros are not expanded inside EM_JS.) */

/* m[0..9]: page width, height; grid char width, height; buffer char width,
   height; grid padding x, y; buffer padding x, y (all CSS px). */
EM_JS(void, js_metrics, (double *m), {
    const out = Module.glkWeb.metrics();
    for (let i = 0; i < 10; i++) HEAPF64[(m >> 3) + i] = out[i];
});

/* n records of 6 ints: id, wintype, left, top, width, height. */
EM_JS(void, js_layout, (const int *rec, int n), {
    Module.glkWeb.layout(HEAP32.slice(rec >> 2, (rec >> 2) + n * 6), n);
});

EM_JS(void, js_text, (int id, const char *utf8, int clear), {
    Module.glkWeb.text(id, UTF8ToString(utf8), clear !== 0);
});

EM_JS(void, js_grid, (int id, int cols, int rows, const glui32 *ch,
                      const unsigned char *st), {
    Module.glkWeb.grid(id, cols, rows,
                       HEAPU32.slice(ch >> 2, (ch >> 2) + cols * rows),
                       HEAPU8.slice(st, st + cols * rows));
});

EM_JS(void, js_inputs_begin, (void), {
    Module.glkWeb.inputsBegin();
});

/* One record per pending request, sent on every wait. kind 1 = line,
   2 = char. initial: UTF-8 text the line starts with, sent only on the
   first wait after the request (the page then creates its record for the
   request); NULL on later waits (the page keeps what the player has typed
   so far). maxlen: the most code points the line may hold. terms: Glk
   keycodes that end the line besides Enter. */
EM_JS(void, js_input, (int id, int kind, const char *initial, int maxlen,
                       const glui32 *terms, int nterms), {
    Module.glkWeb.input(id, kind, initial ? UTF8ToString(initial) : null, maxlen,
                        Array.from(HEAPU32.subarray(terms >> 2, (terms >> 2) + nterms)));
});

/* Writes the event to ev[0..3] (type, window id, val1, val2) and, for a
   line event, the line as UTF-8 to text. type 0 means the timeout ran out. */
#ifdef GLK_WEB_SYNC
EM_JS(void, js_wait, (int timeout_ms, int *ev, char *text, int cap), {
    const e = Module.glkWeb.wait(timeout_ms);
#else
EM_ASYNC_JS(void, js_wait, (int timeout_ms, int *ev, char *text, int cap), {
    const e = await Module.glkWeb.wait(timeout_ms);
    if (Module.glkWeb.asyncifyUsed && Asyncify.currData)
        Module.glkWeb.asyncifyUsed(HEAPU32[Asyncify.currData >> 2] - Asyncify.currData - 12);
#endif
    HEAP32[ev >> 2] = e.type | 0;
    HEAP32[(ev >> 2) + 1] = e.win | 0;
    HEAP32[(ev >> 2) + 2] = e.val1 | 0;
    HEAP32[(ev >> 2) + 3] = e.val2 | 0;
    stringToUTF8(e.text || "", text, cap);
});

/* The partial line of a cancelled line request, as UTF-8 into text. */
EM_JS(void, js_cancel_line, (int id, char *text, int cap), {
    stringToUTF8(Module.glkWeb.cancelLine(id) || "", text, cap);
});

EM_JS(void, js_cancel_char, (int id), {
    Module.glkWeb.cancelChar(id);
});

/* Non-zero if the page changed size since the layout was last computed. */
EM_JS(int, js_poll_arrange, (void), {
    return Module.glkWeb.pollArrange() ? 1 : 0;
});

#ifdef GLK_WEB_SYNC
EM_JS(void, js_load_file, (const char *path), {
    Module.glkWeb.loadFile(UTF8ToString(path));
});
EM_JS(void, js_persist_file, (const char *path), {
    Module.glkWeb.persistFile(UTF8ToString(path));
});
#else
/* Bring one /saves file in from IndexedDB (web/saves.js decides when).
   Never fails: a storage error leaves MEMFS as it is. */
EM_ASYNC_JS(void, js_load_file, (const char *path), {
    await Module.glkWeb.loadFile(UTF8ToString(path));
    if (Module.glkWeb.asyncifyUsed && Asyncify.currData)
        Module.glkWeb.asyncifyUsed(HEAPU32[Asyncify.currData >> 2] - Asyncify.currData - 12);
});
/* Write one /saves file to IndexedDB. A conflict or failure is reported by
   the page. */
EM_ASYNC_JS(void, js_persist_file, (const char *path), {
    await Module.glkWeb.persistFile(UTF8ToString(path));
    if (Module.glkWeb.asyncifyUsed && Asyncify.currData)
        Module.glkWeb.asyncifyUsed(HEAPU32[Asyncify.currData >> 2] - Asyncify.currData - 12);
});
#endif

#ifdef GLK_WEB_SYNC
EM_JS(void, js_delete_file, (const char *path), {
    Module.glkWeb.deleteFile(UTF8ToString(path));
});
#else
/* Delete one /saves file from IndexedDB (a tombstone; see saves.js), so it
   stays deleted after a reload. Awaited, so a save of the same name right
   after cannot overtake it. A failure is reported by the page. */
EM_ASYNC_JS(void, js_delete_file, (const char *path), {
    await Module.glkWeb.deleteFile(UTF8ToString(path));
    if (Module.glkWeb.asyncifyUsed && Asyncify.currData)
        Module.glkWeb.asyncifyUsed(HEAPU32[Asyncify.currData >> 2] - Asyncify.currData - 12);
});
#endif

EM_JS(void, js_set_story, (const char *stem, const char *save_name), {
    Module.glkWeb.setStory(UTF8ToString(stem), UTF8ToString(save_name));
});

EM_JS(void, js_exit, (void), {
    Module.glkWeb.exit();
});

/* ---- Objects ---- */

struct glk_window_struct {
    glui32 rock, type;
    int id;
    window_t *parent;

    /* Pair windows */
    window_t *child1, *child2, *key;
    glui32 method, size;
    int vertical, backward;

    /* Layout, CSS px */
    int left, top, width, height;

    stream_t *str, *echostr;
    glui32 style;

    /* Input */
    int line_req, line_uni, line_initial_pending;
    void *line_buf;
    glui32 line_maxlen;        /* the game's buffer size */
    glui32 line_limit;         /* code points accepted: maxlen, or what is
                                  left of the grid row */
    int line_echo;             /* echo_line when the request was made */
    char *line_initial;
    gidispatch_rock_t line_arrrock;
    int char_req, char_uni;
    int echo_line;
    glui32 terms[16];
    int nterms;

    /* Text buffer: output not yet handed to the page */
    char *pend;
    size_t pendlen, pendcap;
    int pend_style, pend_clear;

    /* Text grid */
    int cols, rows;
    glui32 *gch;
    unsigned char *gst;
    int curx, cury;
    int gdirty;

    window_t *next, *prev;
    gidispatch_rock_t disprock;
};

enum { STR_WINDOW = 1, STR_MEMORY, STR_FILE };

struct glk_stream_struct {
    glui32 rock;
    int type;
    int unicode;
    int readable, writable;
    glui32 readcount, writecount;

    window_t *win;

    /* Memory (and resource) streams */
    unsigned char *buf;
    glui32 *ubuf;
    glui32 buflen, pos, eof;
    int owned;                 /* buffer is ours to free (resources) */
    int registered;
    gidispatch_rock_t arrrock;

    /* File streams */
    FILE *fp;
    char *path;
    int textmode;
    int lastop;                /* 0, 'r' or 'w': fseek between switches */
    int written;

    stream_t *next, *prev;
    gidispatch_rock_t disprock;
};

/* struct glk_fileref_struct is in glk_web_fileref.h, so that TADS's
   osglk.c, which reads fileref->filename, can see it (web/tads/shim). */

static window_t *winlist = NULL, *rootwin = NULL;
static stream_t *strlist = NULL, *curstr = NULL;
static fileref_t *freflist = NULL;
static int next_win_id = 1;
static int layout_dirty = 1;

static double met[10];
#define M_W    met[0]
#define M_H    met[1]
#define M_GCW  met[2]
#define M_GCH  met[3]
#define M_BCW  met[4]
#define M_BCH  met[5]
#define M_GPX  met[6]
#define M_GPY  met[7]
#define M_BPX  met[8]
#define M_BPY  met[9]

static char story_stem[64] = "story";

static glui32 timer_interval = 0;
static double timer_next = 0;
/* Set when glk_select returned a timer event without waiting on the page;
   cleared by every wait. While set, an overdue timer is only returned after
   a wait (see glk_select). */
static int timer_without_wait = 0;

static gidispatch_rock_t (*reg_obj)(void *obj, glui32 objclass) = NULL;
static void (*unreg_obj)(void *obj, glui32 objclass, gidispatch_rock_t rock) = NULL;
static gidispatch_rock_t (*reg_arr)(void *array, glui32 len, char *typecode) = NULL;
static void (*unreg_arr)(void *array, glui32 len, char *typecode,
                         gidispatch_rock_t rock) = NULL;

/* glkweb_set_pending_hook: a layer above Glk that holds text back. */
static void (*pending_hook)(strid_t str) = NULL;

void glkweb_set_pending_hook(void (*fn)(strid_t str))
{
    pending_hook = fn;
}

static void *xalloc(size_t n)
{
    void *p = calloc(1, n);
    if (!p)
        glkweb_fatal("Out of memory in the Glk library.");
    return p;
}

static char *xstrdup(const char *s)
{
    char *p = xalloc(strlen(s) + 1);
    strcpy(p, s);
    return p;
}

#define LINK(list, obj) do { (obj)->prev = NULL; (obj)->next = (list); \
    if (list) (list)->prev = (obj); (list) = (obj); } while (0)
#define UNLINK(list, obj) do { if ((obj)->prev) (obj)->prev->next = (obj)->next; \
    else (list) = (obj)->next; if ((obj)->next) (obj)->next->prev = (obj)->prev; } while (0)

/* ---- UTF-8 ---- */

static int utf8_encode(glui32 c, char *d)
{
    if (c < 0x80) { d[0] = (char) c; return 1; }
    if (c < 0x800) {
        d[0] = (char) (0xc0 | (c >> 6));
        d[1] = (char) (0x80 | (c & 0x3f));
        return 2;
    }
    if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
    if (c < 0x10000) {
        d[0] = (char) (0xe0 | (c >> 12));
        d[1] = (char) (0x80 | ((c >> 6) & 0x3f));
        d[2] = (char) (0x80 | (c & 0x3f));
        return 3;
    }
    if (c > 0x10ffff) { d[0] = '?'; return 1; }
    d[0] = (char) (0xf0 | (c >> 18));
    d[1] = (char) (0x80 | ((c >> 12) & 0x3f));
    d[2] = (char) (0x80 | ((c >> 6) & 0x3f));
    d[3] = (char) (0x80 | (c & 0x3f));
    return 4;
}

/* Decode one code point from s (NUL-terminated); advances *s. */
static glui32 utf8_decode(const unsigned char **s)
{
    const unsigned char *p = *s;
    glui32 c = *p++;
    int n = 0;
    if (c >= 0xf0) { c &= 0x07; n = 3; }
    else if (c >= 0xe0) { c &= 0x0f; n = 2; }
    else if (c >= 0xc0) { c &= 0x1f; n = 1; }
    else if (c >= 0x80) { *s = p; return 0xfffd; }
    while (n-- > 0) {
        if ((*p & 0xc0) != 0x80) { *s = p; return 0xfffd; }
        c = (c << 6) | (*p++ & 0x3f);
    }
    *s = p;
    return c;
}

/* ---- Layout ---- */

/* What is left of a grid's current row from the cursor: 0 if the cursor is
   outside the grid. */
static glui32 grid_row_left(const window_t *w)
{
    return (w->curx >= 0 && w->curx < w->cols && w->cury >= 0 && w->cury < w->rows)
           ? (glui32) (w->cols - w->curx) : 0;
}

/* The code points a line request on w accepts: the game's maxlen, and in a
   grid no more than the rest of the cursor's row, so the echo cannot wrap.
   Recomputed when a grid is resized under a pending request. */
static glui32 line_limit_for(const window_t *w, glui32 maxlen)
{
    if (w->type == wintype_TextGrid) {
        glui32 left = grid_row_left(w);
        if (maxlen > left)
            return left;
    }
    return maxlen;
}

static void grid_resize(window_t *w, int cols, int rows)
{
    glui32 *ch;
    unsigned char *st;
    int r, c;
    if (cols < 0) cols = 0;
    if (rows < 0) rows = 0;
    if (cols == w->cols && rows == w->rows)
        return;
    ch = xalloc(sizeof(glui32) * (size_t) (cols * rows + 1));
    st = xalloc((size_t) (cols * rows + 1));
    for (r = 0; r < rows; r++)
        for (c = 0; c < cols; c++) {
            int keep = r < w->rows && c < w->cols;
            ch[r * cols + c] = keep ? w->gch[r * w->cols + c] : ' ';
            st[r * cols + c] = keep ? w->gst[r * w->cols + c] : style_Normal;
        }
    free(w->gch);
    free(w->gst);
    w->gch = ch;
    w->gst = st;
    w->cols = cols;
    w->rows = rows;
    w->gdirty = 1;
    /* A pending line now fits the new width: shrinking the grid must not
       let it run into the next row, and growing it may give room back. The
       page gets the new limit with the requests before the next wait. */
    if (w->line_req)
        w->line_limit = line_limit_for(w, w->line_maxlen);
}

/* The size a fixed split of `size` units takes for key window `key`. */
static int fixed_split_px(window_t *key, glui32 size, int vertical)
{
    double units = (double) size;
    if (!key)
        return 0;
    switch (key->type) {
    case wintype_TextGrid:
        return (int) ceil(vertical ? units * M_GCW + 2 * M_GPX : units * M_GCH + 2 * M_GPY);
    case wintype_TextBuffer:
        return (int) ceil(vertical ? units * M_BCW + 2 * M_BPX : units * M_BCH + 2 * M_BPY);
    case wintype_Graphics:
        return (int) size;
    default:
        return 0;
    }
}

static void rearrange(window_t *w, int left, int top, int width, int height)
{
    if (!w)
        return;
    if (width < 0) width = 0;
    if (height < 0) height = 0;
    w->left = left;
    w->top = top;
    w->width = width;
    w->height = height;

    if (w->type == wintype_Pair) {
        int min = w->vertical ? left : top;
        int max = min + (w->vertical ? width : height);
        int split;
        window_t *ch1, *ch2;
        if ((w->method & winmethod_DivisionMask) == winmethod_Proportional)
            split = (int) floor((double) (max - min) * (double) w->size / 100.0);
        else
            split = fixed_split_px(w->key, w->size, w->vertical);
        split = w->backward ? min + split : max - split;
        if (split < min) split = min;
        if (split > max) split = max;
        /* child2 (the key, normally) is above or left when backward. */
        ch1 = w->backward ? w->child2 : w->child1;
        ch2 = w->backward ? w->child1 : w->child2;
        if (w->vertical) {
            rearrange(ch1, left, top, split - left, height);
            rearrange(ch2, split, top, max - split, height);
        } else {
            rearrange(ch1, left, top, width, split - top);
            rearrange(ch2, left, split, width, max - split);
        }
    } else if (w->type == wintype_TextGrid) {
        int cols = M_GCW > 0 ? (int) floor((width - 2 * M_GPX) / M_GCW) : 0;
        int rows = M_GCH > 0 ? (int) floor((height - 2 * M_GPY) / M_GCH) : 0;
        grid_resize(w, cols, rows);
    }
    layout_dirty = 1;
}

static void rearrange_all(void)
{
    if (rootwin)
        rearrange(rootwin, 0, 0, (int) floor(M_W), (int) floor(M_H));
    layout_dirty = 1;
}

static void measure(void)
{
    js_metrics(met);
    if (M_GCW <= 0) M_GCW = 9;
    if (M_GCH <= 0) M_GCH = 18;
    if (M_BCW <= 0) M_BCW = 9;
    if (M_BCH <= 0) M_BCH = 24;
}

/* ---- Output to windows ---- */

static void pend_reserve(window_t *w, size_t extra)
{
    if (w->pendlen + extra + 1 <= w->pendcap)
        return;
    while (w->pendlen + extra + 1 > w->pendcap)
        w->pendcap = w->pendcap ? w->pendcap * 2 : 1024;
    w->pend = realloc(w->pend, w->pendcap);
    if (!w->pend)
        glkweb_fatal("Out of memory in the Glk library.");
}

static void flush_window_text(window_t *w)
{
    if (!w->pendlen && !w->pend_clear)
        return;
    pend_reserve(w, 0);
    w->pend[w->pendlen] = '\0';
    js_text(w->id, w->pend, w->pend_clear);
    w->pendlen = 0;
    w->pend_clear = 0;
    w->pend_style = -1;
}

static void buffer_put(window_t *w, glui32 ch)
{
    if (ch != '\n' && (ch < 0x20 || (ch >= 0x7f && ch < 0xa0)))
        return; /* control characters other than newline are not printed */
    pend_reserve(w, 6);
    if ((int) w->style != w->pend_style) {
        w->pend[w->pendlen++] = STYLE_MARK;
        w->pend[w->pendlen++] = (char) ('a' + w->style);
        w->pend_style = (int) w->style;
    }
    w->pendlen += (size_t) utf8_encode(ch, w->pend + w->pendlen);
    if (w->pendlen > 256 * 1024)
        flush_window_text(w);
}

static void grid_put(window_t *w, glui32 ch)
{
    if (ch == '\n') {
        w->curx = 0;
        w->cury++;
        return;
    }
    if (ch < 0x20 || (ch >= 0x7f && ch < 0xa0))
        return;
    if (w->curx >= w->cols) {
        w->curx = 0;
        w->cury++;
    }
    if (w->cury >= w->rows || w->cury < 0)
        return;
    w->gch[w->cury * w->cols + w->curx] = ch;
    w->gst[w->cury * w->cols + w->curx] = (unsigned char) w->style;
    w->curx++;
    w->gdirty = 1;
}

static void put_char(stream_t *s, glui32 ch);

static void window_put(window_t *w, glui32 ch)
{
    if (w->type == wintype_TextBuffer)
        buffer_put(w, ch);
    else if (w->type == wintype_TextGrid)
        grid_put(w, ch);
    if (w->echostr && w->echostr != w->str)
        put_char(w->echostr, ch);
}

static void window_clear(window_t *w)
{
    if (w->type == wintype_TextBuffer) {
        w->pendlen = 0;
        w->pend_clear = 1;
        w->pend_style = -1;
    } else if (w->type == wintype_TextGrid) {
        int i;
        for (i = 0; i < w->cols * w->rows; i++) {
            w->gch[i] = ' ';
            w->gst[i] = style_Normal;
        }
        w->curx = w->cury = 0;
        w->gdirty = 1;
    }
}

/* Hand everything pending to the page. */
static void flush_all(void)
{
    window_t *w;
    if (layout_dirty) {
        int n = 0, i = 0;
        int *rec;
        for (w = winlist; w; w = w->next)
            if (w->type != wintype_Pair)
                n++;
        rec = xalloc(sizeof(int) * (size_t) (n * 6 + 1));
        for (w = winlist; w; w = w->next) {
            if (w->type == wintype_Pair)
                continue;
            rec[i++] = w->id;
            rec[i++] = (int) w->type;
            rec[i++] = w->left;
            rec[i++] = w->top;
            rec[i++] = w->width;
            rec[i++] = w->height;
        }
        js_layout(rec, n);
        free(rec);
        layout_dirty = 0;
    }
    for (w = winlist; w; w = w->next) {
        if (w->type == wintype_TextBuffer)
            flush_window_text(w);
        else if (w->type == wintype_TextGrid && w->gdirty) {
            js_grid(w->id, w->cols, w->rows, w->gch, w->gst);
            w->gdirty = 0;
        }
    }
}

/* ---- Streams ---- */

static stream_t *stream_new(int type, int readable, int writable, glui32 rock, int unicode)
{
    stream_t *s = xalloc(sizeof(stream_t));
    s->type = type;
    s->rock = rock;
    s->readable = readable;
    s->writable = writable;
    s->unicode = unicode;
    LINK(strlist, s);
    if (reg_obj)
        s->disprock = (*reg_obj)(s, gidisp_Class_Stream);
    return s;
}

static int under_saves(const char *path)
{
    return strncmp(path, SAVE_DIR "/", sizeof(SAVE_DIR)) == 0;
}

static void flush_all(void);

/* Storage calls may print a notice in the story window (a failed write),
   so the page is brought up to date first: the notice then follows the
   game's own text, such as the echo of SAVE. */
static void load_file(const char *path)
{
    stream_t *s;
    /* While the game has the file open for writing, MEMFS holds its newest
       bytes, which are stored when the stream closes: storage must neither
       replace nor remove that copy. */
    for (s = strlist; s; s = s->next)
        if (s->type == STR_FILE && s->writable && s->path && strcmp(s->path, path) == 0)
            return;
    flush_all();
    js_load_file(path);
}

static void persist_file(const char *path)
{
    flush_all();
    js_persist_file(path);
}

static void stream_destroy(stream_t *s)
{
    window_t *w;
    /* Text held back for this stream is written while it still exists. */
    if (pending_hook)
        (*pending_hook)(s);
    if (s == curstr)
        curstr = NULL;
    for (w = winlist; w; w = w->next)
        if (w->echostr == s)
            w->echostr = NULL;
    if (s->type == STR_MEMORY) {
        if (s->registered && unreg_arr) {
            if (s->unicode)
                (*unreg_arr)(s->ubuf, s->buflen, "&+#!Iu", s->arrrock);
            else
                (*unreg_arr)(s->buf, s->buflen, "&+#!Cn", s->arrrock);
        }
        if (s->owned) {
            free(s->buf);
            free(s->ubuf);
        }
    } else if (s->type == STR_FILE) {
        if (s->fp)
            fclose(s->fp);
        if (s->written && under_saves(s->path))
            persist_file(s->path);
        free(s->path);
    }
    if (unreg_obj)
        (*unreg_obj)(s, gidisp_Class_Stream, s->disprock);
    UNLINK(strlist, s);
    free(s);
}

static void file_prepare(stream_t *s, int op)
{
    if (s->lastop && s->lastop != op)
        fseek(s->fp, 0, SEEK_CUR);
    s->lastop = op;
}

static void put_char(stream_t *s, glui32 ch)
{
    if (!s || !s->writable)
        return;
    s->writecount++;
    switch (s->type) {
    case STR_WINDOW:
        window_put(s->win, ch);
        break;
    case STR_MEMORY:
        if (s->pos < s->buflen) {
            if (s->unicode)
                s->ubuf[s->pos] = ch;
            else
                s->buf[s->pos] = (unsigned char) (ch > 0xff ? '?' : ch);
            s->pos++;
            if (s->pos > s->eof)
                s->eof = s->pos;
        }
        break;
    case STR_FILE:
        file_prepare(s, 'w');
        s->written = 1;
        if (!s->unicode) {
            putc(ch > 0xff ? '?' : (int) ch, s->fp);
        } else if (s->textmode) {
            char u[4];
            int n = utf8_encode(ch, u);
            fwrite(u, 1, (size_t) n, s->fp);
        } else {
            putc((int) ((ch >> 24) & 0xff), s->fp);
            putc((int) ((ch >> 16) & 0xff), s->fp);
            putc((int) ((ch >> 8) & 0xff), s->fp);
            putc((int) (ch & 0xff), s->fp);
        }
        break;
    }
}

/* Returns the next character, or -1 at the end. */
static glsi32 get_char(stream_t *s, int want_uni)
{
    glui32 ch;
    if (!s || !s->readable)
        return -1;
    switch (s->type) {
    case STR_MEMORY:
        if (s->pos >= s->eof)
            return -1;
        ch = s->unicode ? s->ubuf[s->pos] : s->buf[s->pos];
        s->pos++;
        break;
    case STR_FILE: {
        int c;
        file_prepare(s, 'r');
        c = getc(s->fp);
        if (c == EOF)
            return -1;
        ch = (glui32) c;
        if (s->unicode && s->textmode) {
            int n = 0, i;
            if (ch >= 0xf0) { ch &= 0x07; n = 3; }
            else if (ch >= 0xe0) { ch &= 0x0f; n = 2; }
            else if (ch >= 0xc0) { ch &= 0x1f; n = 1; }
            else if (ch >= 0x80) ch = 0xfffd;
            for (i = 0; i < n; i++) {
                c = getc(s->fp);
                if (c == EOF)
                    return -1;
                ch = (ch << 6) | ((glui32) c & 0x3f);
            }
        } else if (s->unicode) {
            int i;
            for (i = 0; i < 3; i++) {
                c = getc(s->fp);
                if (c == EOF)
                    return -1;
                ch = (ch << 8) | (glui32) c;
            }
        }
        break;
    }
    default:
        return -1;
    }
    s->readcount++;
    if (!want_uni && ch > 0xff)
        ch = '?';
    return (glsi32) ch;
}

static stream_t *open_memory(void *buf, glui32 buflen, glui32 fmode, glui32 rock, int uni)
{
    stream_t *s;
    if (fmode != filemode_Read && fmode != filemode_Write && fmode != filemode_ReadWrite)
        return NULL;
    s = stream_new(STR_MEMORY, fmode != filemode_Write, fmode != filemode_Read, rock, uni);
    if (buf && buflen) {
        if (uni)
            s->ubuf = buf;
        else
            s->buf = buf;
        s->buflen = buflen;
        s->eof = fmode == filemode_Write ? 0 : buflen;
        if (reg_arr) {
            s->arrrock = (*reg_arr)(buf, buflen, uni ? "&+#!Iu" : "&+#!Cn");
            s->registered = 1;
        }
    }
    return s;
}

static stream_t *open_file(frefid_t fref, glui32 fmode, glui32 rock, int uni)
{
    const char *mode;
    FILE *fp;
    stream_t *s;
    struct stat st;
    int exists;
    if (!fref)
        return NULL;
    if (under_saves(fref->path))
        load_file(fref->path);
    exists = stat(fref->path, &st) == 0;
    switch (fmode) {
    case filemode_Read:
        if (!exists)
            return NULL;
        mode = "rb";
        break;
    case filemode_Write:
        mode = "wb";
        break;
    case filemode_ReadWrite:
    case filemode_WriteAppend:
        mode = exists ? "r+b" : "w+b";
        break;
    default:
        return NULL;
    }
    fp = fopen(fref->path, mode);
    if (!fp)
        return NULL;
    if (fmode == filemode_WriteAppend)
        fseek(fp, 0, SEEK_END);
    s = stream_new(STR_FILE, fmode == filemode_Read || fmode == filemode_ReadWrite,
                   fmode != filemode_Read, rock, uni);
    s->fp = fp;
    s->path = xstrdup(fref->path);
    s->textmode = (fref->usage & fileusage_TextMode) != 0;
    /* A new or truncated file counts as written, so it is stored on close. */
    s->written = fmode == filemode_Write || !exists;
    return s;
}

strid_t glk_stream_open_memory(char *buf, glui32 buflen, glui32 fmode, glui32 rock)
{
    return open_memory(buf, buflen, fmode, rock, 0);
}

strid_t glk_stream_open_memory_uni(glui32 *buf, glui32 buflen, glui32 fmode, glui32 rock)
{
    return open_memory(buf, buflen, fmode, rock, 1);
}

strid_t glk_stream_open_file(frefid_t fref, glui32 fmode, glui32 rock)
{
    return open_file(fref, fmode, rock, 0);
}

strid_t glk_stream_open_file_uni(frefid_t fref, glui32 fmode, glui32 rock)
{
    return open_file(fref, fmode, rock, 1);
}

static stream_t *open_resource(glui32 filenum, glui32 rock, int uni)
{
    giblorb_map_t *map = giblorb_get_resource_map();
    giblorb_result_t res;
    stream_t *s;
    const unsigned char *data;
    glui32 len, i;
    int text;
    if (!map || giblorb_load_resource(map, giblorb_method_Memory, &res,
                                      giblorb_ID_Data, filenum))
        return NULL;
    data = res.data.ptr;
    len = res.length;
    text = res.chunktype == giblorb_make_id('T', 'E', 'X', 'T');
    s = stream_new(STR_MEMORY, 1, 0, rock, uni);
    s->owned = 1;
    if (!uni) {
        s->buf = xalloc(len + 1);
        memcpy(s->buf, data, len);
        s->buflen = s->eof = len;
    } else if (text) {
        /* UTF-8 text */
        unsigned char *tmp = xalloc(len + 1);
        const unsigned char *p = tmp;
        glui32 n = 0;
        memcpy(tmp, data, len);
        s->ubuf = xalloc(sizeof(glui32) * (len + 1));
        while (p < tmp + len)
            s->ubuf[n++] = utf8_decode(&p);
        free(tmp);
        s->buflen = s->eof = n;
    } else {
        /* binary: big-endian 32-bit characters */
        glui32 n = len / 4;
        s->ubuf = xalloc(sizeof(glui32) * (n + 1));
        for (i = 0; i < n; i++)
            s->ubuf[i] = ((glui32) data[4 * i] << 24) | ((glui32) data[4 * i + 1] << 16)
                       | ((glui32) data[4 * i + 2] << 8) | data[4 * i + 3];
        s->buflen = s->eof = n;
    }
    giblorb_unload_chunk(map, res.chunknum);
    return s;
}

strid_t glk_stream_open_resource(glui32 filenum, glui32 rock)
{
    return open_resource(filenum, rock, 0);
}

strid_t glk_stream_open_resource_uni(glui32 filenum, glui32 rock)
{
    return open_resource(filenum, rock, 1);
}

void glk_stream_close(strid_t str, stream_result_t *result)
{
    if (!str)
        return;
    if (str->type == STR_WINDOW) {
        fprintf(stderr, "[glk] stream_close: cannot close a window stream\n");
        return;
    }
    if (result) {
        result->readcount = str->readcount;
        result->writecount = str->writecount;
    }
    stream_destroy(str);
}

strid_t glk_stream_iterate(strid_t str, glui32 *rockptr)
{
    stream_t *s = str ? str->next : strlist;
    if (rockptr)
        *rockptr = s ? s->rock : 0;
    return s;
}

glui32 glk_stream_get_rock(strid_t str)
{
    return str ? str->rock : 0;
}

void glk_stream_set_position(strid_t str, glsi32 pos, glui32 seekmode)
{
    if (!str)
        return;
    if (str->type == STR_MEMORY) {
        glsi32 base = seekmode == seekmode_Current ? (glsi32) str->pos
                    : seekmode == seekmode_End ? (glsi32) str->eof : 0;
        glsi32 p = base + pos;
        if (p < 0) p = 0;
        if ((glui32) p > str->eof) p = (glsi32) str->eof;
        str->pos = (glui32) p;
    } else if (str->type == STR_FILE) {
        int whence = seekmode == seekmode_Current ? SEEK_CUR
                   : seekmode == seekmode_End ? SEEK_END : SEEK_SET;
        /* Unicode binary files: positions count 4-byte characters. */
        long unit = str->unicode && !str->textmode ? 4 : 1;
        fseek(str->fp, (long) pos * unit, whence);
        str->lastop = 0;
    }
}

glui32 glk_stream_get_position(strid_t str)
{
    if (!str)
        return 0;
    if (str->type == STR_MEMORY)
        return str->pos;
    if (str->type == STR_FILE) {
        long p = ftell(str->fp);
        if (p < 0) return 0;
        return (glui32) (str->unicode && !str->textmode ? p / 4 : p);
    }
    return 0;
}

void glk_stream_set_current(strid_t str)
{
    curstr = str;
}

strid_t glk_stream_get_current(void)
{
    return curstr;
}

void glk_put_char(unsigned char ch) { put_char(curstr, ch); }
void glk_put_char_stream(strid_t str, unsigned char ch) { put_char(str, ch); }
void glk_put_char_uni(glui32 ch) { put_char(curstr, ch); }
void glk_put_char_stream_uni(strid_t str, glui32 ch) { put_char(str, ch); }

void glk_put_string(char *s)
{
    glk_put_string_stream(curstr, s);
}

void glk_put_string_stream(strid_t str, char *s)
{
    if (!s) return;
    for (; *s; s++)
        put_char(str, (unsigned char) *s);
}

void glk_put_string_uni(glui32 *s)
{
    glk_put_string_stream_uni(curstr, s);
}

void glk_put_string_stream_uni(strid_t str, glui32 *s)
{
    if (!s) return;
    for (; *s; s++)
        put_char(str, *s);
}

void glk_put_buffer(char *buf, glui32 len)
{
    glk_put_buffer_stream(curstr, buf, len);
}

void glk_put_buffer_stream(strid_t str, char *buf, glui32 len)
{
    glui32 i;
    if (!buf) return;
    for (i = 0; i < len; i++)
        put_char(str, (unsigned char) buf[i]);
}

void glk_put_buffer_uni(glui32 *buf, glui32 len)
{
    glk_put_buffer_stream_uni(curstr, buf, len);
}

void glk_put_buffer_stream_uni(strid_t str, glui32 *buf, glui32 len)
{
    glui32 i;
    if (!buf) return;
    for (i = 0; i < len; i++)
        put_char(str, buf[i]);
}

static void set_style(stream_t *s, glui32 styl)
{
    if (!s || s->type != STR_WINDOW)
        return;
    if (styl >= style_NUMSTYLES)
        styl = style_Normal;
    s->win->style = styl;
    if (s->win->echostr && s->win->echostr != s)
        set_style(s->win->echostr, styl);
}

void glk_set_style(glui32 styl) { set_style(curstr, styl); }
void glk_set_style_stream(strid_t str, glui32 styl) { set_style(str, styl); }

glsi32 glk_get_char_stream(strid_t str) { return get_char(str, 0); }
glsi32 glk_get_char_stream_uni(strid_t str) { return get_char(str, 1); }

glui32 glk_get_buffer_stream(strid_t str, char *buf, glui32 len)
{
    glui32 n = 0;
    glsi32 c;
    if (!buf) return 0;
    if (str && str->type == STR_FILE && !str->unicode && str->readable) {
        size_t got;
        file_prepare(str, 'r');
        got = fread(buf, 1, len, str->fp);
        str->readcount += (glui32) got;
        return (glui32) got;
    }
    while (n < len && (c = get_char(str, 0)) >= 0)
        buf[n++] = (char) c;
    return n;
}

glui32 glk_get_buffer_stream_uni(strid_t str, glui32 *buf, glui32 len)
{
    glui32 n = 0;
    glsi32 c;
    if (!buf) return 0;
    while (n < len && (c = get_char(str, 1)) >= 0)
        buf[n++] = (glui32) c;
    return n;
}

glui32 glk_get_line_stream(strid_t str, char *buf, glui32 len)
{
    glui32 n = 0;
    glsi32 c;
    if (!buf || len == 0) return 0;
    while (n + 1 < len && (c = get_char(str, 0)) >= 0) {
        buf[n++] = (char) c;
        if (c == '\n')
            break;
    }
    buf[n] = '\0';
    return n;
}

glui32 glk_get_line_stream_uni(strid_t str, glui32 *buf, glui32 len)
{
    glui32 n = 0;
    glsi32 c;
    if (!buf || len == 0) return 0;
    while (n + 1 < len && (c = get_char(str, 1)) >= 0) {
        buf[n++] = (glui32) c;
        if (c == '\n')
            break;
    }
    buf[n] = 0;
    return n;
}

/* ---- Windows ---- */

static window_t *window_new(glui32 type, glui32 rock)
{
    window_t *w = xalloc(sizeof(window_t));
    w->type = type;
    w->rock = rock;
    w->id = next_win_id++;
    w->style = style_Normal;
    w->echo_line = 1;
    w->pend_style = -1;
    LINK(winlist, w);
    if (reg_obj)
        w->disprock = (*reg_obj)(w, gidisp_Class_Window);
    if (type != wintype_Pair) {
        w->str = stream_new(STR_WINDOW, 0, 1, 0, 1);
        w->str->win = w;
    }
    return w;
}

static void unregister_line(window_t *w)
{
    if (w->line_buf && unreg_arr)
        (*unreg_arr)(w->line_buf, w->line_maxlen, w->line_uni ? "&+#!Iu" : "&+#!Cn",
                     w->line_arrrock);
    w->line_buf = NULL;
    w->line_req = 0;
    free(w->line_initial);
    w->line_initial = NULL;
}

/* Destroy w and everything below it. */
static void window_destroy_tree(window_t *w)
{
    window_t *p;
    if (!w)
        return;
    if (w->type == wintype_Pair) {
        window_destroy_tree(w->child1);
        window_destroy_tree(w->child2);
    }
    for (p = w->parent; p; p = p->parent)
        if (p->key == w)
            p->key = NULL;
    if (w->line_req)
        unregister_line(w);
    if (w->str) {
        stream_t *s = w->str;
        w->str = NULL;
        stream_destroy(s);
    }
    if (unreg_obj)
        (*unreg_obj)(w, gidisp_Class_Window, w->disprock);
    UNLINK(winlist, w);
    free(w->pend);
    free(w->gch);
    free(w->gst);
    free(w);
}

static void set_method(window_t *pair, glui32 method, glui32 size)
{
    glui32 dir = method & winmethod_DirMask;
    pair->method = method;
    pair->size = size;
    pair->vertical = dir == winmethod_Left || dir == winmethod_Right;
    pair->backward = dir == winmethod_Left || dir == winmethod_Above;
}

winid_t glk_window_get_root(void)
{
    return rootwin;
}

winid_t glk_window_open(winid_t split, glui32 method, glui32 size,
                        glui32 wintype, glui32 rock)
{
    window_t *w, *pair, *oldparent;
    if (wintype != wintype_TextBuffer && wintype != wintype_TextGrid
        && wintype != wintype_Blank)
        return NULL; /* no graphics windows */
    if (!rootwin) {
        if (split)
            return NULL;
    } else {
        if (!split)
            return NULL;
        switch (method & winmethod_DivisionMask) {
        case winmethod_Fixed:
        case winmethod_Proportional:
            break;
        default:
            return NULL;
        }
    }
    w = window_new(wintype, rock);
    if (!split) {
        rootwin = w;
    } else {
        oldparent = split->parent;
        pair = window_new(wintype_Pair, 0);
        set_method(pair, method, size);
        pair->child1 = split;
        pair->child2 = w;
        pair->key = w;
        pair->parent = oldparent;
        split->parent = pair;
        w->parent = pair;
        if (!oldparent)
            rootwin = pair;
        else if (oldparent->child1 == split)
            oldparent->child1 = pair;
        else
            oldparent->child2 = pair;
    }
    rearrange_all();
    return w;
}

void glk_window_close(winid_t win, stream_result_t *result)
{
    window_t *pair, *sib, *grand;
    if (!win)
        return;
    if (result) {
        result->readcount = win->str ? win->str->readcount : 0;
        result->writecount = win->str ? win->str->writecount : 0;
    }
    if (win == rootwin) {
        window_destroy_tree(win);
        rootwin = NULL;
    } else {
        pair = win->parent;
        sib = pair->child1 == win ? pair->child2 : pair->child1;
        grand = pair->parent;
        if (!grand)
            rootwin = sib;
        else if (grand->child1 == pair)
            grand->child1 = sib;
        else
            grand->child2 = sib;
        sib->parent = grand;
        window_destroy_tree(win);
        pair->child1 = pair->child2 = NULL;
        window_destroy_tree(pair);
    }
    rearrange_all();
}

void glk_window_get_size(winid_t win, glui32 *widthptr, glui32 *heightptr)
{
    glui32 wd = 0, ht = 0;
    if (win) {
        if (win->type == wintype_TextGrid) {
            wd = (glui32) win->cols;
            ht = (glui32) win->rows;
        } else if (win->type == wintype_TextBuffer) {
            double cw = floor((win->width - 2 * M_BPX) / M_BCW);
            double ch = floor((win->height - 2 * M_BPY) / M_BCH);
            wd = cw > 0 ? (glui32) cw : 0;
            ht = ch > 0 ? (glui32) ch : 0;
        }
    }
    if (widthptr) *widthptr = wd;
    if (heightptr) *heightptr = ht;
}

/* As glkios/ipwindow.c does it: the split axis cannot change, and a change
   between Above and Below (or Left and Right) swaps child1 and child2 along
   with the direction, so the two children stay where they are on screen and
   only the side that gets the size moves. */
void glk_window_set_arrangement(winid_t win, glui32 method, glui32 size, winid_t keywin)
{
    window_t *w;
    glui32 dir = method & winmethod_DirMask;
    int vertical = dir == winmethod_Left || dir == winmethod_Right;
    int backward = dir == winmethod_Left || dir == winmethod_Above;
    if (!win || win->type != wintype_Pair)
        return;
    if (keywin) {
        if (keywin->type == wintype_Pair)
            return;
        for (w = keywin; w && w != win; w = w->parent)
            ;
        if (!w)
            return; /* not a descendant */
    } else {
        keywin = win->key;
    }
    if (vertical != win->vertical)
        return; /* a split stays horizontal or vertical */
    if (keywin && keywin->type == wintype_Blank
        && (method & winmethod_DivisionMask) == winmethod_Fixed)
        return; /* a blank window has no size in units */
    if (backward != win->backward) {
        window_t *t = win->child1;
        win->child1 = win->child2;
        win->child2 = t;
    }
    win->key = keywin;
    set_method(win, method, size);
    rearrange_all();
}

void glk_window_get_arrangement(winid_t win, glui32 *methodptr, glui32 *sizeptr,
                                winid_t *keywinptr)
{
    if (!win || win->type != wintype_Pair) {
        if (methodptr) *methodptr = 0;
        if (sizeptr) *sizeptr = 0;
        if (keywinptr) *keywinptr = NULL;
        return;
    }
    if (methodptr) *methodptr = win->method;
    if (sizeptr) *sizeptr = win->size;
    if (keywinptr) *keywinptr = win->key;
}

winid_t glk_window_iterate(winid_t win, glui32 *rockptr)
{
    window_t *w = win ? win->next : winlist;
    if (rockptr)
        *rockptr = w ? w->rock : 0;
    return w;
}

glui32 glk_window_get_rock(winid_t win) { return win ? win->rock : 0; }
glui32 glk_window_get_type(winid_t win) { return win ? win->type : 0; }
winid_t glk_window_get_parent(winid_t win) { return win ? win->parent : NULL; }

winid_t glk_window_get_sibling(winid_t win)
{
    if (!win || !win->parent)
        return NULL;
    return win->parent->child1 == win ? win->parent->child2 : win->parent->child1;
}

void glk_window_clear(winid_t win)
{
    if (win)
        window_clear(win);
}

void glk_window_move_cursor(winid_t win, glui32 xpos, glui32 ypos)
{
    if (!win || win->type != wintype_TextGrid)
        return;
    /* Huge values (negative as signed) put the cursor off the grid. */
    win->curx = xpos > 0x7fff ? 0x7fff : (int) xpos;
    win->cury = ypos > 0x7fff ? 0x7fff : (int) ypos;
}

strid_t glk_window_get_stream(winid_t win) { return win ? win->str : NULL; }

void glk_window_set_echo_stream(winid_t win, strid_t str)
{
    if (win)
        win->echostr = str;
}

strid_t glk_window_get_echo_stream(winid_t win) { return win ? win->echostr : NULL; }

void glk_set_window(winid_t win)
{
    curstr = win ? win->str : NULL;
}

/* ---- File references ---- */

static fileref_t *fileref_new(const char *path, glui32 usage, glui32 rock)
{
    fileref_t *f = xalloc(sizeof(fileref_t));
    f->path = xstrdup(path);
    f->usage = usage;
    f->rock = rock;
    LINK(freflist, f);
    if (reg_obj)
        f->disprock = (*reg_obj)(f, gidisp_Class_Fileref);
    return f;
}

static const char *usage_suffix(glui32 usage)
{
    switch (usage & fileusage_TypeMask) {
    case fileusage_SavedGame: return ".glksave";
    case fileusage_Transcript: return ".txt";
    case fileusage_InputRecord: return ".rec";
    default: return ".glkdata";
    }
}

/* The Glk spec's file name rules: up to the first '.', without characters
   that are special in file names, "null" if nothing is left. */
static void clean_name(const char *in, char *out, size_t cap)
{
    size_t n = 0;
    for (; *in && *in != '.' && n + 1 < cap; in++) {
        unsigned char c = (unsigned char) *in;
        if (c < 0x20 || strchr("/\\<>:|?*\"", c))
            continue;
        out[n++] = (char) c;
    }
    out[n] = '\0';
    if (!n)
        snprintf(out, cap, "null");
}

frefid_t glk_fileref_create_temp(glui32 usage, glui32 rock)
{
    static int counter = 0;
    char path[64];
    snprintf(path, sizeof path, "/tmp/glktemp%d%s", ++counter, usage_suffix(usage));
    return fileref_new(path, usage, rock);
}

frefid_t glk_fileref_create_by_name(glui32 usage, char *name, glui32 rock)
{
    char clean[128], path[192];
    clean_name(name ? name : "", clean, sizeof clean);
    snprintf(path, sizeof path, "%s/%s%s", SAVE_DIR, clean, usage_suffix(usage));
    return fileref_new(path, usage, rock);
}

/* No prompt: one fixed file per story and usage, like the Z-machine
   client's <story>.sav. */
frefid_t glk_fileref_create_by_prompt(glui32 usage, glui32 fmode, glui32 rock)
{
    char path[192];
    (void) fmode;
    snprintf(path, sizeof path, "%s/%s%s", SAVE_DIR, story_stem, usage_suffix(usage));
    return fileref_new(path, usage, rock);
}

frefid_t glk_fileref_create_from_fileref(glui32 usage, frefid_t fref, glui32 rock)
{
    if (!fref)
        return NULL;
    return fileref_new(fref->path, usage, rock);
}

void glk_fileref_destroy(frefid_t fref)
{
    if (!fref)
        return;
    if (unreg_obj)
        (*unreg_obj)(fref, gidisp_Class_Fileref, fref->disprock);
    UNLINK(freflist, fref);
    free(fref->path);
    free(fref);
}

frefid_t glk_fileref_iterate(frefid_t fref, glui32 *rockptr)
{
    fileref_t *f = fref ? fref->next : freflist;
    if (rockptr)
        *rockptr = f ? f->rock : 0;
    return f;
}

glui32 glk_fileref_get_rock(frefid_t fref) { return fref ? fref->rock : 0; }

void glk_fileref_delete_file(frefid_t fref)
{
    if (!fref)
        return;
    unlink(fref->path);
    if (under_saves(fref->path)) {
        flush_all(); /* a failure notice follows the game's text */
        js_delete_file(fref->path);
    }
}

glui32 glk_fileref_does_file_exist(frefid_t fref)
{
    struct stat st;
    if (!fref)
        return 0;
    if (under_saves(fref->path))
        load_file(fref->path);
    return stat(fref->path, &st) == 0 && S_ISREG(st.st_mode);
}

/* ---- Input and events ---- */

static window_t *window_by_id(int id)
{
    window_t *w;
    for (w = winlist; w; w = w->next)
        if (w->id == id)
            return w;
    return NULL;
}

static void echo_text(window_t *w, const glui32 *text, glui32 n)
{
    glui32 old = w->style, i;
    if (!w->line_echo || !w->str)
        return;
    /* In a grid the echo stays on the cursor's row, whatever happened to
       the grid or the cursor since the request was made. */
    if (w->type == wintype_TextGrid && n > grid_row_left(w))
        n = grid_row_left(w);
    w->style = style_Input;
    for (i = 0; i < n; i++)
        window_put(w, text[i]);
    window_put(w, '\n');
    w->style = old;
}

/* Complete w's line request with UTF-8 text: copy it to the game's buffer,
   echo it, and fill in the event. */
static void finish_line(window_t *w, const char *utf8, glui32 term, event_t *ev)
{
    const unsigned char *p = (const unsigned char *) utf8;
    glui32 *text = xalloc(sizeof(glui32) * (w->line_limit + 1));
    glui32 n = 0, i;
    while (*p && n < w->line_limit)
        text[n++] = utf8_decode(&p);
    for (i = 0; i < n; i++) {
        if (w->line_uni)
            ((glui32 *) w->line_buf)[i] = text[i];
        else
            ((unsigned char *) w->line_buf)[i] = (unsigned char) (text[i] > 0xff ? '?' : text[i]);
    }
    echo_text(w, text, n);
    free(text);
    unregister_line(w);
    if (ev) {
        ev->type = evtype_LineInput;
        ev->win = w;
        ev->val1 = n;
        ev->val2 = term;
    }
}

static void request_line(window_t *w, void *buf, glui32 maxlen, glui32 initlen, int uni)
{
    glui32 i, limit;
    char *init;
    size_t k = 0;
    if (!w || w->line_req || w->char_req)
        return;
    /* In a grid the line is typed at the cursor and cannot run past the
       end of the row. */
    limit = line_limit_for(w, maxlen);
    if (initlen > limit)
        initlen = limit;
    w->line_req = 1;
    w->line_uni = uni;
    w->line_buf = buf;
    w->line_maxlen = maxlen;
    w->line_limit = limit;
    w->line_echo = w->echo_line;
    init = xalloc((size_t) initlen * 4 + 1);
    for (i = 0; i < initlen; i++)
        k += (size_t) utf8_encode(uni ? ((glui32 *) buf)[i] : ((unsigned char *) buf)[i], init + k);
    init[k] = '\0';
    w->line_initial = init;
    w->line_initial_pending = 1;
    if (reg_arr)
        w->line_arrrock = (*reg_arr)(buf, maxlen, uni ? "&+#!Iu" : "&+#!Cn");
}

void glk_request_line_event(winid_t win, char *buf, glui32 maxlen, glui32 initlen)
{
    request_line(win, buf, maxlen, initlen, 0);
}

void glk_request_line_event_uni(winid_t win, glui32 *buf, glui32 maxlen, glui32 initlen)
{
    request_line(win, buf, maxlen, initlen, 1);
}

void glk_request_char_event(winid_t win)
{
    if (win && !win->line_req && !win->char_req) {
        win->char_req = 1;
        win->char_uni = 0;
    }
}

void glk_request_char_event_uni(winid_t win)
{
    if (win && !win->line_req && !win->char_req) {
        win->char_req = 1;
        win->char_uni = 1;
    }
}

void glk_cancel_line_event(winid_t win, event_t *ev)
{
    char *text;
    size_t cap;
    if (ev) {
        ev->type = evtype_None;
        ev->win = NULL;
        ev->val1 = ev->val2 = 0;
    }
    if (!win || !win->line_req)
        return;
    if (win->line_initial_pending) {
        /* Never shown to the player: the line is what it started with. */
        text = xstrdup(win->line_initial);
    } else {
        cap = (size_t) win->line_limit * 4 + 8;
        text = xalloc(cap);
        js_cancel_line(win->id, text, (int) cap);
    }
    finish_line(win, text, 0, ev);
    free(text);
}

void glk_cancel_char_event(winid_t win)
{
    if (win && win->char_req) {
        win->char_req = 0;
        js_cancel_char(win->id);
    }
}

/* Applies to line requests made after this call (Glk 0.7.4, 4.2). */
void glk_set_echo_line_event(winid_t win, glui32 val)
{
    if (win)
        win->echo_line = val != 0;
}

void glk_set_terminators_line_event(winid_t win, glui32 *keycodes, glui32 count)
{
    glui32 i;
    if (!win)
        return;
    win->nterms = 0;
    for (i = 0; keycodes && i < count && win->nterms < 16; i++) {
        glui32 k = keycodes[i];
        if (k == keycode_Escape || (k >= keycode_Func12 && k <= keycode_Func1)
            || k == keycode_Up || k == keycode_Down || k == keycode_PageUp
            || k == keycode_PageDown)
            win->terms[win->nterms++] = k;
    }
}

void glk_request_mouse_event(winid_t win) { (void) win; }
void glk_cancel_mouse_event(winid_t win) { (void) win; }

void glk_request_timer_events(glui32 millisecs)
{
    timer_interval = millisecs;
    timer_next = millisecs ? emscripten_get_now() + millisecs : 0;
}

/* If the timer is due, fill in a timer event and start the next interval
   from now: however many intervals were missed, they make one event. */
static int timer_due(event_t *ev)
{
    double now;
    if (!timer_interval)
        return 0;
    now = emscripten_get_now();
    if (now < timer_next)
        return 0;
    timer_next = now + timer_interval;
    ev->type = evtype_Timer;
    ev->win = NULL;
    ev->val1 = ev->val2 = 0;
    return 1;
}

static void arrange_event(event_t *ev)
{
    measure();
    rearrange_all();
    ev->type = evtype_Arrange;
    ev->win = NULL;
    ev->val1 = ev->val2 = 0;
}

void glk_select(event_t *event)
{
    event_t dummy;
    event_t *ev = event ? event : &dummy;
    static char *text = NULL;
    static size_t textcap = 0;

    for (;;) {
        window_t *w;
        int e[4];
        int timeout = -1;
        size_t need = 1024;

        /* A due timer is returned at once only if the last select did not
           already return one without waiting: a game whose timer handler
           takes longer than the interval would otherwise never let the
           page paint, resize or deliver input. Otherwise it waits below
           with a zero timeout, which is a browser macrotask. */
        if (!timer_without_wait && timer_due(ev)) {
            timer_without_wait = 1;
            return;
        }
        flush_all();

        js_inputs_begin();
        for (w = winlist; w; w = w->next) {
            if (w->line_req) {
                js_input(w->id, 1, w->line_initial_pending ? w->line_initial : NULL,
                         (int) w->line_limit, w->terms, w->nterms);
                w->line_initial_pending = 0;
                if ((size_t) w->line_limit * 4 + 8 > need)
                    need = (size_t) w->line_limit * 4 + 8;
            } else if (w->char_req) {
                js_input(w->id, 2, NULL, 0, w->terms, 0);
            }
        }
        if (need > textcap) {
            free(text);
            text = xalloc(need);
            textcap = need;
        }
        if (timer_interval) {
            double left = timer_next - emscripten_get_now();
            timeout = left <= 0 ? 0 : (int) ceil(left);
        }
        js_wait(timeout, e, text, (int) textcap);
        timer_without_wait = 0;

        switch (e[0]) {
        case evtype_Timer:
        case evtype_None:
            break; /* loop: timer_due() decides */
        case evtype_Arrange:
            arrange_event(ev);
            return;
        case evtype_LineInput:
            w = window_by_id(e[1]);
            if (w && w->line_req) {
                finish_line(w, text, (glui32) e[3], ev);
                return;
            }
            break;
        case evtype_CharInput:
            w = window_by_id(e[1]);
            if (w && w->char_req) {
                glui32 key = (glui32) e[2];
                if (!w->char_uni && key > 0xff && key < keycode_Func12)
                    key = '?';
                w->char_req = 0;
                ev->type = evtype_CharInput;
                ev->win = w;
                ev->val1 = key;
                ev->val2 = 0;
                return;
            }
            break;
        default:
            break;
        }
    }
}

void glk_select_poll(event_t *event)
{
    event_t dummy;
    event_t *ev = event ? event : &dummy;
    ev->type = evtype_None;
    ev->win = NULL;
    ev->val1 = ev->val2 = 0;
    if (timer_due(ev))
        return;
    if (js_poll_arrange())
        arrange_event(ev);
}

/* ---- Gestalt, styles, misc ---- */

/* A character the page can take as typed text: printable Latin-1 or a
   Unicode scalar value above it (no surrogates, nothing past U+10FFFF, no
   C1 controls). */
static int printable_input(glui32 val)
{
    if (val >= 32 && val < 127)
        return 1;
    return val >= 160 && val <= 0x10ffff && !(val >= 0xd800 && val < 0xe000);
}

glui32 glk_gestalt(glui32 sel, glui32 val)
{
    return glk_gestalt_ext(sel, val, NULL, 0);
}

glui32 glk_gestalt_ext(glui32 sel, glui32 val, glui32 *arr, glui32 arrlen)
{
    switch (sel) {
    case gestalt_Version:
        return 0x00070400;
    case gestalt_LineInput:
        return printable_input(val);
    case gestalt_CharInput:
        /* The keys glk.js's keyCode() delivers. */
        if (printable_input(val))
            return 1;
        switch (val) {
        case keycode_Left: case keycode_Right: case keycode_Up: case keycode_Down:
        case keycode_Return: case keycode_Delete: case keycode_Escape: case keycode_Tab:
        case keycode_PageUp: case keycode_PageDown: case keycode_Home: case keycode_End:
            return 1;
        default:
            return val >= keycode_Func12 && val <= keycode_Func1;
        }
    case gestalt_CharOutput:
        if ((val >= 32 && val < 127) || (val >= 160 && val <= 0x10ffff) || val == '\n') {
            if (arr && arrlen > 0) arr[0] = 1;
            return gestalt_CharOutput_ExactPrint;
        }
        if (arr && arrlen > 0) arr[0] = 0;
        return gestalt_CharOutput_CannotPrint;
    case gestalt_Timer:
    case gestalt_Unicode:
    case gestalt_LineInputEcho:
    case gestalt_LineTerminators:
    case gestalt_DateTime:
    case gestalt_ResourceStream:
        return 1;
    case gestalt_LineTerminatorKey:
        return val == keycode_Escape || (val >= keycode_Func12 && val <= keycode_Func1)
            || val == keycode_Up || val == keycode_Down || val == keycode_PageUp
            || val == keycode_PageDown;
    default:
        /* Mouse, graphics, images, sound, hyperlinks, normalisation. */
        return 0;
    }
}

unsigned char glk_char_to_lower(unsigned char ch)
{
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 0xc0 && ch <= 0xde && ch != 0xd7))
        return (unsigned char) (ch + 0x20);
    return ch;
}

unsigned char glk_char_to_upper(unsigned char ch)
{
    if ((ch >= 'a' && ch <= 'z') || (ch >= 0xe0 && ch <= 0xfe && ch != 0xf7))
        return (unsigned char) (ch - 0x20);
    return ch;
}

void glk_stylehint_set(glui32 wintype, glui32 styl, glui32 hint, glsi32 val)
{
    (void) wintype; (void) styl; (void) hint; (void) val;
}

void glk_stylehint_clear(glui32 wintype, glui32 styl, glui32 hint)
{
    (void) wintype; (void) styl; (void) hint;
}

/* How the CSS classes in glulx.html look: styles in one group look alike. */
static int style_look(glui32 s, glui32 wintype)
{
    /* Buffer: Subheader and Input are both plain bold (.gs-4, .gs-8). */
    static const int buffer[style_NUMSTYLES] = { 0, 1, 2, 3, 4, 5, 6, 7, 4, 0, 0 };
    static const int grid[style_NUMSTYLES] = { 0, 1, 0, 3, 3, 3, 1, 0, 3, 0, 0 };
    if (s >= style_NUMSTYLES)
        s = 0;
    return wintype == wintype_TextGrid ? grid[s] : buffer[s];
}

glui32 glk_style_distinguish(winid_t win, glui32 styl1, glui32 styl2)
{
    if (!win)
        return 0;
    return style_look(styl1, win->type) != style_look(styl2, win->type);
}

glui32 glk_style_measure(winid_t win, glui32 styl, glui32 hint, glui32 *result)
{
    (void) win; (void) styl; (void) hint; (void) result;
    return 0;
}

/* A page cannot be interrupted in a way the game could clean up after, so
   the handler is never called. */
void glk_set_interrupt_handler(void (*func)(void))
{
    (void) func;
}

void glk_tick(void)
{
}

/* ---- Not supported: images, sound, hyperlinks (gestalt says 0) ---- */

glui32 glk_image_draw(winid_t win, glui32 image, glsi32 val1, glsi32 val2)
{
    (void) win; (void) image; (void) val1; (void) val2;
    return 0;
}

glui32 glk_image_draw_scaled(winid_t win, glui32 image, glsi32 val1, glsi32 val2,
                             glui32 width, glui32 height)
{
    (void) win; (void) image; (void) val1; (void) val2; (void) width; (void) height;
    return 0;
}

glui32 glk_image_get_info(glui32 image, glui32 *width, glui32 *height)
{
    (void) image;
    if (width) *width = 0;
    if (height) *height = 0;
    return 0;
}

void glk_window_flow_break(winid_t win) { (void) win; }

void glk_window_erase_rect(winid_t win, glsi32 left, glsi32 top, glui32 width, glui32 height)
{
    (void) win; (void) left; (void) top; (void) width; (void) height;
}

void glk_window_fill_rect(winid_t win, glui32 color, glsi32 left, glsi32 top,
                          glui32 width, glui32 height)
{
    (void) win; (void) color; (void) left; (void) top; (void) width; (void) height;
}

void glk_window_set_background_color(winid_t win, glui32 color)
{
    (void) win; (void) color;
}

schanid_t glk_schannel_create(glui32 rock) { (void) rock; return NULL; }
void glk_schannel_destroy(schanid_t chan) { (void) chan; }

schanid_t glk_schannel_iterate(schanid_t chan, glui32 *rockptr)
{
    (void) chan;
    if (rockptr) *rockptr = 0;
    return NULL;
}

glui32 glk_schannel_get_rock(schanid_t chan) { (void) chan; return 0; }
glui32 glk_schannel_play(schanid_t chan, glui32 snd) { (void) chan; (void) snd; return 0; }

glui32 glk_schannel_play_ext(schanid_t chan, glui32 snd, glui32 repeats, glui32 notify)
{
    (void) chan; (void) snd; (void) repeats; (void) notify;
    return 0;
}

void glk_schannel_stop(schanid_t chan) { (void) chan; }
void glk_schannel_set_volume(schanid_t chan, glui32 vol) { (void) chan; (void) vol; }
void glk_sound_load_hint(glui32 snd, glui32 flag) { (void) snd; (void) flag; }

void glk_set_hyperlink(glui32 linkval) { (void) linkval; }
void glk_set_hyperlink_stream(strid_t str, glui32 linkval) { (void) str; (void) linkval; }
void glk_request_hyperlink_event(winid_t win) { (void) win; }
void glk_cancel_hyperlink_event(winid_t win) { (void) win; }

/* ---- Blorb ---- */

static giblorb_map_t *blorbmap = NULL;

giblorb_err_t giblorb_set_resource_map(strid_t file)
{
    giblorb_err_t err;
    if (blorbmap) {
        giblorb_destroy_map(blorbmap);
        blorbmap = NULL;
    }
    err = giblorb_create_map(file, &blorbmap);
    if (err)
        blorbmap = NULL;
    return err;
}

giblorb_map_t *giblorb_get_resource_map(void)
{
    return blorbmap;
}

/* ---- Dispatch registries ---- */

void gidispatch_set_object_registry(
    gidispatch_rock_t (*regi)(void *obj, glui32 objclass),
    void (*unregi)(void *obj, glui32 objclass, gidispatch_rock_t objrock))
{
    window_t *w;
    stream_t *s;
    fileref_t *f;
    reg_obj = regi;
    unreg_obj = unregi;
    if (!reg_obj)
        return;
    /* Objects made before the registry was set (the story's own blorb
       stream) are registered now. */
    for (w = winlist; w; w = w->next)
        w->disprock = (*reg_obj)(w, gidisp_Class_Window);
    for (s = strlist; s; s = s->next)
        s->disprock = (*reg_obj)(s, gidisp_Class_Stream);
    for (f = freflist; f; f = f->next)
        f->disprock = (*reg_obj)(f, gidisp_Class_Fileref);
}

gidispatch_rock_t gidispatch_get_objrock(void *obj, glui32 objclass)
{
    gidispatch_rock_t none;
    none.ptr = NULL;
    switch (objclass) {
    case gidisp_Class_Window: return ((window_t *) obj)->disprock;
    case gidisp_Class_Stream: return ((stream_t *) obj)->disprock;
    case gidisp_Class_Fileref: return ((fileref_t *) obj)->disprock;
    default: return none;
    }
}

void gidispatch_set_retained_registry(
    gidispatch_rock_t (*regi)(void *array, glui32 len, char *typecode),
    void (*unregi)(void *array, glui32 len, char *typecode, gidispatch_rock_t objrock))
{
    reg_arr = regi;
    unreg_arr = unregi;
}

/* ---- Startup and exit (glk_web.h) ---- */

void glkweb_init(const char *story_path)
{
    const char *base = strrchr(story_path, '/');
    char save_name[96];
    base = base ? base + 1 : story_path;
    clean_name(base, story_stem, sizeof story_stem);
    snprintf(save_name, sizeof save_name, "%s%s", story_stem,
             usage_suffix(fileusage_SavedGame));
    mkdir(SAVE_DIR, 0777);
    mkdir("/tmp", 0777);
    js_set_story(story_stem, save_name);
    measure();
}

void glkweb_file_will_open(const char *path)
{
    if (path && under_saves(path))
        load_file(path);
}

void glkweb_file_did_write(const char *path)
{
    if (path && under_saves(path))
        persist_file(path);
}

void glkweb_finish(void)
{
    if (pending_hook)
        (*pending_hook)(NULL);
    flush_all();
    js_exit();
}

void glk_exit(void)
{
    glkweb_finish();
    exit(0);
}

void glkweb_fatal(const char *msg)
{
    static int in_fatal = 0;
    window_t *w;
    if (!in_fatal) {
        in_fatal = 1;
        for (w = winlist; w; w = w->next)
            if (w->type == wintype_TextBuffer)
                break;
        if (!w)
            w = rootwin ? NULL : glk_window_open(NULL, 0, 0, wintype_TextBuffer, 0);
        if (w) {
            const char *p;
            w->style = style_Alert;
            for (p = "\n*** Fatal error: "; *p; p++) window_put(w, (unsigned char) *p);
            for (p = msg; *p; p++) window_put(w, (unsigned char) *p);
            for (p = " ***\n"; *p; p++) window_put(w, (unsigned char) *p);
        }
        fprintf(stderr, "[glk] fatal: %s\n", msg);
        glkweb_finish();
    }
    exit(1);
}
