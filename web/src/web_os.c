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

EM_JS(void, js_fatal, (const char *utf8), {
    Module.webFrotz.fatal(UTF8ToString(utf8));
});

/* Resolves to the UTF-8 byte length written into buf, or -1 on timeout. */
EM_ASYNC_JS(int, js_read_line, (char *buf, int maxbytes, int timeout_ms), {
    const line = await Module.webFrotz.readLine(timeout_ms);
    if (line === null) return -1;
    return stringToUTF8(line, buf, maxbytes);
});

/* Screen size in characters that fits the page: (rows << 8) | cols. */
EM_JS(int, js_screen_size, (void), {
    return Module.webFrotz.screenSize();
});

/* Non-zero (a new packed size) if the page was resized since last asked. */
EM_JS(int, js_size_changed, (void), {
    return Module.webFrotz.sizeChanged();
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
static int cur_fg = DEFAULT_COLOUR, cur_bg = DEFAULT_COLOUR;

static unsigned int cur_attr(void)
{
    return (unsigned int) (cur_style & 0xff) | ((unsigned int) cur_fg << 8)
        | ((unsigned int) cur_bg << 16);
}

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
    /* windowNum is 0 for erase_window(0) / erase_screen, the window number
       for erase_window(n), and -1 for erase_line. Only a real erase of the
       lower window clears the transcript. */
    if (windowNum == 0) {
        flush_output();
        js_clear();
    }
    grid_clear(top, left, bottom, right);
}

void os_scroll_area(int top, int left, int bottom, int right, int units)
{
    /* The lower window scrolls in the browser. A scroll inside the upper
       window (rare: only if a game prints past its last row with scrolling
       on) moves its rows up. */
    int r, c;
    if (top > grid_height || units <= 0)
        return;
    if (bottom > MAX_ROWS) bottom = MAX_ROWS;
    if (right > MAX_COLS) right = MAX_COLS;
    for (r = top - 1; r <= bottom - 1 - units; r++)
        for (c = left - 1; c <= right - 1; c++) {
            grid_ch[r][c] = grid_ch[r + units][c];
            grid_attr[r][c] = grid_attr[r + units][c];
        }
    grid_clear(bottom - units + 1, left, bottom, right);
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

static void apply_resize(void);

static void before_input(void)
{
    apply_resize();
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
    apply_resize();     /* so this turn's status redraw uses the new width */
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
    apply_resize();
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
