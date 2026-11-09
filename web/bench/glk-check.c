/*
 * web/bench/glk-check.c: checks of the browser Glk (glk/glk_web.c) that no
 * test story exercises. Built by `make check` against the plain
 * (-DGLK_WEB_SYNC) bridge and run by bench/check-glk.js, which supplies
 * Module.glkWeb and checks what reaches the page. This side checks what the
 * game sees and prints one "ok"/"FAIL" line per check.
 *
 * Covered: set_arrangement (direction change keeps the children in place,
 * axis change and a fixed blank key are refused, a nested key, closing the
 * key collapses cleanly); grid line input limited to the rest of the row,
 * and the limit and echo following a resize under a pending request;
 * cancelling a line before it was shown returns its initial text; the echo
 * setting is fixed per request; overdue timers wait on the page between
 * consecutive timer events; deleting a /saves file reaches the page and the
 * file no longer exists; gestalt for line and char input; style_distinguish
 * against the CSS in glulx.html. And TADS's text adapter
 * (tads/tads_text.c, linked in): the bytes of an unfinished character held
 * for a window that is then closed are written before it goes, never to a
 * freed stream (or to the window that takes its memory) when a line is
 * requested; for TADS 2, an unfinished sequence is resolved as
 * Windows-1252 when output moves on, at a line request, and at the end of
 * the game (which bench/check-glk.js checks on the page after exit).
 */

#include <emscripten.h>
#include <stdio.h>
#include <string.h>

#include "glk.h"
#include "glk_web.h"

static int failures = 0;

static void check(int ok, const char *what)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok)
        failures++;
}

/* The layout the page was last sent, from the driver (check-glk.js). */
EM_JS(int, rect_of, (glui32 rock_id, int what), {
    const r = Module.glkCheck.rect(rock_id);
    return r ? r[what] : -1;
});
EM_JS(int, driver_count, (const char *what), {
    return Module.glkCheck.count(UTF8ToString(what));
});
/* Has the page been sent s (UTF-8) in window id's text, since the last
   driver_clear? */
EM_JS(int, text_has, (int id, const char *s), {
    return Module.glkCheck.textHas(id, UTF8ToString(s)) ? 1 : 0;
});
EM_JS(void, driver_clear, (void), {
    Module.glkCheck.clearText();
});
EM_JS(void, driver_mark, (const char *what), {
    Module.glkCheck.mark(UTF8ToString(what));
});

enum { LEFT = 0, TOP, WIDTH, HEIGHT };

/* The id the page knows a window by: glk_web.c numbers windows in order of
   creation, pair windows included, starting at 1. Kept here by hand. */
static int next_id = 1;

static void flush(void)
{
    event_t ev;
    /* A select with a timer due returns at once after flushing nothing; a
       poll does not flush. A zero-length timer wait flushes the page. */
    glk_request_timer_events(1);
    do
        glk_select(&ev);
    while (ev.type != evtype_Timer);
    glk_request_timer_events(0);
}

static void arrangement(void)
{
    winid_t a, b, c, pair, inner, key;
    int ida, idb, idc;
    glui32 method, size;

    a = glk_window_open(NULL, 0, 0, wintype_TextBuffer, 1);
    ida = next_id++;
    b = glk_window_open(a, winmethod_Above | winmethod_Fixed, 2, wintype_TextGrid, 2);
    idb = next_id++;
    next_id++; /* the pair */
    pair = glk_window_get_parent(b);
    flush();
    check(rect_of(idb, TOP) == 0 && rect_of(ida, TOP) > 0, "Above: grid on top");

    /* Above -> Below: the grid stays on top, the size now goes to the
       bottom window (glkios/ipwindow.c). */
    glk_window_set_arrangement(pair, winmethod_Below | winmethod_Fixed, 2, NULL);
    flush();
    check(rect_of(idb, TOP) == 0 && rect_of(ida, TOP) > 0,
          "Above -> Below keeps the children where they are");
    check(rect_of(ida, HEIGHT) < rect_of(idb, HEIGHT),
          "Above -> Below moves the fixed size to the other side");
    glk_window_get_arrangement(pair, &method, &size, &key);
    check((method & winmethod_DirMask) == winmethod_Below && size == 2 && key == b,
          "get_arrangement after a direction change");
    check(glk_window_get_sibling(b) == a, "children still siblings");

    /* Below -> Left changes the axis: refused. */
    glk_window_set_arrangement(pair, winmethod_Left | winmethod_Fixed, 5, NULL);
    glk_window_get_arrangement(pair, &method, &size, &key);
    check((method & winmethod_DirMask) == winmethod_Below && size == 2,
          "a change of split axis is refused");

    /* A nested key: c splits a; the outer pair takes c as its key. */
    c = glk_window_open(a, winmethod_Right | winmethod_Proportional, 30, wintype_TextBuffer, 3);
    idc = next_id++;
    next_id++;
    inner = glk_window_get_parent(c);
    glk_window_set_arrangement(pair, winmethod_Below | winmethod_Fixed, 3, c);
    glk_window_get_arrangement(pair, &method, &size, &key);
    check(key == c && size == 3, "a nested window can be the key");
    flush();
    check(rect_of(idc, LEFT) > rect_of(ida, LEFT), "the nested split is still left/right");

    /* A blank key with a fixed size is refused. */
    {
        winid_t blank = glk_window_open(c, winmethod_Below | winmethod_Proportional, 50,
                                        wintype_Blank, 4);
        winid_t bpair = glk_window_get_parent(blank);
        next_id += 2;
        glk_window_set_arrangement(bpair, winmethod_Below | winmethod_Fixed, 2, blank);
        glk_window_get_arrangement(bpair, &method, &size, &key);
        check((method & winmethod_DivisionMask) == winmethod_Proportional,
              "a fixed size on a blank key is refused");
        glk_window_close(blank, NULL);
    }

    /* Closing the outer pair's key collapses its pair; the outer pair
       keeps working without a key. */
    glk_window_close(c, NULL);
    check(glk_window_get_parent(a) == pair && glk_window_get_sibling(a) == b,
          "closing the nested key collapses its pair");
    glk_window_get_arrangement(pair, &method, &size, &key);
    check(key == NULL, "the outer pair has no key once it is closed");
    flush();
    check(rect_of(idc, LEFT) == -1 && rect_of(ida, WIDTH) > 0 && rect_of(idb, TOP) == 0,
          "layout after the close");
    (void) inner;

    glk_window_close(glk_window_get_root(), NULL);
}

static void grid_input(void)
{
    winid_t a, g;
    char buf[256];
    event_t ev;
    glui32 cols, rows;
    a = glk_window_open(NULL, 0, 0, wintype_TextBuffer, 1);
    next_id++;
    g = glk_window_open(a, winmethod_Above | winmethod_Fixed, 3, wintype_TextGrid, 2);
    next_id += 2;
    glk_window_get_size(g, &cols, &rows);
    glk_window_move_cursor(g, cols - 5, 0);
    glk_request_line_event(g, buf, sizeof buf, 0);
    driver_mark("grid");
    glk_select(&ev); /* the driver answers with 20 characters */
    check(ev.type == evtype_LineInput && ev.win == g && ev.val1 == 5,
          "grid line input is limited to the rest of the row");
    check(driver_count("grid-maxlen") == 5, "the page is told the row's limit");
    flush();
    check(driver_count("grid-row1-blank") == 1, "the echo does not wrap into the next row");
    glk_window_close(a, NULL); /* a is the root's child: close the root */
    glk_window_close(glk_window_get_root(), NULL);
}

/* A grid resized under a pending line request: the limit follows the new
   width (both ways) and the echo stays on the row. */
static void grid_resize_input(void)
{
    winid_t a, g;
    char buf[256];
    event_t ev;
    glui32 cols, cols2, rows;
    a = glk_window_open(NULL, 0, 0, wintype_TextBuffer, 1);
    next_id++;
    g = glk_window_open(a, winmethod_Above | winmethod_Fixed, 3, wintype_TextGrid, 2);
    next_id += 2;
    glk_window_get_size(g, &cols, &rows);
    glk_window_move_cursor(g, cols - 5, 0);
    glk_request_line_event(g, buf, sizeof buf, 0);
    driver_mark("shrink");
    glk_select(&ev); /* the driver narrows the page by 3 columns */
    glk_window_get_size(g, &cols2, &rows);
    check(ev.type == evtype_Arrange && cols2 == cols - 3, "the grid shrinks by 3 columns");
    driver_mark("grid-shrunk");
    glk_select(&ev); /* 20 characters */
    check(ev.type == evtype_LineInput && ev.win == g && ev.val1 == 2,
          "after a shrink the pending line takes only what is left of the row");
    check(driver_count("grid-maxlen") == 2, "the page is told the new limit");
    flush();
    check(driver_count("grid-echo-ab") == 1, "the echo stays on the shrunk row");

    /* Grow: a request made at 5 from the end gets the 3 columns back. */
    glk_window_move_cursor(g, cols2 - 5, 0);
    glk_request_line_event(g, buf, sizeof buf, 0);
    driver_mark("grow");
    glk_select(&ev);
    check(ev.type == evtype_Arrange, "the grid grows back");
    driver_mark("grid-grown");
    glk_select(&ev);
    check(ev.type == evtype_LineInput && ev.val1 == 8,
          "after a grow the pending line takes the wider row");
    glk_window_close(glk_window_get_root(), NULL);
}

static void cancel_and_echo(void)
{
    winid_t a;
    char buf[64];
    event_t ev;
    a = glk_window_open(NULL, 0, 0, wintype_TextBuffer, 1);
    next_id++;

    memcpy(buf, "look", 4);
    glk_request_line_event(a, buf, sizeof buf, 4);
    memset(buf, 0, sizeof buf);
    glk_cancel_line_event(a, &ev);
    check(ev.type == evtype_LineInput && ev.val1 == 4 && memcmp(buf, "look", 4) == 0,
          "a line cancelled before it was shown keeps its initial text");
    check(driver_count("cancelLine") == 0, "... without asking the page");

    /* Echo: the setting at request time applies to that request. */
    glk_request_line_event(a, buf, sizeof buf, 0);
    glk_set_echo_line_event(a, 0);
    driver_mark("echo");
    glk_select(&ev); /* the driver answers "xyzzy" */
    flush();
    check(driver_count("echoed-xyzzy") == 1, "echo is fixed when the request is made");

    glk_request_line_event(a, buf, sizeof buf, 0);
    driver_mark("noecho");
    glk_select(&ev); /* "plugh" */
    flush();
    check(driver_count("echoed-plugh") == 0, "... and the next request uses the new setting");
    glk_set_echo_line_event(a, 1);
    glk_window_close(a, NULL);
}

static void timers(void)
{
    event_t ev;
    int i, waits;
    winid_t a = glk_window_open(NULL, 0, 0, wintype_TextBuffer, 1);
    next_id++;
    /* Start from a select that waited (the driver answers a key). */
    glk_request_char_event(a);
    driver_mark("timers");
    glk_select(&ev);
    check(ev.type == evtype_CharInput, "char event");
    glk_request_timer_events(5);
    {
        double t = emscripten_get_now();
        while (emscripten_get_now() - t < 12)
            ;
    }
    waits = driver_count("wait");
    for (i = 0; i < 4; i++) {
        double t;
        glk_select(&ev);
        check(ev.type == evtype_Timer, "timer event");
        /* A handler slower than the interval. */
        t = emscripten_get_now();
        while (emscripten_get_now() - t < 12)
            ;
    }
    /* The first overdue timer comes at once; each following one waits. */
    check(driver_count("wait") - waits == 3, "consecutive overdue timers wait on the page");
    check(driver_count("wait0") >= 3, "... with a zero timeout");
    glk_request_timer_events(0);
    glk_window_close(a, NULL);
}

static void deletion(void)
{
    frefid_t f = glk_fileref_create_by_name(fileusage_Data | fileusage_BinaryMode, "notes", 0);
    strid_t s = glk_stream_open_file(f, filemode_Write, 0);
    glk_put_string_stream(s, "hello");
    glk_stream_close(s, NULL);
    check(driver_count("persist:/saves/notes.glkdata") == 1, "closing a written file persists it");
    check(glk_fileref_does_file_exist(f), "the file exists");
    glk_fileref_delete_file(f);
    check(driver_count("delete:/saves/notes.glkdata") == 1, "deleting reaches the page");
    check(!glk_fileref_does_file_exist(f), "the file no longer exists");
    glk_fileref_destroy(f);
}

static void gestalt_and_styles(void)
{
    winid_t a = glk_window_open(NULL, 0, 0, wintype_TextBuffer, 1);
    winid_t g = glk_window_open(a, winmethod_Above | winmethod_Fixed, 1, wintype_TextGrid, 2);
    next_id += 3;
    check(glk_gestalt(gestalt_LineInput, 'a') && glk_gestalt(gestalt_LineInput, 0x1f600),
          "LineInput: printable and supplementary characters");
    check(!glk_gestalt(gestalt_LineInput, 0xd800) && !glk_gestalt(gestalt_LineInput, 0x110000)
          && !glk_gestalt(gestalt_LineInput, 0x85) && !glk_gestalt(gestalt_LineInput, keycode_Left),
          "LineInput: surrogates, out of range, C1 controls and keycodes are not");
    check(glk_gestalt(gestalt_CharInput, keycode_Func5) && glk_gestalt(gestalt_CharInput, keycode_Home)
          && glk_gestalt(gestalt_CharInput, 0xe9),
          "CharInput: function keys, Home, Latin-1");
    check(!glk_gestalt(gestalt_CharInput, 0xfffffff0) && !glk_gestalt(gestalt_CharInput, keycode_Unknown)
          && !glk_gestalt(gestalt_CharInput, 0xd800),
          "CharInput: reserved keycodes, Unknown and surrogates are not");
    check(!glk_style_distinguish(a, style_Subheader, style_Input)
          && glk_style_distinguish(a, style_Header, style_Subheader)
          && !glk_style_distinguish(g, style_Header, style_Subheader),
          "style_distinguish matches the CSS");
    glk_window_close(glk_window_get_root(), NULL);
}

/* tads/tads_text.c, which the TADS builds link in place of osbuffer.c. */
winid_t mainwin = NULL;
void os_put_buffer(const char *buf, size_t len);
void os_get_buffer(char *buf, size_t len, size_t init);
char *os_fill_buffer(char *buf, size_t len);
void tadsweb_text_utf8(int on);
int tadsweb_text_legacy(void);

/* Read a line through os_get_buffer / os_fill_buffer, as osglk.c does. */
static void tads_line(char *buf, size_t len)
{
    event_t ev;
    os_get_buffer(buf, len, 0);
    driver_mark("tads-line");
    do
        glk_select(&ev); /* "plugh" */
    while (ev.type != evtype_LineInput);
    os_fill_buffer(buf, ev.val1);
}

static void tads_text(void)
{
    winid_t a, banner, other;
    int ida, idb;
    char buf[64];

    /* TADS 3: half of "é" to a banner, the banner deleted, a window opened
       (calloc hands it the freed stream's memory), then a line read. The
       half character must not follow the stream into either window. */
    tadsweb_text_utf8(1);
    a = glk_window_open(NULL, 0, 0, wintype_TextBuffer, 10);
    ida = next_id++;
    mainwin = a;
    banner = glk_window_open(a, winmethod_Above | winmethod_Fixed, 3, wintype_TextBuffer, 11);
    next_id += 2;
    glk_set_window(banner);
    os_put_buffer("x\xC3", 2);
    glk_window_close(banner, NULL);
    other = glk_window_open(a, winmethod_Above | winmethod_Fixed, 3, wintype_TextBuffer, 12);
    idb = next_id++;
    next_id++;
    driver_clear();
    glk_set_window(other);
    os_put_buffer("y", 1);
    glk_set_window(a);
    tads_line(buf, sizeof buf);
    check(strcmp(buf, "plugh") == 0, "TADS: a line after a banner closed on half a character");
    check(text_has(idb, "y") && !text_has(idb, "\xEF\xBF\xBD") && !text_has(ida, "\xEF\xBF\xBD"),
          "TADS: half a character for a closed banner reaches no other window");
    glk_window_close(other, NULL);

    /* TADS 2: a Windows-1252 "é" (0xE9, also the start of a 3-byte UTF-8
       sequence) at the end of a string is Windows-1252 once the next
       string does not continue it. */
    tadsweb_text_utf8(0);
    driver_clear();
    os_put_buffer("caf\xE9", 4);
    os_put_buffer(" ok", 3);
    flush();
    check(text_has(ida, "caf\xC3\xA9 ok") && tadsweb_text_legacy(),
          "TADS 2: an unfinished UTF-8 prefix the next string does not finish is Windows-1252");

    /* The same at a line request. */
    tadsweb_text_utf8(0);
    driver_clear();
    os_put_buffer("th\xE9", 3);
    tads_line(buf, sizeof buf);
    check(text_has(ida, "th\xC3\xA9") && !text_has(ida, "\xEF\xBF\xBD") && tadsweb_text_legacy(),
          "TADS 2: an unfinished UTF-8 prefix at a line request is Windows-1252");

    /* Closing a stream counts the held bytes it flushes: TADS 2 writes
       "caf" and holds 0xE9, which the close writes as Windows-1252, so
       the result is 4 characters. Then the same for a window. */
    {
        char mem[16];
        strid_t ms;
        stream_result_t res;
        winid_t w;
        tadsweb_text_utf8(0);
        memset(mem, 0, sizeof mem);
        ms = glk_stream_open_memory(mem, sizeof mem, filemode_Write, 13);
        glk_stream_set_current(ms);
        os_put_buffer("caf\xE9", 4);
        glk_stream_close(ms, &res);
        check(res.writecount == 4 && memcmp(mem, "caf\xE9", 4) == 0,
              "TADS 2: a memory stream's close counts the held byte it writes");
        tadsweb_text_utf8(0);
        w = glk_window_open(a, winmethod_Above | winmethod_Fixed, 3, wintype_TextBuffer, 14);
        next_id += 2;
        glk_set_window(w);
        os_put_buffer("caf\xE9", 4);
        glk_window_close(w, &res);
        check(res.writecount == 4, "TADS 2: a window's close counts the held byte it writes");
        glk_set_window(a);
    }

    /* And at the end of the game: left held, for glk_main's caller to end
       the game (glkweb_finish); check-glk.js looks for it on the page. */
    tadsweb_text_utf8(0);
    driver_clear();
    os_put_buffer("fin\xE9", 4);
}

void glk_main(void)
{
    arrangement();
    grid_input();
    grid_resize_input();
    cancel_and_echo();
    timers();
    deletion();
    gestalt_and_styles();
    tads_text();
    printf("%s\n", failures ? "FAILED" : "PASSED");
}

int main(void)
{
    glkweb_init("/check.ulx");
    glk_main();
    glkweb_finish();
    return failures ? 1 : 0;
}
