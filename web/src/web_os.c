/*
 * web/src/web_os.c
 *
 * Browser OS layer for the Frotz Z-machine core compiled to WebAssembly.
 *
 * The repo's frotz/dumb/ interface predates the iOS changes to the core
 * (16-bit zchar via USE_UTF8, FROTZ_IOS-only globals, a different
 * os_display_char signature) and no longer compiles against it, so this file
 * implements the os_* interface directly, modelled on frotz/ios/ui_*.c:
 *
 *   - window 0 is a reflowing text stream (like the iOS text view): text is
 *     batched as UTF-8 and handed to JavaScript, and os_new_line(wrapping)
 *     turns soft wraps into spaces so the browser does the wrapping;
 *   - window 1 (status line / upper window) is a character grid that is sent
 *     to JavaScript whenever the interpreter waits for input;
 *   - os_read_line / os_read_key block the interpreter. They are implemented
 *     with EM_ASYNC_JS, so under -sASYNCIFY the C stack is unwound, the
 *     browser event loop runs, and the stack is rewound when the player's
 *     line (or a timeout) resolves the Promise.
 *
 * Saves go to /saves, which is plain MEMFS. Each file is persisted on its
 * own (web/saves.js): after a successful SAVE (or auxiliary save),
 * js_persist_save() writes that one file to IndexedDB, and before a RESTORE
 * (or auxiliary restore), js_load_save() brings that one file in from
 * IndexedDB, by revision (see saves.js). Both are
 * awaited, and neither can hang the game: they give up after a timeout.
 */

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "iosfrotz.h"   /* web/shim/iosfrotz.h: frotz.h plus the iOS globals */

/* ---- Globals the FROTZ_IOS core expects the platform layer to define ---- */

f_setup_t f_setup;
int do_autosave = 0, autosave_done = 0, refresh_savedir = 0;
char SAVE_PATH[MAX_FILE_NAME + 1] = "/saves";
char AUTOSAVE_FILE[MAX_FILE_NAME + 1] = "/saves/autosave.sav";
int currTextStyle = 0;

extern char save_name[], auxilary_name[], script_name[], command_name[];
extern void flush_buffer(void);

/* ---- JavaScript bridge ---- */

/* attr: style | fg << 8 | bg << 16, as for upper-window cells below. */
EM_JS(void, js_output, (const char *utf8, int attr), {
    Module.webFrotz.output(UTF8ToString(utf8), attr);
});

/* Erase the lower window to colour bg. */
EM_JS(void, js_clear, (int bg), {
    Module.webFrotz.clear(bg);
});

EM_JS(void, js_fatal, (const char *utf8), {
    Module.webFrotz.fatal(UTF8ToString(utf8));
});

/* Reads a line. `initial` (UTF-8) is the text the line starts with: the
   game's initial text on a new read, or the partial line on a read continued
   after a timeout; the input field is set to it for editing. Resolves to the
   UTF-8 byte length n of the whole line written into buf, as n if the player
   pressed Enter, or as -(n + 1) if the read timed out (buf then holds the
   partially typed line). */
EM_ASYNC_JS(int, js_read_line, (char *buf, int maxbytes, int timeout_ms,
                                const char *initial, int continued), {
    const r = await Module.webFrotz.readLine(timeout_ms, UTF8ToString(initial),
                                             continued !== 0);
    const n = stringToUTF8(r.line, buf, maxbytes);
    return r.timedOut ? -(n + 1) : n;
});

/* Screen size in characters that fits the page: (rows << 8) | cols. */
EM_JS(int, js_screen_size, (void), {
    return Module.webFrotz.screenSize();
});

/* Non-zero (a new packed size) if the page was resized since last asked. */
EM_JS(int, js_size_changed, (void), {
    return Module.webFrotz.sizeChanged();
});

/* Write one save file (a MEMFS path) to IndexedDB. If that conflicts with
   another tab's save, fails or times out, the page reports it in the
   transcript; the save itself stays in MEMFS for this session. */
EM_ASYNC_JS(void, js_persist_save, (const char *path), {
    await Module.webFrotz.persistSave(UTF8ToString(path));
});

/* Before a restore: bring that file in from IndexedDB (web/saves.js decides
   when). A failure leaves MEMFS as it is. */
EM_ASYNC_JS(void, js_load_save, (const char *path), {
    await Module.webFrotz.loadSave(UTF8ToString(path));
});

/* The <story>.sav name the core uses, for the page's Import. */
EM_JS(void, js_set_save_name, (const char *name), {
    Module.webFrotz.setSaveName(UTF8ToString(name));
});

/* Resolves to a Unicode code point / ZC_* key, or 0 (ZC_TIME_OUT). */
EM_ASYNC_JS(int, js_read_key, (int timeout_ms), {
    return await Module.webFrotz.readKey(timeout_ms);
});

/* ---- Output: main window stream ---- */

#define OUT_CAP 8192
static char out_buf[OUT_CAP + 8];
static int out_len = 0;
static int cur_style = 0;
static int cur_font = TEXT_FONT;
static int cur_fg = DEFAULT_COLOUR, cur_bg = DEFAULT_COLOUR;

/* The style in effect: font 4 (fixed pitch) counts as the fixed style. */
static int effective_style(void)
{
    return cur_style | (cur_font == FIXED_WIDTH_FONT ? FIXED_WIDTH_STYLE : 0);
}

/* The bytes out_buf[ds_start, ds_end) are what the last os_display_string
   call wrote to the main window, if ds_start >= 0. Any flush invalidates
   it. os_read_line uses it to find the core's redraw of a partial line
   (screen_write_input -> os_display_string) exactly, instead of guessing
   from the tail of the buffer. */
static int ds_start = -1, ds_end = -1;

static unsigned int cur_attr(void)
{
    return (unsigned int) (effective_style() & 0xff) | ((unsigned int) cur_fg << 8)
        | ((unsigned int) cur_bg << 16);
}

static void flush_output(void)
{
    if (out_len == 0)
        return;
    out_buf[out_len] = '\0';
    js_output(out_buf, (int) cur_attr());
    out_len = 0;
    ds_start = ds_end = -1;
}

/* Encode one 16-bit character as UTF-8 into dst (room for 3 bytes). */
static int utf8_encode(unsigned int c, char *dst)
{
    if (c < 0x80) {
        dst[0] = (char) c;
        return 1;
    } else if (c < 0x800) {
        dst[0] = (char) (0xc0 | (c >> 6));
        dst[1] = (char) (0x80 | (c & 0x3f));
        return 2;
    }
    dst[0] = (char) (0xe0 | (c >> 12));
    dst[1] = (char) (0x80 | ((c >> 6) & 0x3f));
    dst[2] = (char) (0x80 | (c & 0x3f));
    return 3;
}

/* Text is also flushed whenever the buffer fills. */
static void out_utf8(unsigned int c)
{
    if (out_len >= OUT_CAP)
        flush_output();
    out_len += utf8_encode(c, out_buf + out_len);
}

/* ---- Output: upper window grid ----
 *
 * Window 1 (and the V3 status line, window 7) is a fixed-pitch grid of
 * screen rows x columns in absolute screen coordinates, which is what the
 * core passes to os_set_cursor / os_erase_area / os_scroll_area. Each cell
 * holds a character and an attribute word:
 *
 *     bits 0-7  text style (REVERSE / BOLDFACE / EMPHASIS / FIXED)
 *     bits 8-15 foreground colour (Z-machine colour number, 1 = default)
 *     bits 16-23 background colour
 *
 * The grid is handed to JavaScript (one call, pointers into the heap)
 * whenever the interpreter waits for input.
 */

static unsigned short grid_ch[MAX_ROWS][MAX_COLS];
static unsigned int grid_attr[MAX_ROWS][MAX_COLS];
static int grid_height = 0;     /* rows in the upper window (incl. V3 status) */
static int cur_row = 0, cur_col = 0;
static int grid_dirty = 1;

static unsigned int blank_attr(void)
{
    /* Erasing fills with the current background colour (spec 8.7.3.3). */
    return ((unsigned int) DEFAULT_COLOUR << 8) | ((unsigned int) cur_bg << 16);
}

EM_JS(void, js_grid, (const unsigned short *ch, const unsigned int *attr,
                      int rows, int cols, int stride), {
    Module.webFrotz.grid(HEAPU16.subarray(ch >> 1, (ch >> 1) + rows * stride),
                         HEAPU32.subarray(attr >> 2, (attr >> 2) + rows * stride),
                         rows, cols, stride);
});

static void grid_put(unsigned int c)
{
    if (cur_row >= 0 && cur_row < MAX_ROWS && cur_col >= 0 && cur_col < MAX_COLS) {
        grid_ch[cur_row][cur_col] = (unsigned short) c;
        grid_attr[cur_row][cur_col] = cur_attr();
        grid_dirty = 1;
    }
    cur_col++;
}

static void grid_clear(int top, int left, int bottom, int right)
{
    int r, c;
    unsigned int a = blank_attr();
    if (top < 1) top = 1;
    if (left < 1) left = 1;
    if (bottom > MAX_ROWS) bottom = MAX_ROWS;
    if (right > MAX_COLS) right = MAX_COLS;
    for (r = top - 1; r <= bottom - 1; r++)
        for (c = left - 1; c <= right - 1; c++) {
            grid_ch[r][c] = ' ';
            grid_attr[r][c] = a;
        }
    grid_dirty = 1;
}

static void flush_status(void)
{
    int rows = grid_height < h_screen_rows ? grid_height : h_screen_rows;
    if (!grid_dirty)
        return;
    if (rows > MAX_ROWS)
        rows = MAX_ROWS;
    js_grid(&grid_ch[0][0], &grid_attr[0][0], rows,
            h_screen_cols < MAX_COLS ? h_screen_cols : MAX_COLS, MAX_COLS);
    grid_dirty = 0;
}

static void display_one(unsigned int c)
{
    if (cwin == 0)
        out_utf8(c);
    else
        grid_put(c);
}

void os_display_char(unsigned int c)
{
    if (c >= ZC_LATIN1_MIN || (c >= ZC_ASCII_MIN && c <= ZC_ASCII_MAX)) {
        display_one(c);
    } else if (c == ZC_BACKSPACE) {
        os_backspace();
    } else if (c == ZC_INDENT) {
        display_one(' '); display_one(' '); display_one(' ');
    } else if (c == ZC_GAP) {
        display_one(' '); display_one(' ');
    }
}

void os_display_string(const zchar *s)
{
    zchar c;
    int len = 0, plain = 1;
    const zchar *q;
    if (cwin == 0) {
        /* Keep a plain string (no style codes, so no flush inside) in one
           piece in out_buf: if it might not fit, flush first. Input lines
           are at most INPUT_BUFFER_SIZE characters, far below OUT_CAP / 3,
           so a redrawn partial line never straddles a flush. */
        for (q = s; *q != 0; q++, len++)
            if (*q == ZC_NEW_FONT || *q == ZC_NEW_STYLE)
                plain = 0;
        if (plain && 3 * len <= OUT_CAP && out_len + 3 * len > OUT_CAP)
            flush_output();
        ds_start = -1;
    }
    if (cwin == 0 && plain)
        ds_start = out_len;
    while ((c = *s++) != 0) {
        if (c == ZC_NEW_FONT || c == ZC_NEW_STYLE) {
            int arg = (unsigned char) *s++;
            if (c == ZC_NEW_FONT)
                os_set_font(arg);
            else
                os_set_text_style(arg);
        } else {
            os_display_char(c);
        }
    }
    if (cwin == 0 && plain && ds_start >= 0)
        ds_end = out_len;
}

void os_backspace(void)
{
    if (cwin == 0) {
        /* Drop one whole UTF-8 character. Text already handed to the page
           (flushed at a read, a style change or a full buffer) stays. */
        while (out_len > 0 && (out_buf[out_len - 1] & 0xc0) == 0x80)
            out_len--;
        if (out_len > 0)
            out_len--;
    } else if (cur_col > 0) {
        cur_col--;
        grid_put(' ');
        cur_col--;
    }
}

bool os_check_unicode(unsigned int c) { (void) c; return TRUE; }
/* Must match what os_display_char emits. */
int os_char_width(zchar c)
{
    if (c == ZC_INDENT)
        return 3;
    if (c == ZC_GAP)
        return 2;
    return 1;
}

int os_string_width(const zchar *s)
{
    int width = 0;
    zchar c;
    while ((c = *s++) != 0) {
        if (c == ZC_NEW_STYLE || c == ZC_NEW_FONT)
            s++;
        else
            width += os_char_width(c);
    }
    return width;
}

/* A mirror of the core's input_redraw (screen.c): screen_new_line sets it
   for every new line in the input window (it then calls os_new_line), and
   console_read_input clears it at the start of every read, after using it
   to decide whether to redraw a continued read's partial line. So it is
   set here on every lower-window new line and cleared only at the entry
   to os_read_line, where the shim consumes it, never on a timeout. A new
   line printed during os_read_line itself (flush_buffer wrapping a pending
   word) sets it again, exactly as it does in the core. */
static int redraw_pending = 0;
static int input_win = 0;   /* cwin at the last read, the core's input_window */

void os_new_line(bool wrapping)
{
    if (cwin != 0)
        return;          /* upper-window line moves arrive via os_set_cursor */
    if (cwin == input_win)
        redraw_pending = 1;
    out_utf8(wrapping ? ' ' : '\n');
}

void os_set_cursor(int row, int col)
{
    cur_row = row - 1;
    cur_col = col - 1;
}

void os_split_win(int height)
{
    if (height < 0) height = 0;
    if (height > MAX_ROWS) height = MAX_ROWS;
    grid_height = height;
    grid_dirty = 1;
}

void os_erase_area(int top, int left, int bottom, int right, int windowNum)
{
    /* windowNum is 0 for erase_window(0) / erase_screen, the window number
       for erase_window(n), and -1 for erase_line. Only a real erase of the
       lower window clears the transcript. */
    if (windowNum == 0) {
        flush_output();
        js_clear(cur_bg);
    }
    grid_clear(top, left, bottom, right);
}

static void grid_copy_row(int dst, int src, int left, int right)
{
    int c;
    for (c = left - 1; c <= right - 1; c++) {
        grid_ch[dst][c] = grid_ch[src][c];
        grid_attr[dst][c] = grid_attr[src][c];
    }
}

void os_scroll_area(int top, int left, int bottom, int right, int units)
{
    /* The lower window scrolls in the browser, so only the part of the
       rectangle inside the upper-window grid is scrolled here (rare: a game
       printing past the last row of a window with scrolling on, or a V6
       window). units > 0 moves the rows up, units < 0 moves them down;
       the rows left behind are cleared. Coordinates are 1-based and
       inclusive. */
    int height, n, r;
    if (top < 1) top = 1;
    if (left < 1) left = 1;
    if (bottom > grid_height) bottom = grid_height;
    if (bottom > MAX_ROWS) bottom = MAX_ROWS;
    if (right > h_screen_cols) right = h_screen_cols;
    if (right > MAX_COLS) right = MAX_COLS;
    if (top > bottom || left > right || units == 0)
        return;
    height = bottom - top + 1;
    n = units > 0 ? units : -units;
    if (n >= height) {
        grid_clear(top, left, bottom, right);
        return;
    }
    if (units > 0) {
        for (r = top - 1; r <= bottom - 1 - n; r++)
            grid_copy_row(r, r + n, left, right);
        grid_clear(bottom - n + 1, left, bottom, right);
    } else {
        for (r = bottom - 1; r >= top - 1 + n; r--)
            grid_copy_row(r, r - n, left, right);
        grid_clear(top, left, top + n - 1, right);
    }
}

void os_set_text_style(int new_style)
{
    if (new_style != cur_style)
        flush_output();
    cur_style = new_style;
    currTextStyle = new_style;
}

void os_set_font(int new_font)
{
    if (new_font != cur_font)
        flush_output();
    cur_font = new_font;
}

/* Colours are Z-machine colour numbers: 1 is the page's default (it follows
   the light/dark scheme), 2-9 black, red, green, yellow, blue, magenta,
   cyan, white, 10-12 the greys. app.js maps them to CSS variables. */
void os_set_colour(int fg, int bg)
{
    if (fg < DEFAULT_COLOUR || fg > DARKGREY_COLOUR) fg = DEFAULT_COLOUR;
    if (bg < DEFAULT_COLOUR || bg > DARKGREY_COLOUR) bg = DEFAULT_COLOUR;
    if (fg != cur_fg || bg != cur_bg)
        flush_output();
    cur_fg = fg;
    cur_bg = bg;
}

int os_peek_colour(void) { return cur_bg; }

int os_font_data(int font, int *height, int *width)
{
    if (font == TEXT_FONT || font == FIXED_WIDTH_FONT) {
        *height = 1;
        *width = 1;
        return 1;
    }
    return 0;
}

void os_more_prompt(void) { /* the browser scrolls; no [MORE] */ }

void os_frotz_init_screen(void) { }

/* ---- Pictures and sound: not supported in the spike ---- */

bool os_picture_data(int num, int *height, int *width)
{
    (void) num; *height = 0; *width = 0; return FALSE;
}
void os_draw_picture(int num, int row, int col) { (void) num; (void) row; (void) col; }
void os_beep(int number) { (void) number; }
void os_prepare_sample(int number) { (void) number; }
void os_start_sample(int number, int volume, int repeats, zword eos)
{
    (void) number; (void) volume; (void) repeats; (void) eos;
}
void os_stop_sample(int number) { (void) number; }
void os_finish_with_sample(int number) { (void) number; }
void os_wait_sample(void) { }
int os_speech_output(const zchar *s) { (void) s; return 0; }

/* ---- Input ---- */

static void apply_resize(void);

static void before_input(void)
{
    apply_resize();
    flush_output();
    flush_status();
}

/* Encode a zchar string as UTF-8 into dst (dstsize bytes); returns bytes. */
static int zchars_to_utf8(const zchar *src, char *dst, int dstsize)
{
    int n = 0;
    while (*src != 0 && n + 3 < dstsize)
        n += utf8_encode(*src++, dst + n);
    dst[n] = '\0';
    return n;
}

/* Part of the current input line that is already in the transcript: the
   game's initial text when it was flushed before we could take it back.
   It is not echoed a second time. Kept across reads continued after a
   timeout. */
static zchar line_shown[INPUT_BUFFER_SIZE];
static int line_shown_len = 0;

/*
 * On entry buf holds the line so far: initial text supplied by a V5+ game
 * on a new read (continued == 0), or the partial line this function
 * returned with ZC_TIME_OUT when the core continues the same read after a
 * timeout routine (continued != 0). On return buf holds the whole line,
 * terminated by ZC_RETURN, or the partial line with ZC_TIME_OUT.
 */
zchar os_read_line(int max, zchar *buf, int timeout, int width, int continued)
{
    char line[4 * INPUT_BUFFER_SIZE];
    char initial[4 * INPUT_BUFFER_SIZE];
    int nbytes, ilen, i, n, timed_out, skip, redrawn;
    const unsigned char *p;
    (void) width;

    /* Consume the mirrored input_redraw, as console_read_input just did. */
    redrawn = continued && redraw_pending;
    redraw_pending = 0;
    input_win = cwin;

    ilen = zchars_to_utf8(buf, initial, (int) sizeof initial);
    if (continued) {
        /* If the core redrew the partial line (console_read_input calls
           screen_write_input when input_redraw is set), that redraw was the
           last os_display_string, and nothing has been written since: it
           is exactly out_buf[ds_start, ds_end) with ds_end == out_len, and
           os_display_string kept it in one piece. Take it back out, as for
           initial text: the player edits it in the input field, and on
           Enter the whole line is echoed once, on the new line. So nothing
           of it is in the transcript any more. Without a redraw the partial
           line was never shown (a timeout echoes nothing), and line_shown
           is kept for initial text shown before the first read. */
        if (redrawn && ilen > 0 && ds_start >= 0 && ds_end == out_len
                && ds_end - ds_start == ilen
                && memcmp(out_buf + ds_start, initial, (size_t) ilen) == 0) {
            out_len = ds_start;
            ds_start = ds_end = -1;
            line_shown_len = 0;
        }
        /* The core does not flush text the timeout routine printed before
           it continues the read, so it would land after this line's echo. */
        flush_buffer();
    } else {
        /* The game printed its initial text before the read. Take it back
           out of the output buffer so it is edited in the input field and
           echoed once, as typed. If it has already reached the page, leave
           it there and do not echo it again. */
        line_shown_len = 0;
        if (ilen > 0) {
            if (out_len >= ilen && memcmp(out_buf + out_len - ilen, initial, (size_t) ilen) == 0) {
                out_len -= ilen;
            } else {
                for (n = 0; buf[n] != 0 && n < INPUT_BUFFER_SIZE - 1; n++)
                    line_shown[n] = buf[n];
                line_shown_len = n;
            }
        }
    }

    before_input();

    /* `timeout` is in tenths of a second; 0 means wait forever. */
    nbytes = js_read_line(line, (int) sizeof line, timeout * 100, initial, continued);
    apply_resize();     /* so this turn's status redraw uses the new width */
    timed_out = nbytes < 0;
    if (timed_out)
        nbytes = -nbytes - 1;

    /* The page returns the whole line (initial or partial text included),
       so it replaces buf. */
    n = 0;
    p = (const unsigned char *) line;
    for (i = 0; i < nbytes && n < max; ) {
        unsigned int c = p[i];
        if (c < 0x80) { i += 1; }
        else if ((c & 0xe0) == 0xc0 && i + 1 < nbytes) {
            c = ((c & 0x1f) << 6) | (p[i + 1] & 0x3f); i += 2;
        } else if ((c & 0xf0) == 0xe0 && i + 2 < nbytes) {
            c = ((c & 0x0f) << 12) | ((p[i + 1] & 0x3f) << 6) | (p[i + 2] & 0x3f); i += 3;
        } else { i += 1; continue; }   /* skip 4-byte sequences and bad bytes */
        if (c < ZC_ASCII_MIN || c == ZC_BAD)
            continue;
        buf[n++] = (zchar) c;
    }
    buf[n] = 0;

    /* On a timeout the partial line stays in the input field and in buf;
       nothing is echoed. */
    if (timed_out)
        return ZC_TIME_OUT;

    /* Echo the command into the transcript, less any part already shown;
       the core then calls screen_new_line, which reaches us as
       os_new_line(FALSE). */
    skip = 0;
    if (line_shown_len > 0) {
        for (i = 0; i < line_shown_len && buf[i] == line_shown[i]; i++)
            ;
        if (i == line_shown_len)
            skip = line_shown_len;
        line_shown_len = 0;
    }
    os_set_text_style(BOLDFACE_STYLE);
    for (i = skip; buf[i] != 0; i++)
        out_utf8(buf[i]);
    os_set_text_style(0);
    return ZC_RETURN;
}

zchar os_read_key(int timeout, int cursor)
{
    int key;
    (void) cursor;
    before_input();
    key = js_read_key(timeout * 100);
    apply_resize();
    if (key <= 0)
        return ZC_TIME_OUT;
    return (zchar) key;
}

/* ---- Files ---- */

/* The kind and path of the last file request, so os_mark_recent_save can
   tell a save from a restore and persist the file the core actually wrote
   (the game's save file, or an auxiliary file from SAVE with operands). */
static int last_file_flag = -1;
static char last_file_path[MAX_FILE_NAME + 1];

int os_read_file_name(char *file_name, const char *default_name, int flag)
{
    const char *base = default_name;
    const char *slash = strrchr(default_name, '/');
    if (slash)
        base = slash + 1;
    /* The spike does not prompt: every save/restore uses the default name
       under /saves in MEMFS. */
    snprintf(file_name, MAX_FILE_NAME, "%s/%s", SAVE_PATH, base);
    last_file_flag = flag;
    snprintf(last_file_path, sizeof last_file_path, "%s", file_name);
    if (flag == FILE_RESTORE || flag == FILE_LOAD_AUX)
        js_load_save(file_name);
    return 1;
}

FILE *os_path_open(const char *name, const char *mode)
{
    return fopen(name, mode);
}

/* Called by the core after a successful save or restore (fastmem.c), for
   whole-game and auxiliary files alike. After a save, the file is the one
   os_read_file_name was last asked for. Text still in the output buffer
   (the echoed SAVE) goes out first, so a storage notice follows it. */
void os_mark_recent_save(void)
{
    int flag = last_file_flag;
    last_file_flag = -1;
    if (flag != FILE_SAVE && flag != FILE_SAVE_AUX)
        return;
    flush_output();
    js_persist_save(last_file_path);
}

void os_start_script(void) { }
void os_stop_script(void) { }

/* ---- Lifecycle ---- */

void os_fatal(const char *s)
{
    char msg[512];
    flush_output();
    snprintf(msg, sizeof msg, "Fatal error: %s", s);
    js_fatal(msg);
    exit(1);
}

int os_process_arguments(int argc, char *argv[])
{
    (void) argc; (void) argv;
    return 0;
}

void os_init_setup(void)
{
    f_setup.attribute_assignment = 0;
    f_setup.attribute_testing = 0;
    f_setup.context_lines = 0;
    f_setup.object_locating = 0;
    f_setup.object_movement = 0;
    f_setup.left_margin = 0;
    f_setup.right_margin = 0;
    f_setup.ignore_errors = 0;
    f_setup.piracy = 0;
    f_setup.undo_slots = MAX_UNDO_SLOTS;
    f_setup.expand_abbreviations = 0;
    f_setup.script_cols = 80;
    f_setup.save_quetzal = QUETZAL_DEF;
    f_setup.sound = 0;
    f_setup.err_report_mode = ERR_REPORT_NEVER;
}

static void set_screen_size(int packed)
{
    int rows = (packed >> 8) & 0xff, cols = packed & 0xff;
    if (rows < 10) rows = 10;
    if (rows > MAX_ROWS) rows = MAX_ROWS;
    if (cols < 20) cols = 20;
    if (cols > MAX_COLS) cols = MAX_COLS;
    h_screen_rows = (zbyte) rows;
    h_screen_cols = (zbyte) cols;
    h_screen_width = h_screen_cols;
    h_screen_height = h_screen_rows;
}

extern void restart_header(void);

/* Called before and after each read. The page has been resized, so tell the core: the
   window sizes (resize_screen) and the header the game reads
   (restart_header). The game picks the new width up when it next redraws
   its status line or upper window; nothing is interrupted, so no
   ZC_TIME_OUT is needed. Only the width changes at runtime; rows stay as
   sized at load, because shrinking them under a split upper window could
   leave the lower window with no rows. */
static void apply_resize(void)
{
    int packed = js_size_changed();
    int rows = h_screen_rows;
    if (packed == 0)
        return;
    set_screen_size((rows << 8) | (packed & 0xff));
    if (h_version != V6)
        resize_screen();
    restart_header();
    grid_dirty = 1;
}

void os_init_screen(void)
{
    if (h_version == V3)
        h_config |= CONFIG_SPLITSCREEN;
    if (h_version >= V4)
        h_config |= CONFIG_BOLDFACE | CONFIG_EMPHASIS | CONFIG_FIXED | CONFIG_TIMEDINPUT;
    if (h_version >= V5)
        h_config |= CONFIG_COLOUR;
    if (h_version >= V5)
        h_flags &= ~(GRAPHICS_FLAG | MOUSE_FLAG | MENU_FLAG | SOUND_FLAG);
    if (h_version == V3)
        h_flags &= ~OLD_SOUND_FLAG;
    if (h_version >= V5 && (h_flags & UNDO_FLAG) && f_setup.undo_slots == 0)
        h_flags &= ~UNDO_FLAG;

    set_screen_size(js_screen_size());
    h_font_width = 1;
    h_font_height = 1;

    h_interpreter_number = INTERP_DEC_20;
    h_interpreter_version = 'F';

    /* As in frotz/ios/ui_init.c: report colour 1 as the defaults, so the
       "default" colours are whatever the page's light or dark scheme uses.
       COLOUR_FLAG (the game asks for colour) is left as the game set it. */
    h_default_foreground = DEFAULT_COLOUR;
    h_default_background = DEFAULT_COLOUR;

    os_erase_area(1, 1, h_screen_rows, h_screen_cols, 0);
}

void os_reset_screen(void)
{
    os_set_text_style(0);
    out_utf8('\n');
    flush_output();
    flush_status();
}

void os_restart_game(int stage) { (void) stage; }

int os_random_seed(void)
{
    return (int) (time(0) & 0x7fff);
}

static void set_default_file_names(const char *path)
{
    char stripped[MAX_FILE_NAME + 1];
    const char *p = strrchr(path, '/');
    int i;
    p = p ? p + 1 : path;
    for (i = 0; p[i] && p[i] != '.' && i < MAX_FILE_NAME - 20; i++)
        stripped[i] = p[i];
    stripped[i] = '\0';
    snprintf(script_name, MAX_FILE_NAME, "%s-transcript.txt", stripped);
    snprintf(command_name, MAX_FILE_NAME, "%s.rec", stripped);
    snprintf(save_name, MAX_FILE_NAME, "%s.sav", stripped);
    snprintf(auxilary_name, MAX_FILE_NAME, "%s.aux", stripped);
}

/* ---- Entry point (frotz/common/main.c compiles its main() out under FROTZ_IOS) ---- */

extern void init_buffer(void), init_err(void), init_interpreter(void),
    init_sound(void), init_undo(void), z_restart(void), interpret(void),
    reset_memory(void);
extern int init_memory(void);

int main(int argc, char *argv[])
{
    if (argc < 2) {
        js_fatal("usage: frotz <story-file>");
        return 1;
    }
    story_name = argv[1];
    set_default_file_names(story_name);
    js_set_save_name(save_name);

    os_init_setup();
    init_buffer();
    init_err();
    init_memory();
    init_interpreter();
    init_sound();
    os_init_screen();
    init_undo();
    z_restart();
    interpret();
    reset_memory();
    os_reset_screen();
    return 0;
}
