/*
 *   ASYNCIFY stress game for TADS 2 (web/README.md, "ASYNCIFY for TADS").
 *   Written for this repo and placed in the public domain; uses adv.t and
 *   std.t from tads/tads2 ("You may modify and use this file in any way you
 *   want").
 *
 *   Every verb waits for the player, or opens a /saves file, from a
 *   different kind of frame: a builtin (input, inputkey, inputevent with a
 *   timer, yorn, morePrompt, timeDelay), a method called from a verb, a
 *   recursive execCommand, a daemon and a fuse, SAVE/RESTORE of a named
 *   file, and a run-time error caught after an input. make asyncify-lists
 *   plays it to find the frames an unwind goes through; make asyncify-check
 *   plays it on the ASYNCIFY_ONLY build with ASYNCIFY assertions.
 *
 *   Build (the native compiler, scratch only; see the README):
 *     tadsc -i <tads/tads2> -o stress2.gam stress2.t
 */

#include <adv.t>
#include <std.t>

askDaemon: function;
askFuse: function;

startroom: room
    sdesc = "Test Room"
    ldesc = "A bare room for testing. "
;

asker: object
    ask = { local s; "(method asks) "; s := input(); return s; }
    deeper = { return self.ask; }
;

askDaemon: function(parm)
{
    local s;
    "(daemon asks) ";
    s := input();
    "daemon got <<s>>\n";
    remdaemon(askDaemon, nil);
}

askFuse: function(parm)
{
    local s;
    "(fuse asks) ";
    s := input();
    "fuse got <<s>>\n";
}

lineVerb: deepverb
    verb = 'line'
    sdesc = "line"
    action(actor) = { local s; "Type a line: "; s := input(); "line got <<s>>\n"; }
;

keyVerb: deepverb
    verb = 'key'
    sdesc = "key"
    action(actor) = { local k; k := inputkey(); "key got [<<k>>]\n"; }
;

eventVerb: deepverb
    verb = 'event'
    sdesc = "event"
    action(actor) = { local e; e := inputevent(30); "event type <<e[1]>>\n"; }
;

ynVerb: deepverb
    verb = 'yn'
    sdesc = "yn"
    action(actor) = { "Yes or no? "; "yn got <<yorn()>>\n"; }
;

moreVerb: deepverb
    verb = 'more'
    sdesc = "more"
    action(actor) = { morePrompt(); "after more\n"; }
;

delayVerb: deepverb
    verb = 'delay'
    sdesc = "delay"
    action(actor) = { timeDelay(20); "after delay\n"; }
;

methodVerb: deepverb
    verb = 'method'
    sdesc = "method"
    action(actor) = { "method got <<asker.deeper>>\n"; }
;

execVerb: deepverb
    verb = 'exec'
    sdesc = "exec"
    action(actor) = { "exec returns <<execCommand(actor, lineVerb)>>\n"; }
;

daemonVerb: deepverb
    verb = 'daemon'
    sdesc = "daemon"
    action(actor) = { setdaemon(askDaemon, nil); "daemon set\n"; }
;

fuseVerb: deepverb
    verb = 'fuse'
    sdesc = "fuse"
    action(actor) = { setfuse(askFuse, 1, nil); "fuse set\n"; }
;

saveNamedVerb: deepverb
    verb = 'savenamed'
    sdesc = "savenamed"
    action(actor) = { "save returns <<save('/saves/stress2.glksave')>>\n"; }
;

restoreNamedVerb: deepverb
    verb = 'restorenamed'
    sdesc = "restorenamed"
    action(actor) = { "restore returns <<restore('/saves/stress2.glksave')>>\n"; }
;

errVerb: deepverb
    verb = 'err'
    sdesc = "err"
    action(actor) = { local s; "Type: "; s := input(); "err got <<s>>\n"; s := 1 + 'a'; }
;
