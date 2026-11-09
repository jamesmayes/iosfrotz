#charset "us-ascii"

/*
 *   The Silent Belfry: a small TADS 3 test game for the web interpreter
 *   (web/README.md, "TADS"). Written for this repo and placed in the public
 *   domain.
 *
 *   It uses no library: this repo has neither adv3 nor the TADS 3 system
 *   headers, so the intrinsic function sets and metaclasses are declared
 *   here, in the order of the tables in tads/tads3 (vmbift3.h, vmbiftad.h,
 *   vmbiftio.h). It has its own tiny parser, and every turn it does the
 *   kind of work a library does: it enumerates every object (firstObj /
 *   nextObj) to find what is in scope, matches the command with regular
 *   expressions, builds lists and strings, takes an undo savepoint and
 *   redraws the status line. It exercises SAVE (inputFile + saveGame),
 *   RESTORE (including a failed one, caught as a RuntimeError), UNDO, a
 *   dark room and a light source.
 *
 *   Build (the native compiler, scratch only; see the README; this tree's
 *   VM has no preinit, hence -nopre):
 *     t3make -nodef -nopre -o belfry.t3 belfry.t
 */

intrinsic 't3vm/010006'
{
    t3RunGC();
    t3SetSay(funcptr);
    t3GetVMVsn();
    t3GetVMID();
    t3GetVMBanner();
    t3GetVMPreinitMode();
    t3DebugTrace(mode, ...);
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
    max(val1, ...);
    min(val1, ...);
    makeString(val, ...);
    getFuncParams(func);
    toNumber(val, ...);
    tSprintf(fmt, ...);
    makeList(val, ...);
    abs(val);
    sgn(val);
    concat(...);
    rexSearchLast(pat, str, ...);
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
    /* tads3/vmlst.cpp, func_table_ entries 1-3 (0 is unused) */
    subset(func);
    mapAll(func);
    length();
}

/*
 *   The VM creates an instance of the exported RuntimeError class for a
 *   run-time error (tads3/vmrun.cpp), so a game can catch it; without the
 *   export it can only stop. RESTORE of a file that does not exist is
 *   caught that way below, which exercises the VM's error path (err_throw,
 *   a longjmp) under ASYNCIFY.
 */
class RuntimeError: object
    construct(errno, ...) { errno_ = errno; }
    errno_ = 0
    exceptionMessage = ''
;
export RuntimeError 'RuntimeError';
export exceptionMessage 'exceptionMessage';

/* ---- The world ---- */

class Thing: object
    name = ''
    vocab = ''
    location = nil
    portable = nil
    lightSource = nil
    desc = "You see nothing special about <<theName>>. "
    theName = ('the ' + name)
    aName = ('a ' + name)
;

class Room: object
    name = ''
    desc = ""
    dark = nil
    north = nil
    south = nil
    east = nil
    west = nil
    up = nil
    down = nil
;

me: object
    location = square
    score = 0
    turns = 0
    rang = nil
;

square: Room
    name = 'Village Square'
    desc = "A cobbled square under a grey sky. The church door is north,
        and the inn is to the east. "
    north = nave
    east = inn
;

inn: Room
    name = 'The Bell Inn'
    desc = "A smoky taproom. The square is back to the west. "
    west = square
;

nave: Room
    name = 'Nave'
    desc = "Cold pews in rows. The door to the square is south, a narrow
        stair climbs up to the belfry, and steps lead down to the crypt. "
    south = square
    up = belfry
    down = crypt
;

belfry: Room
    name = 'Belfry'
    desc = "Wind whistles through the louvres around the great bell. The
        stair goes down. "
    down = nave
;

crypt: Room
    name = 'Crypt'
    dark = true
    desc = "Low vaults and old stone. The steps lead up. "
    up = nave
;

lantern: Thing
    name = 'lantern'
    vocab = 'lantern'
    location = inn
    portable = true
    lit = nil
    lightSource = (lit)
    desc = "A brass lantern, <<lit ? 'burning' : 'unlit'>>. "
;

clapper: Thing
    name = 'iron clapper'
    aName = 'an iron clapper'
    vocab = 'clapper'
    location = crypt
    portable = true
    desc = "The bell's missing clapper, a heavy iron tongue. "
;

bell: Thing
    name = 'great bell'
    vocab = 'bell'
    location = belfry
    fixed = nil
    desc = "The great bell, <<fixed ? 'whole again' : 'without its clapper'>>. "
;

mug: Thing
    name = 'pewter mug'
    vocab = 'mug'
    location = inn
    portable = true
    desc = "A dented pewter mug. "
;

/* ---- Output ---- */

say(val)
{
    tadsSay(val);
}

/* ---- What the player can see (the library's scope work) ---- */

isLit(room)
{
    if (!room.dark)
        return true;
    for (local o = firstObj(Thing) ; o != nil ; o = nextObj(o, Thing))
    {
        if (o.lightSource && (o.location == room || o.location == me))
            return true;
    }
    return nil;
}

inScope()
{
    local lst = [];
    local lit = isLit(me.location);
    for (local o = firstObj(Thing) ; o != nil ; o = nextObj(o, Thing))
    {
        if (o.location == me || (lit && o.location == me.location))
            lst += o;
    }
    return lst;
}

findObj(word)
{
    local lst = inScope();
    for (local i = 1 ; i <= lst.length() ; i++)
    {
        if (lst[i].vocab == word)
            return lst[i];
    }
    return nil;
}

listHere()
{
    local here = [];
    for (local o = firstObj(Thing) ; o != nil ; o = nextObj(o, Thing))
    {
        if (o.location == me.location)
            here += o.aName;
    }
    if (here.length() > 0)
    {
        local s = 'You see ';
        for (local i = 1 ; i <= here.length() ; i++)
        {
            if (i > 1)
                s += (i == here.length() ? ' and ' : ', ');
            s += here[i];
        }
        "<<s>> here. ";
    }
}

look()
{
    local r = me.location;
    "\b<<r.name>>\n";
    if (!isLit(r))
    {
        "It is pitch dark. ";
        return;
    }
    r.desc;
    listHere();
}

showStatus()
{
    statusMode(1);
    tadsSay(me.location.name);
    statusMode(0);
    statusRight(toString(me.score) + '/' + toString(me.turns));
}

/* ---- Commands ---- */

go(dir)
{
    local dest = me.location.(dir);
    if (dest == nil)
    {
        "You can't go that way. ";
        return;
    }
    if (!isLit(me.location) && !isLit(dest))
    {
        "You stumble in the dark and think better of it. ";
        return;
    }
    me.location = dest;
    look();
}

award(n)
{
    me.score += n;
    "\b[Your score has gone up by <<n>>.]\n";
}

doSave()
{
    local r = inputFile('Save the game in', 2, 15, 0);
    if (r[1] != 0)
    {
        "Cancelled. ";
        return;
    }
    try
    {
        saveGame(r[2]);
    }
    catch (RuntimeError e)
    {
        "Save failed (error <<e.errno_>>). ";
        return;
    }
    "Saved. ";
}

doRestore()
{
    local r = inputFile('Restore the game from', 1, 15, 0);
    if (r[1] != 0)
    {
        "Cancelled. ";
        return;
    }
    try
    {
        restoreGame(r[2]);
    }
    catch (RuntimeError e)
    {
        "Restore failed (error <<e.errno_>>). ";
        return;
    }
    "Restored.\n";
    look();
}

command(verb, noun)
{
    local o;
    switch (verb)
    {
    case 'l':
    case 'look':
        look();
        return;
    case 'n': case 'north': go(&north); return;
    case 's': case 'south': go(&south); return;
    case 'e': case 'east': go(&east); return;
    case 'w': case 'west': go(&west); return;
    case 'u': case 'up': go(&up); return;
    case 'd': case 'down': go(&down); return;
    case 'i':
    case 'inventory':
        {
            local carried = [];
            for (o = firstObj(Thing) ; o != nil ; o = nextObj(o, Thing))
                if (o.location == me)
                    carried += o.name;
            if (carried.length() == 0)
                "You are empty-handed. ";
            else
            {
                "You are carrying: ";
                for (local i = 1 ; i <= carried.length() ; i++)
                    "<<i > 1 ? ', ' : ''>><<carried[i]>>";
                ". ";
            }
        }
        return;
    case 'z':
    case 'wait':
        "Time passes. ";
        return;
    case 'score':
        "Your score is <<me.score>> of 30, in <<me.turns>> turns. ";
        return;
    case 'save':
        doSave();
        return;
    case 'restore':
        doRestore();
        return;
    }

    if (noun == nil)
    {
        "I don't understand that. ";
        return;
    }
    o = findObj(noun);
    if (o == nil)
    {
        "You see no <<noun>> here. ";
        return;
    }
    switch (verb)
    {
    case 'x':
    case 'examine':
        o.desc;
        return;
    case 'take':
    case 'get':
        if (o.location == me)
            "You already have it. ";
        else if (!o.portable)
            "It won't budge. ";
        else
        {
            o.location = me;
            "Taken. ";
            if (o == clapper && !clapper.counted)
            {
                clapper.counted = true;
                award(5);
            }
        }
        return;
    case 'drop':
        if (o.location != me)
            "You aren't carrying it. ";
        else
        {
            o.location = me.location;
            "Dropped. ";
        }
        return;
    case 'light':
        if (o != lantern)
            "You can't light that. ";
        else if (lantern.lit)
            "It's already lit. ";
        else
        {
            lantern.lit = true;
            "The lantern glows warmly. ";
        }
        return;
    case 'fix':
        if (o != bell)
            "It isn't broken. ";
        else if (bell.fixed)
            "It's already whole. ";
        else if (clapper.location != me)
            "You have nothing to fix it with. ";
        else
        {
            bell.fixed = true;
            clapper.location = nil;
            "You hang the clapper back inside the bell. ";
            award(10);
        }
        return;
    case 'ring':
        if (o != bell)
            "It makes no sound. ";
        else if (!bell.fixed)
            "The bell swings silently. ";
        else
        {
            "BONG! The great bell rings out over the village. ";
            if (!me.rang)
            {
                me.rang = true;
                award(15);
                "\bThe belfry speaks again. (You may go on wandering.) ";
            }
        }
        return;
    }
    "I don't know how to <<verb>> anything. ";
}

modify clapper
    counted = nil
;

/* ---- The main loop ---- */

_main(args)
{
    t3SetSay(say);
    "\b\b\bThe Silent Belfry\nA small TADS 3 test game for the web
    interpreter. Public domain.\b";
    "The bell has been silent since the clapper went missing. Tonight it
    should ring.\b";
    look();
    for (;;)
    {
        local line;
        showStatus();
        "\b>";
        line = inputLine();
        if (line == nil)
            break;
        line = rexReplace('^<space>+|<space>+$', line, '', 1);
        if (line == '')
            continue;
        if (line == 'quit' || line == 'q')
            break;
        if (line == 'undo')
        {
            if (undo())
            {
                "(Undone.)\n";
                look();
            }
            else
                "There is nothing to undo. ";
            continue;
        }
        savepoint();
        me.turns++;
        if (rexMatch('(<alpha>+)(<space>+(<alpha>+))?', line) != nil)
        {
            local verb = rexGroup(1)[3];
            local g = rexGroup(3);
            command(verb, g == nil ? nil : g[3]);
        }
        else
            "I don't understand that. ";
    }
    "\bGoodbye.\n";
}
