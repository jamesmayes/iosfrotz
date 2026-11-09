#charset "utf-8"

/*
 *   UTF-8 test for the TADS 3 web interpreter (web/README.md, "Text
 *   encoding"). Written for this repo and distributed under the repo's
 *   licence, the GNU General Public License, version 2 (COPYING at the top
 *   of the repo). Like belfry.t it uses no library and
 *   declares the intrinsics itself, in the order of the VM's tables
 *   (tads/tads3 vmbift3.h, vmbiftad.h, vmbiftio.h, vmstr.cpp, vmlst.cpp).
 *
 *   It prints non-ASCII text (all of it below U+10000: the VM's strings
 *   hold 16-bit characters, and the compiler mis-encodes anything past), and for each line the player types it prints
 *   the line, its length in characters and its code points, so bench/
 *   check-tads.js can tell whether text crosses the Glk port intact:
 *     TIMED  reads a line with a 30 ms timeout, then (without printing,
 *            so the line is resumed) reads it again without one;
 *     QUIT   ends the game with a closing message.
 *
 *   Build (the native compiler, scratch only; see the README):
 *     t3make -nodef -nopre -o utf8.t3 utf8.t
 */

intrinsic 't3vm/010006'
{
    t3RunGC();
    t3SetSay(funcptr);
}

intrinsic 'tads-gen/030008'
{
    dataType(val);
    getArg(idx);
    firstObj(...);
    nextObj(obj, ...);
    randomize();
    rand(...);
    toString(val, ...);
}

intrinsic 'tads-io/030007'
{
    tadsSay(val, ...);
    setLogFile(fname, ...);
    clearScreen();
    morePrompt();
    inputLine();
    inputKey();
    inputEvent(...);
    inputDialog(icon, prompt, buttons, defaultButton, cancelButton);
    inputFile(prompt, dialogType, fileType, flags);
    timeDelay(delay);
    systemInfo(key, ...);
    statusMode(mode);
    statusRight(txt);
    resExists(fname);
    setScriptFile(fname, ...);
    getLocalCharSet(which);
    flushOutput();
    inputLineTimeout(...);
    inputLineCancel(reset);
}

intrinsic class Object 'root-object/030004' { }
intrinsic class TadsObject 'tads-object/030005': Object { }
intrinsic class String 'string/030008': Object
{
    /* tads3/vmstr.cpp, func_table_ entries 1-6 (0 is unused) */
    length();
    substr(start, len?);
    toUpper();
    toLower();
    find(str, index?);
    toUnicode(idx?);
}
intrinsic class List 'list/030008': Object
{
    subset(func);
    mapAll(func);
    length();
}

say(val) { tadsSay(val); }

/* "got [line] N: hex hex ..." */
describe(what, line)
{
    local u = line.toUnicode();
    say(what + ' [' + line + '] ' + toString(line.length()) + ':');
    for (local i = 1; i <= u.length(); i++)
        say(' ' + toString(u[i], 16));
    say('\n');
}

_main(args)
{
    t3SetSay(say);
    "Grüße aus Zürich: café, naïve, Ελληνικά, 日本語, ☕.\n";
    "Display charset <<getLocalCharSet(1)>>.\n";
    for (;;)
    {
        local line;
        "\b>";
        line = inputLine();
        if (line == nil || line == 'quit')
            break;
        if (line == 'timed')
        {
            local a = inputLineTimeout(30);
            local b = inputLineTimeout();
            "timed <<a[1]>> then <<b[1]>>\n";
            describe('first', a[2]);
            describe('then', b[2]);
        }
        else
            describe('got', line);
    }
    "Auf Wiedersehen — the end.\n";
}
