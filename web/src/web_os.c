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
 * Saves go to /saves, which app.js mounts on IDBFS. After every successful
 * save or restore, and before the interpreter exits, js_sync_saves() awaits
 * FS.syncfs so the files reach IndexedDB.
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

/* ---- JavaScript bridge ---- */

EM_JS(void, js_output, (const char *utf8, int style), {
    Module.webFrotz.output(UTF8ToString(utf8), style);
});

EM_JS(void, js_clear, (void), {
    Module.webFrotz.clear();
});

EM_JS(void, js_status, (const char *utf8, int rows), {
    Module.webFrotz.status(UTF8ToString(utf8), rows);
});

EM_JS(void, js_fatal, (const char *utf8), {
    Module.webFrotz.fatal(UTF8ToString(utf8));
});

/* Resolves to the UTF-8 byte length written into buf, or -1 on timeout. */
EM_ASYNC_JS(int, js_read_line, (char *buf, int maxbytes, int timeout_ms), {
    const line = await Module.webFrotz.readLine(timeout_ms);
    if (line === null) return -1;
    return stringToUTF8(line, buf, maxbytes);
});

/* Flush /saves (IDBFS) to IndexedDB. Awaited, so a quit cannot race it. */
EM_ASYNC_JS(void, js_sync_saves, (void), {
    try {
        await Module.webFrotz.syncSaves();
    } catch (e) {
        console.warn("[frotz] syncfs failed", e);
    }
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

static void flush_output(void)
{
    if (out_len == 0)
        return;
    out_buf[out_len] = '\0';
    js_output(out_buf, cur_style);
    out_len = 0;
}

static void out_utf8(unsigned int c)
{
    if (out_len >= OUT_CAP)
        flush_output();
    if (c < 0x80) {
        out_buf[out_len++] = (char) c;
    } else if (c < 0x800) {
        out_buf[out_len++] = (char) (0xc0 | (c >> 6));
        out_buf[out_len++] = (char) (0x80 | (c & 0x3f));
    } else {
        out_buf[out_len++] = (char) (0xe0 | (c >> 12));
        out_buf[out_len++] = (char) (0x80 | ((c >> 6) & 0x3f));
        out_buf[out_len++] = (char) (0x80 | (c & 0x3f));
    }
}

/* ---- Output: upper window grid ---- */

static unsigned short grid[MAX_ROWS][MAX_COLS];
static int grid_height = 0;     /* rows in the upper window */
static int cur_row = 0, cur_col = 0;
static int grid_dirty = 1;

static void grid_put(unsigned int c)
{
    if (cur_row >= 0 && cur_row < MAX_ROWS && cur_col >= 0 && cur_col < MAX_COLS) {
        grid[cur_row][cur_col] = (unsigned short) c;
        grid_dirty = 1;
    }
    cur_col++;
}

static void flush_status(void)
{
    static char sbuf[MAX_ROWS * (MAX_COLS * 3 + 1) + 1];
    int r, c, n = 0, cols = h_screen_cols < MAX_COLS ? h_screen_cols : MAX_COLS;

    if (!grid_dirty)
        return;
    for (r = 0; r < grid_height && r < MAX_ROWS; r++) {
        for (c = 0; c < cols; c++) {
            unsigned int ch = grid[r][c] ? grid[r][c] : ' ';
            if (ch < 0x80) sbuf[n++] = (char) ch;
            else if (ch < 0x800) {
                sbuf[n++] = (char) (0xc0 | (ch >> 6));
                sbuf[n++] = (char) (0x80 | (ch & 0x3f));
            } else {
                sbuf[n++] = (char) (0xe0 | (ch >> 12));
                sbuf[n++] = (char) (0x80 | ((ch >> 6) & 0x3f));
                sbuf[n++] = (char) (0x80 | (ch & 0x3f));
            }
        }
        sbuf[n++] = '\n';
    }
    sbuf[n] = '\0';
    js_status(sbuf, grid_height);
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
}

void os_backspace(void)
{
    if (cwin == 0) {
        if (out_len > 0)
            out_len--;
    } else if (cur_col > 0) {
        cur_col--;
        grid_put(' ');
        cur_col--;
    }
}

bool os_check_unicode(unsigned int c) { (void) c; return TRUE; }
int os_char_width(zchar c) { (void) c; return 1; }

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

void os_new_line(bool wrapping)
{
    if (cwin != 0)
        return;          /* upper-window line moves arrive via os_set_cursor */
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
    int r, c;
    if (top == 1 && bottom == h_screen_rows && left == 1 && right == h_screen_cols) {
        flush_output();
        js_clear();
    } else if (windowNum == 0) {
        flush_output();
        js_clear();
    }
    for (r = top - 1; r <= bottom - 1 && r < MAX_ROWS; r++)
        for (c = left - 1; c <= right - 1 && c < MAX_COLS; c++)
            if (r >= 0 && c >= 0)
                grid[r][c] = ' ';
    grid_dirty = 1;
}

void os_scroll_area(int top, int left, int bottom, int right, int units)
{
    /* The main window scrolls in the browser; the upper window never scrolls
       in practice. Nothing to do for the spike. */
    (void) top; (void) left; (void) bottom; (void) right; (void) units;
}

void os_set_text_style(int new_style)
{
    if (new_style != cur_style)
        flush_output();
    cur_style = new_style;
    currTextStyle = new_style;
}

void os_set_font(int new_font) { (void) new_font; }
void os_set_colour(int fg, int bg) { (void) fg; (void) bg; }
int os_peek_colour(void) { return BLACK_COLOUR; }

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

static void before_input(void)
{
    flush_output();
    flush_status();
}

zchar os_read_line(int max, zchar *buf, int timeout, int width, int continued)
{
    char line[4 * INPUT_BUFFER_SIZE];
    int nbytes, i, n;
    const unsigned char *p;
    (void) width;

    before_input();

    /* `timeout` is in tenths of a second; 0 means wait forever. */
    nbytes = js_read_line(line, (int) sizeof line, timeout * 100);
    if (nbytes < 0)
        return ZC_TIME_OUT;

    /* With `continued` the buffer already holds the partial line typed before
       a timeout; append to it. Otherwise start fresh. */
    n = 0;
    if (continued)
        while (buf[n] != 0)
            n++;

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

    /* Echo the command into the transcript; the core then calls
       screen_new_line, which reaches us as os_new_line(FALSE). */
    os_set_text_style(BOLDFACE_STYLE);
    for (i = 0; buf[i] != 0; i++)
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
    if (key <= 0)
        return ZC_TIME_OUT;
    return (zchar) key;
}

/* ---- Files ---- */

int os_read_file_name(char *file_name, const char *default_name, int flag)
{
    const char *base = default_name;
    const char *slash = strrchr(default_name, '/');
    (void) flag;
    if (slash)
        base = slash + 1;
    /* The spike does not prompt: every save/restore uses the default name
       under /saves in MEMFS. */
    snprintf(file_name, MAX_FILE_NAME, "%s/%s", SAVE_PATH, base);
    return 1;
}

FILE *os_path_open(const char *name, const char *mode)
{
    return fopen(name, mode);
}

/* Called by the core after a successful save or restore (fastmem.c). */
void os_mark_recent_save(void)
{
    js_sync_saves();
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
    js_sync_saves();
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

void os_init_screen(void)
{
    if (h_version == V3)
        h_config |= CONFIG_SPLITSCREEN;
    if (h_version >= V4)
        h_config |= CONFIG_BOLDFACE | CONFIG_EMPHASIS | CONFIG_FIXED | CONFIG_TIMEDINPUT;
    if (h_version >= V5)
        h_flags &= ~(GRAPHICS_FLAG | MOUSE_FLAG | MENU_FLAG | SOUND_FLAG);
    if (h_version == V3)
        h_flags &= ~OLD_SOUND_FLAG;
    if (h_version >= V5 && (h_flags & UNDO_FLAG) && f_setup.undo_slots == 0)
        h_flags &= ~UNDO_FLAG;

    h_screen_rows = 25;
    h_screen_cols = 80;
    h_screen_width = h_screen_cols;
    h_screen_height = h_screen_rows;
    h_font_width = 1;
    h_font_height = 1;

    h_interpreter_number = INTERP_DEC_20;
    h_interpreter_version = 'F';

    h_default_foreground = BLACK_COLOUR;
    h_default_background = WHITE_COLOUR;
    h_flags &= ~COLOUR_FLAG;

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
    js_sync_saves();    /* `quit`: make sure the last save reached IndexedDB */
    return 0;
}
