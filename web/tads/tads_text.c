/*
 * web/tads/tads_text.c: TADS text to and from the browser Glk, in place of
 * tads/osbuffer.c (web/README.md, "TADS", "Text encoding").
 *
 * tads/osglk.c and osglkban.c hand every string to os_put_buffer and read
 * every line through os_get_buffer / os_fill_buffer. osbuffer.c has two
 * versions of these: bytes (glk_put_buffer, which the browser Glk takes
 * as Latin-1) and, under GLK_UNICODE, a conversion through osparse.c.
 * Neither fits here:
 *   - TADS 3 writes and expects UTF-8 (tads/osansi3.c's os_get_charmap
 *     names "utf-8" for the display and the keyboard), so the byte version
 *     shows "é" as "Ã©" and hands the game Latin-1 bytes for what the
 *     player typed;
 *   - the GLK_UNICODE version's os_fill_buffer converts into the whole
 *     buffer and then writes buf[res] = '\0', one past the end when the
 *     conversion fills it, and os_get_buffer passes a resumed line's
 *     length in bytes where Glk wants characters.
 *
 * What this file does:
 *   - Output is decoded and written with glk_put_buffer_uni. With
 *     tadsweb_text_utf8(1) (TADS 3) it is UTF-8, and a malformed byte shows
 *     as U+FFFD. Otherwise (TADS 2, whose games are in whatever character
 *     set their author used) it is UTF-8 until a string is not valid UTF-8,
 *     and Windows-1252 from then on, input included: the same guess
 *     osparse.c makes, without its Cyrillic and Mac Roman cases.
 *   - A character split across two calls is kept (at most 3 bytes) and
 *     finished by the next call. When it can no longer be finished (the
 *     next call goes to another stream or does not continue it, a line is
 *     requested, its stream is about to be destroyed, the game ends), what
 *     was kept is resolved and written to its own stream: as U+FFFD for
 *     TADS 3, and for TADS 2 as Windows-1252, switching the session to it
 *     (an unfinished UTF-8 sequence is not UTF-8). glk_web.c reports the
 *     destruction of a stream and the end of the game through
 *     glkweb_set_pending_hook, so the stream is never used once freed.
 *   - A line is read with glk_request_line_event_uni into a buffer of
 *     len - 1 characters. A resumed line (os_gets_timeout after a
 *     timeout) is decoded first, and its length given to Glk in characters.
 *   - TADS 3 strings hold 16-bit characters (tads/tads3/utf8.h), so a
 *     typed character past U+FFFF (an emoji) reaches a TADS 3 game as
 *     U+FFFD; its own text never has one.
 *   - os_fill_buffer encodes the line back into the caller's buffer, never
 *     more than len - 1 bytes of whole characters plus the terminator, len
 *     being the size os_get_buffer was given. A line whose encoding is
 *     longer than that (only possible with non-ASCII text) is cut at the
 *     last character that fits.
 * If the character buffer cannot be allocated, the line is read as bytes,
 * as osbuffer.c does without GLK_UNICODE.
 */

#include <stdlib.h>
#include <string.h>

#include "os.h"
#include "glk.h"
#include "tads_web.h"
#include "glk_web.h"

extern winid_t mainwin;

static int utf8_only = 0;   /* TADS 3: always UTF-8 */
static int legacy = 0;      /* TADS 2: switched to Windows-1252 */

void tadsweb_text_utf8(int on)
{
    utf8_only = on;
    legacy = 0;
}

int tadsweb_text_legacy(void)
{
    return legacy;
}

/* Windows-1252 0x80-0x9F; the rest of the range is Latin-1. 0 = unused. */
static const unsigned short cp1252_hi[32] = {
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
    0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178
};

static glui32 cp1252_decode(unsigned char b)
{
    if (b >= 0x80 && b < 0xA0)
        return cp1252_hi[b - 0x80] ? cp1252_hi[b - 0x80] : 0xFFFD;
    return b;
}

static unsigned char cp1252_encode(glui32 c)
{
    int i;
    if (c < 0x80 || (c >= 0xA0 && c < 0x100))
        return (unsigned char) c;
    for (i = 0; i < 32; i++)
        if (cp1252_hi[i] == c)
            return (unsigned char) (0x80 + i);
    return '?';
}

/* The length of the UTF-8 sequence that starts with b, 0 if b cannot
   start one. */
static int utf8_seq_len(unsigned char b)
{
    if (b < 0x80) return 1;
    if (b >= 0xC2 && b < 0xE0) return 2;
    if (b >= 0xE0 && b < 0xF0) return 3;
    if (b >= 0xF0 && b < 0xF5) return 4;
    return 0;
}

/* Decode the sequence of n = utf8_seq_len(p[0]) bytes at p, all present.
   Returns the character, or 0xFFFFFFFF if it is malformed (a bad
   continuation byte, an overlong form, a surrogate, past U+10FFFF). */
static glui32 utf8_seq(const unsigned char *p, int n)
{
    glui32 c;
    int i;
    if (n == 1)
        return p[0];
    c = p[0] & (0x7F >> n);
    for (i = 1; i < n; i++) {
        if ((p[i] & 0xC0) != 0x80)
            return 0xFFFFFFFF;
        c = (c << 6) | (p[i] & 0x3F);
    }
    if ((n == 3 && c < 0x800) || (n == 4 && (c < 0x10000 || c > 0x10FFFF))
        || (c >= 0xD800 && c < 0xE000))
        return 0xFFFFFFFF;
    return c;
}

/* Is buf[0..len) valid UTF-8, allowing an unfinished last character? */
static int valid_utf8(const unsigned char *p, size_t len)
{
    size_t i = 0;
    while (i < len) {
        int n = utf8_seq_len(p[i]);
        size_t j;
        if (!n)
            return 0;
        if (i + n > len) {
            for (j = i + 1; j < len; j++)
                if ((p[j] & 0xC0) != 0x80)
                    return 0;
            return 1;
        }
        if (utf8_seq(p + i, n) == 0xFFFFFFFF)
            return 0;
        i += n;
    }
    return 1;
}

/* ---- Output ---- */

static unsigned char carry[4];
static int carry_len = 0;
static strid_t carry_str = NULL;

#define CHUNK 256

/* Resolve the n bytes of a character that was never finished into out
   (room for 4); returns how many characters. TADS 3 only writes UTF-8, so
   they are one malformed character, U+FFFD. For TADS 2 they show the text
   is not UTF-8 (a Windows-1252 "é" is 0xE9, which also starts a 3-byte
   UTF-8 sequence): the session switches to Windows-1252, as for any other
   invalid string, and they are written as such. */
static size_t resolve(const unsigned char *b, int n, glui32 *out)
{
    int i;
    if (utf8_only) {
        out[0] = 0xFFFD;
        return 1;
    }
    legacy = 1;
    for (i = 0; i < n; i++)
        out[i] = cp1252_decode(b[i]);
    return (size_t) n;
}

/* Write the kept bytes of an unfinished character, resolved, to the stream
   they were written to. Called at every point the character can no longer
   be finished: output to another stream, a line request, the stream about
   to be destroyed, the end of the game. */
static void flush_carry(void)
{
    glui32 out[4];
    size_t n;
    strid_t str = carry_str;
    if (!carry_len || !str) {
        carry_len = 0;
        carry_str = NULL;
        return;
    }
    n = resolve(carry, carry_len, out);
    carry_len = 0;
    carry_str = NULL;
    glk_put_buffer_stream_uni(str, out, (glui32) n);
}

/* glk_web.c calls this before it destroys a stream, and with NULL when the
   game ends (glkweb_set_pending_hook), so carry_str never outlives its
   stream and nothing kept is lost at the end. */
static void pending_hook(strid_t str)
{
    if (carry_len && (!str || str == carry_str))
        flush_carry();
}

/* Write n characters, CHUNK at a time. */
static void put_chars(glui32 *out, size_t *n, int force)
{
    if (*n && (force || *n == CHUNK)) {
        glk_put_buffer_uni(out, (glui32) *n);
        *n = 0;
    }
}

void os_put_buffer(const char *buf, size_t len)
{
    const unsigned char *p = (const unsigned char *) buf;
    glui32 out[CHUNK];
    size_t i = 0, n = 0;
    strid_t str = glk_stream_get_current();

    if (!buf || !str)
        return;
    if (carry_len && carry_str != str)
        flush_carry();

    /* Finish the character the last call left unfinished. */
    if (carry_len) {
        int need = utf8_seq_len(carry[0]);
        glui32 c = 0xFFFFFFFF;
        while (carry_len < need && i < len && (p[i] & 0xC0) == 0x80)
            carry[carry_len++] = p[i++];
        if (carry_len < need && i == len)
            return;                         /* still unfinished */
        if (carry_len == need)
            c = utf8_seq(carry, need);
        if (c != 0xFFFFFFFF)
            out[n++] = c;
        else
            n += resolve(carry, carry_len, out + n);
        carry_len = 0;
        carry_str = NULL;
    }

    if (!utf8_only && !legacy && !valid_utf8(p + i, len - i))
        legacy = 1;

    while (i < len) {
        int k = legacy ? 1 : utf8_seq_len(p[i]);
        glui32 c;
        if (legacy) {
            out[n++] = cp1252_decode(p[i++]);
        } else if (k && i + k > len && valid_utf8(p + i, len - i)) {
            /* The last character is cut: keep it for the next call. */
            memcpy(carry, p + i, len - i);
            carry_len = (int) (len - i);
            carry_str = str;
            glkweb_set_pending_hook(pending_hook);
            break;
        } else if (!k || i + k > len || (c = utf8_seq(p + i, k)) == 0xFFFFFFFF) {
            out[n++] = 0xFFFD;
            i++;
        } else {
            out[n++] = c;
            i += k;
        }
        put_chars(out, &n, 0);
    }
    put_chars(out, &n, 1);
}

/* ---- Input ---- */

static glui32 *input = NULL;    /* the Glk line buffer, in characters */
static size_t input_max = 0;    /* its size, in characters */
static size_t buf_size = 0;     /* the size of the caller's buffer, bytes */

/* Decode len bytes of buf into at most max characters; returns how many. */
static size_t decode_line(const char *buf, size_t len, glui32 *out, size_t max)
{
    const unsigned char *p = (const unsigned char *) buf;
    size_t i = 0, n = 0;
    while (i < len && n < max) {
        int k = legacy ? 1 : utf8_seq_len(p[i]);
        glui32 c;
        if (legacy) {
            out[n++] = cp1252_decode(p[i++]);
            continue;
        }
        if (!k || i + k > len || (c = utf8_seq(p + i, k)) == 0xFFFFFFFF) {
            out[n++] = 0xFFFD;
            i++;
        } else {
            out[n++] = c;
            i += k;
        }
    }
    return n;
}

/* Encode n characters into at most cap bytes, whole characters only;
   returns the number of bytes. */
static size_t encode_line(const glui32 *in, size_t n, char *buf, size_t cap)
{
    unsigned char *o = (unsigned char *) buf;
    size_t i, k = 0;
    for (i = 0; i < n; i++) {
        glui32 c = in[i];
        size_t need;
        if (legacy) {
            if (k + 1 > cap)
                break;
            o[k++] = cp1252_encode(c);
            continue;
        }
        /* TADS 3's strings hold 16-bit characters (tads3/utf8.h reads at
           most three bytes), so it gets U+FFFD for anything past U+FFFF. */
        if (c > 0x10FFFF || (c >= 0xD800 && c < 0xE000) || (utf8_only && c > 0xFFFF))
            c = 0xFFFD;
        need = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (k + need > cap)
            break;
        if (need == 1) {
            o[k++] = (unsigned char) c;
        } else if (need == 2) {
            o[k++] = (unsigned char) (0xC0 | (c >> 6));
            o[k++] = (unsigned char) (0x80 | (c & 0x3F));
        } else if (need == 3) {
            o[k++] = (unsigned char) (0xE0 | (c >> 12));
            o[k++] = (unsigned char) (0x80 | ((c >> 6) & 0x3F));
            o[k++] = (unsigned char) (0x80 | (c & 0x3F));
        } else {
            o[k++] = (unsigned char) (0xF0 | (c >> 18));
            o[k++] = (unsigned char) (0x80 | ((c >> 12) & 0x3F));
            o[k++] = (unsigned char) (0x80 | ((c >> 6) & 0x3F));
            o[k++] = (unsigned char) (0x80 | (c & 0x3F));
        }
    }
    return k;
}

void os_get_buffer(char *buf, size_t len, size_t init)
{
    size_t n;

    flush_carry();
    if (input) {
        /* A request that was never filled: end it before its buffer goes. */
        glk_cancel_line_event(mainwin, NULL);
        free(input);
        input = NULL;
    }
    buf_size = len;
    if (len < 2) {
        input_max = 0;
        glk_request_line_event(mainwin, buf, 0, 0);
        return;
    }
    if (init > len - 1)
        init = len - 1;
    input_max = len - 1;
    input = malloc(sizeof(glui32) * input_max);
    if (!input) {
        glk_request_line_event(mainwin, buf, (glui32) (len - 1), (glui32) init);
        return;
    }
    n = decode_line(buf, init, input, input_max);
    glk_request_line_event_uni(mainwin, input, (glui32) input_max, (glui32) n);
}

char *os_fill_buffer(char *buf, size_t len)
{
    size_t k;

    if (!input) {
        /* The byte request (or a zero-size one). */
        if (buf_size == 0)
            return buf;
        if (len > buf_size - 1)
            len = buf_size - 1;
        buf[len] = '\0';
        return buf;
    }
    if (len > input_max)
        len = input_max;
    k = encode_line(input, len, buf, buf_size - 1);
    buf[k] = '\0';
    free(input);
    input = NULL;
    input_max = 0;
    return buf;
}
