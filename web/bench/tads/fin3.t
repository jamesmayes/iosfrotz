#charset "us-ascii"

/*
 *   ASYNCIFY finalizer stress game for TADS 3 (web/README.md, "ASYNCIFY for
 *   TADS"). Written for this repo and distributed under the repo's licence,
 *   the GNU General Public License, version 2 (COPYING at the top of the
 *   repo). Like stress3.t it uses no library and declares the intrinsics
 *   itself, in the order of the VM's tables.
 *
 *   A TADS 3 object with a finalizer ('Destructor', finalize below) runs it
 *   when the garbage collector finds it unreachable, from a recursive VM
 *   call under CVmObjTable::run_finalizers (tads/tads3/vmobj.cpp). The
 *   collector runs from t3RunGC, from saveGame and restoreGame, and from any
 *   allocation once enough have happened since the last pass
 *   (CVmObjTable::alloc_obj, gc_before_alloc): here from the bytecode loop
 *   (new, string concatenation, a list), from an intrinsic (toString) and
 *   from inside native list methods (mapAll, sublist). Each command drops
 *   finalizable objects and makes the collector run one way, and their
 *   finalizers wait for the player (inputLine, inputKey, inputEvent with a
 *   timer), save the game (a /saves file stored through the page, which
 *   awaits too), or raise an error after an input, which the VM drops.
 *
 *   make asyncify-lists plays fin3.walk to find the frames an unwind goes
 *   through; make asyncify-check plays it on the ASYNCIFY_ONLY build with
 *   ASYNCIFY assertions.
 *
 *   Build (the native compiler, scratch only; see the README):
 *     t3make -nodef -nopre -o fin3.t3 fin3.t
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

/* how many finalizers have run */
finDone: object
    n = 0
;

/* a finalizer for each kind of wait; 'how' picks it */
class Fin: object
    construct(how, tag) { how_ = how; tag_ = tag; }
    how_ = nil
    tag_ = ''
    finalize()
    {
        ++finDone.n;
        if (how_ == 'line')
            say('fin ' + tag_ + ' line ' + inputLine() + '\n');
        else if (how_ == 'key')
            say('fin ' + tag_ + ' key ' + inputKey() + '\n');
        else if (how_ == 'event')
        {
            local e = inputEvent(30);
            say('fin ' + tag_ + ' event ' + e[1] + '\n');
        }
        else if (how_ == 'file')
        {
            local r = inputFile('Fin file', 2, 15, 0);
            saveGame(r[2]);
            say('fin ' + tag_ + ' saved\n');
        }
        else if (how_ == 'err')
        {
            say('fin ' + tag_ + ' err ' + inputLine() + '\n');
            restoreGame('/saves/nonexistent.glksave');
        }
    }
;

/* make finalizable objects and drop them (they die with this frame) */
drop(how, tag)
{
    local a = new Fin(how, tag);
    a = nil;
}

/* allocate until n more finalizers have run, by one of several allocators */
churn(kind, n)
{
    local goal = finDone.n + n;
    local keep;
    for (local i = 0 ; i < 100000 && finDone.n < goal ; ++i)
    {
        if (kind == 'new')
            keep = new Fin(nil, '');
        else if (kind == 'str')
            keep = toString(i) + 'x';
        else if (kind == 'list')
            keep = [i, i + 1];
        else if (kind == 'map')
            keep = [i, i + 1].mapAll({x: x + 1});
        else
            keep = [i, i + 1, i + 2].sublist(2);
    }
    "churn <<kind>> <<finDone.n >= goal ? 'done' : 'gave up'>>\n";
}

_main(args)
{
    t3SetSay(say);
    "Fin 3\n";
    for (;;)
    {
        local line;
        "\b>";
        line = inputLine();
        if (line == nil || line == 'quit')
            break;
        if (line == 'gc')
        {
            drop('line', 'gc');
            t3RunGC();
            "gc\n";
        }
        else if (line == 'gckey')
        {
            drop('key', 'gckey');
            drop('event', 'gcevent');
            t3RunGC();
            "gc key\n";
        }
        else if (line == 'gcfile')
        {
            drop('file', 'gcfile');
            t3RunGC();
            "gc file\n";
        }
        else if (line == 'gcerr')
        {
            drop('err', 'gcerr');
            t3RunGC();
            "gc err then <<inputLine()>>\n";
        }
        else if (line == 'new' || line == 'str' || line == 'list'
                 || line == 'map' || line == 'sub')
        {
            drop('line', line);
            churn(line, 1);
        }
        else if (line == 'save')
        {
            drop('line', 'save');
            saveGame('/saves/fin.glksave');
            "saved\n";
        }
        else if (line == 'restore')
        {
            drop('line', 'restore');
            restoreGame('/saves/fin.glksave');
            "restored\n";
        }
        else
            "echo <<line>>\n";
    }
    "bye <<finDone.n>>\n";
}
