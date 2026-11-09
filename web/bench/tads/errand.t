/*
 *   The Keeper's Errand: a small TADS 2 test game for the web interpreter
 *   (web/README.md, "TADS"). Written for this repo and distributed under
 *   the repo's licence, the GNU General Public License, version 2 (COPYING
 *   at the top of the repo). No other author's material is in it; it
 *   includes adv.t and std.t, which this repo ships in tads/tads2 and which
 *   keep their own notice (Copyright (c) 1988-2000 and 1989-2000 by Michael
 *   J. Roberts: "You may modify and use this file in any way you want,
 *   provided that if you redistribute modified copies of this file in
 *   source form, the copies must include the original copyright notice
 *   (including this paragraph), and must be clearly marked as modified from
 *   the original version"). They are used unmodified.
 *
 *   It exercises what a TADS 2 game asks of the Glk port: the status line
 *   (room name, score and turns), a fuse and a daemon, a dark room and a
 *   light source, a locked door and its key, an openable container, a
 *   custom verb, SAVE, RESTORE and UNDO, and PONDER, a CPU-bound turn for
 *   the measurement.
 *
 *   Build (the native compiler, scratch only; see the README):
 *     tadsc -i <tads/tads2> -o errand.gam errand.t
 */

#include <adv.t>
#include <std.t>

tideDaemon: function;
kettleFuse: function;

modify global
    maxscore = 40
    tide = 0
;

modify version
    sdesc = "\b\(The Keeper's Errand\)\nA small TADS 2 test game for the
             web interpreter. GNU General Public License, version 2;
             adv.t and std.t copyright (c) 1988-2000 by Michael J.
             Roberts.\n"
;

replace init: function
{
    commonInit();
    version.sdesc;
    "\bThe lighthouse keeper is ill in bed, and someone has to light the
    lamp before dark. That someone is you.\b";
    setdaemon(turncount, nil);
    setdaemon(tideDaemon, nil);
    parserGetMe().location := startroom;
    startroom.lookAround(true);
    startroom.isseen := true;
    scoreStatus(0, 0);
}

tideDaemon: function(parm)
{
    global.tide := global.tide + 1;
    if (global.tide = 10)
    {
        global.tide := 0;
        if (parserGetMe().location = beach)
            "\bA wave runs up the shingle and slides back. ";
    }
}

kettleFuse: function(parm)
{
    if (parserGetMe().location = startroom)
        "\bThe kettle on the stove begins to whistle. ";
    kettle.hot := true;
}

/* ---- Verbs ---- */

/*
 *   PONDER: a CPU-bound turn for the measurement (bench/measure.js --tads,
 *   errand-cpu.walk). It walks every object 300 times, as a library's scope
 *   and disambiguation work does, so the interpreter loop does real work
 *   between two inputs.
 */
ponderVerb: sysverb
    verb = 'ponder'
    sdesc = "ponder"
    action(actor) =
    {
        local i, o, n, s;
        n := 0;
        for (i := 1 ; i <= 300 ; i++)
        {
            o := firstobj();
            while (o <> nil)
            {
                if (isclass(o, item))
                    n := n + 1;
                o := nextobj(o);
            }
            s := cvtstr(i) + ':' + cvtstr(n);
        }
        "You think it over (<<n>>, <<s>>). ";
        abort;
    }
;

pourVerb: deepverb
    verb = 'pour' 'empty'
    sdesc = "pour"
    doAction = 'Pour'
    ioAction(inPrep) = 'PourIn'
;

/* ---- The kitchen ---- */

startroom: room
    sdesc = "Kitchen"
    ldesc = "A low stone kitchen, smelling of tar and tea. An iron stove
             squats in one corner, and an old dresser with a drawer stands
             against the wall. The back door leads north into the garden. "
    north = garden
    out = garden
;

stove: switchItem
    location = startroom
    noun = 'stove' 'range'
    adjective = 'iron'
    sdesc = "stove"
    ldesc = "An iron stove. It is <<self.isActive ? "lit" : "cold">>. "
    doTurnon(actor) =
    {
        inherited.doTurnon(actor);
        if (not kettle.hot)
            setfuse(kettleFuse, 3, nil);
    }
;

kettle: item
    location = startroom
    noun = 'kettle'
    adjective = 'copper' 'dented'
    sdesc = "kettle"
    hot = nil
    ldesc = "A dented copper kettle<<self.hot ? ", too hot to hold for long"
             : "">>. "
;

dresser: fixeditem
    location = startroom
    noun = 'dresser'
    adjective = 'old'
    sdesc = "dresser"
    ldesc = "A dresser of dark wood, with one drawer. "
;

drawer: fixeditem, openable
    location = startroom
    noun = 'drawer'
    sdesc = "drawer"
    isopen = nil
;

shedkey: keyItem
    location = drawer
    noun = 'key'
    adjective = 'iron' 'shed'
    sdesc = "iron key"
    adesc = "an iron key"
    ldesc = "A heavy iron key with a tag that says SHED. "
    doTake(actor) =
    {
        if (not self.counted)
        {
            self.counted := true;
            incscore(5);
        }
        inherited.doTake(actor);
    }
    counted = nil
;

/* ---- Outside ---- */

garden: room
    sdesc = "Garden"
    ldesc = "A walled garden of cabbages and sea-kale. The kitchen is south,
             a tarred shed stands to the east, and a gate opens north onto
             the lane. "
    south = startroom
    in = startroom
    north = lane
    east = shedDoor
;

shedDoor: lockableDoorway
    location = garden
    noun = 'door'
    adjective = 'shed' 'tarred'
    sdesc = "shed door"
    doordest = shed
    otherside = shedDoorIn
    mykey = shedkey
    doUnlockWith(actor, io) =
    {
        if (not self.counted)
        {
            self.counted := true;
            incscore(5);
        }
        inherited.doUnlockWith(actor, io);
    }
    counted = nil
;

shed: room
    sdesc = "Shed"
    ldesc = "A cramped shed full of nets and floats. The door is west. "
    west = shedDoorIn
    out = shedDoorIn
;

shedDoorIn: lockableDoorway
    location = shed
    noun = 'door'
    sdesc = "door"
    doordest = garden
    otherside = shedDoor
    mykey = shedkey
    islocked = nil
;

lantern: lightsource
    location = shed
    noun = 'lantern'
    adjective = 'storm' 'small'
    sdesc = "storm lantern"
    islit = nil
    ldesc = "A small storm lantern, <<self.islit ? "burning" : "unlit">>. "
    verDoTurnon(actor) = { if (self.islit) "It's already lit. "; }
    doTurnon(actor) = { self.islit := true; "The lantern flickers into life. "; }
    verDoTurnoff(actor) = { if (not self.islit) "It isn't lit. "; }
    doTurnoff(actor) = { self.islit := nil; "The lantern goes out. "; }
;

oilcan: item
    location = shed
    noun = 'can' 'oil'
    adjective = 'oil'
    sdesc = "oil can"
    adesc = "an oil can"
    full = true
    ldesc = "A tin can <<self.full ? "full of" : "that once held">> lamp
             oil. "
    verDoPour(actor) = { if (not self.full) "The can is empty. "; }
    doPour(actor) = { "You'd better pour it into something. "; }
;

lane: room
    sdesc = "Lane"
    ldesc = "A sandy lane between dunes. The garden gate is south; the lane
             runs north to the lighthouse and down east to the beach. "
    south = garden
    north = lighthouseBase
    east = beach
;

beach: room
    sdesc = "Beach"
    ldesc = "Grey shingle and a grey sea. The lane is west. "
    west = lane
    up = lane
;

shell: item
    location = beach
    noun = 'shell'
    adjective = 'white'
    sdesc = "white shell"
    ldesc = "A white whelk shell. "
;

lighthouseBase: room
    sdesc = "Foot of the Lighthouse"
    ldesc = "The lighthouse rises white above you. A spiral stair goes up
             into the dark; the lane is south. "
    south = lane
    up = lampRoom
;

lampRoom: darkroom
    sdesc = "Lamp Room"
    ldesc = "A glass room at the top of the tower, around the great lamp.
             The stair leads down. "
    down = lighthouseBase
;

greatLamp: fixeditem
    location = lampRoom
    noun = 'lamp' 'light'
    adjective = 'great'
    sdesc = "great lamp"
    oiled = nil
    lit = nil
    ldesc = "The great lamp, its wick <<self.oiled ? "soaked" : "dry">>
             <<self.lit ? "and burning brightly" : "">>. "
    ioPourIn(actor, dobj) = { dobj.doPourIn(actor, self); }
    verIoPourIn(actor) =
    {
        if (self.oiled) "It already has oil. ";
    }
    verDoTurnon(actor) =
    {
        if (self.lit) "It's already burning. ";
        else if (not self.oiled) "The wick is dry. ";
    }
    doTurnon(actor) =
    {
        self.lit := true;
        "The great lamp catches with a soft roar, and its beam swings out
        over the sea. ";
        incscore(25);
        "\bYou have done what you came to do. (You may go on wandering.) ";
    }
;

modify oilcan
    verDoPourIn(actor, io) =
    {
        if (not self.full) "The can is empty. ";
    }
    doPourIn(actor, io) =
    {
        if (io = greatLamp)
        {
            self.full := nil;
            greatLamp.oiled := true;
            "You fill the great lamp's reservoir. ";
            incscore(5);
        }
        else
            "That would only make a mess. ";
    }
;
