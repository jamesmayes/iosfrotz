#charset "us-ascii"

/*
 *   Open-file test for the TADS 3 web interpreter (web/README.md, "How
 *   TADS 2 is built", stdio files under /saves). Written for this repo and
 *   distributed under the repo's licence, the GNU General Public License,
 *   version 2 (COPYING at the top of the repo). Like belfry.t it uses no
 *   library and declares the intrinsics itself, in the order of the VM's
 *   tables (tads/tads3 vmbift3.h, vmbiftad.h, vmbiftio.h, vmfilobj.cpp).
 *
 *   Commands, for bench/check-tads.js:
 *     OPEN n   opens /saves/f1.txt ... fn.txt for writing, writes a line to
 *              each and keeps them open; says how many opened and where
 *              the first failure was;
 *     CLOSE    closes every file OPEN left open;
 *     SAVE     saves the game to /saves/files3.glksave (saveGame), and says
 *              whether it worked;
 *     QUIT     ends the game.
 *
 *   Build (the native compiler, scratch only; see the README):
 *     t3make -nodef -nopre -o files3.t3 files3.t
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
    toInteger(val, ...);
    getTime(...);
    rexMatch(pat, str, ...);
    rexSearch(pat, str, ...);
    rexGroup(groupNum);
    rexReplace(pat, str, replacement, ...);
    savepoint();
    undo();
    saveGame(filename, ...);
    restoreGame(filename);
}

intrinsic 'tads-io/030007'
{
    tadsSay(val, ...);
    setLogFile(fname, ...);
    clearScreen();
    morePrompt();
    inputLine();
}

intrinsic class Object 'root-object/030004' { }
intrinsic class TadsObject 'tads-object/030005': Object { }
intrinsic class String 'string/030008': Object { }
intrinsic class List 'list/030008': Object
{
    subset(func);
    mapAll(func);
    length();
    sublist(start, len?);
    intersect(other);
    indexOf(val);
    car();
    cdr();
    indexWhich(cond);
    forEach(func);
}
intrinsic class File 'file/030003': Object
{
    /* tads3/vmfilobj.cpp, func_table_ entries 1-8 (0 is unused) */
    static openTextFile(filename, access, charset?);
    static openDataFile(filename, access);
    static openRawFile(filename, access);
    getCharacterSet();
    setCharacterSet(charset);
    closeFile();
    readFile();
    writeFile(val);
}

class RuntimeError: object
    construct(errno, ...) { errno_ = errno; }
    errno_ = 0
    exceptionMessage = ''
;
export RuntimeError 'RuntimeError';
export exceptionMessage 'exceptionMessage';

say(val) { tadsSay(val); }

/* tads3/vmfilobj.h: VMOBJFILE_ACCESS_WRITE */
#define FileAccessWrite 2

_main(args)
{
    local open = [];
    t3SetSay(say);
    "Files 3\n";
    for (;;)
    {
        local line;
        "\b>";
        line = inputLine();
        if (line == nil || line == 'quit')
            break;
        if (rexMatch('open (<digit>+)$', line) != nil)
        {
            local n = toInteger(rexGroup(1)[3]);
            local first = nil;
            local opened = 0;
            for (local i = 1; i <= n; i++)
            {
                try
                {
                    local f = File.openTextFile('/saves/f' + toString(i)
                        + '.txt', FileAccessWrite);
                    f.writeFile('file ' + toString(i) + '\n');
                    open += f;
                    opened++;
                }
                catch (RuntimeError e)
                {
                    if (first == nil)
                        first = i;
                }
            }
            "opened <<opened>> of <<n>>, first failure <<first == nil ? 'none'
              : toString(first)>>\n";
        }
        else if (line == 'close')
        {
            local n = open.length();
            open.forEach({f: f.closeFile()});
            open = [];
            "closed <<n>>\n";
        }
        else if (line == 'save')
        {
            try
            {
                saveGame('/saves/files3.glksave');
                "saved\n";
            }
            catch (RuntimeError e)
            {
                "save failed <<e.errno_>>\n";
            }
        }
        else
            "?\n";
    }
    "bye\n";
}
