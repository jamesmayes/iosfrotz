#charset "us-ascii"

/*
 *   ASYNCIFY stress game for TADS 3 (web/README.md, "ASYNCIFY for TADS").
 *   Written for this repo and distributed under the repo's licence, the GNU
 *   General Public License, version 2 (COPYING at the top of the repo).
 *   Like belfry.t it
 *   uses no library and declares the intrinsics itself, in the order of the
 *   VM's tables (tads/tads3 vmbift3.h, vmbiftad.h, vmbiftio.h, vmlst.cpp).
 *
 *   Every command waits for the player, or opens a /saves file, from a
 *   different kind of frame: a builtin (inputLine, inputKey, inputEvent with
 *   a timer, morePrompt, timeDelay, inputDialog, inputFile), a native that
 *   calls back into bytecode (List.forEach, mapAll, subset nested in
 *   forEach, indexWhich, sort with a comparator, rexReplace with a
 *   function), an overloaded operator, a method, saveGame inside a
 *   callback, and a run-time error caught after an input in a callback.
 *   make asyncify-lists plays it to find the frames an unwind goes through;
 *   make asyncify-check plays it on the ASYNCIFY_ONLY build with ASYNCIFY
 *   assertions.
 *
 *   Build (the native compiler, scratch only; see the README):
 *     t3make -nodef -nopre -o stress3.t3 stress3.t
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
    restartGame();
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
    valWhich(cond);
    lastIndexOf(val);
    lastIndexWhich(cond);
    lastValWhich(cond);
    countOf(val);
    countWhich(cond);
    getUnique();
    appendUnique(other);
    append(val);
    sort(descending?, comparator?);
}

class RuntimeError: object
    construct(errno, ...) { errno_ = errno; }
    errno_ = 0
    exceptionMessage = ''
;
export RuntimeError 'RuntimeError';
export exceptionMessage 'exceptionMessage';

say(val) { tadsSay(val); }

class Adder: object
    v = 0
    operator +(x) { "(operator + asks) "; return toInteger(inputLine()) + x; }
;

class Ask: object
    prop1 { "(property asks) "; return inputLine(); }
;

_main(args)
{
    t3SetSay(say);
    "Stress 3\n";
    for (;;)
    {
        local line;
        "\b>";
        line = inputLine();
        if (line == nil || line == 'quit')
            break;
        if (line == 'each')
            [1, 2].forEach({x: say('each <<x>> got ' + inputLine() + '\n')});
        else if (line == 'map')
        {
            local l = [1, 2].mapAll({x: inputLine()});
            "map got <<l[1]>> and <<l[2]>>\n";
        }
        else if (line == 'nest')
        {
            [1, 2].forEach({x: [3].subset({y: say('nest <<x>> <<y>> key '
                + inputKey() + '\n')})});
        }
        else if (line == 'sort')
        {
            local l = [3, 1, 2].sort(nil, {a, b: say('cmp ' + inputLine()
                + '\n') , a - b});
            "sorted <<l[1]>><<l[2]>><<l[3]>>\n";
        }
        else if (line == 'which')
            "which <<[5, 6, 7].indexWhich({x: inputLine() == 'y'})>>\n";
        else if (line == 'key')
            "key <<inputKey()>>\n";
        else if (line == 'event')
        {
            local e = inputEvent(30);
            "event <<e[1]>>\n";
        }
        else if (line == 'more')
        {
            morePrompt();
            "after more\n";
        }
        else if (line == 'delay')
        {
            timeDelay(20);
            "after delay\n";
        }
        else if (line == 'op')
        {
            local a = new Adder();
            "op <<a + 1>>\n";
        }
        else if (line == 'prop')
        {
            local q = new Ask();
            "prop <<q.prop1>>\n";
        }
        else if (line == 'rex')
            "rex <<rexReplace('b', 'abc', {m, i, o: inputLine()}, 1)>>\n";
        else if (line == 'dialog')
            "dialog <<inputDialog(2, 'Really?', ['Yes', 'No'], 1, 2)>>\n";
        else if (line == 'save')
        {
            local r = inputFile('Save to', 2, 15, 0);
            if (r[1] == 0)
            {
                saveGame(r[2]);
                "saved\n";
            }
        }
        else if (line == 'savecb')
        {
            [1].forEach({x: saveGame('/saves/cb.glksave')});
            "saved in callback\n";
        }
        else if (line == 'restore')
        {
            local r = inputFile('Restore from', 1, 15, 0);
            if (r[1] == 0)
            {
                try
                {
                    restoreGame(r[2]);
                    "restored\n";
                }
                catch (RuntimeError e)
                {
                    "restore failed <<e.errno_>>\n";
                }
            }
        }
        else if (line == 'errcb')
        {
            try
            {
                [1, 2].forEach({x: say('errcb ' + inputLine() + '\n'),
                    restoreGame('/saves/nonexistent.glksave')});
            }
            catch (RuntimeError e)
            {
                "errcb caught <<e.errno_>>\n";
            }
            "errcb then <<inputLine()>>\n";
        }
        else if (line == 'gc')
        {
            t3RunGC();
            "gc\n";
        }
        else
            "echo <<line>>\n";
    }
    "bye\n";
}
