/*
 *   Windows-1252 test for the TADS 2 web interpreter (web/README.md, "Text
 *   encoding"). Written for this repo and distributed under the repo's
 *   licence, the GNU General Public License, version 2 (COPYING at the top
 *   of the repo). It uses no library. This file is in Windows-1252, as
 *   TADS 2 games from Windows often are: it prints non-ASCII text, and for
 *   each line the player types it prints the line and its length in bytes,
 *   so bench/check-tads.js can tell whether text crosses the Glk port in
 *   the game's character set. QUIT ends it.
 *
 *   Build (the native compiler, scratch only; see the README):
 *     tadsc -o cp1252.gam cp1252.t
 */

/* The objects the compiler requires; init never reaches the parser. */
Me: object;
takeVerb: object;
againVerb: object;
strObj: object;
numObj: object;
pardon: function { }

init: function
{
    local s;
    "Café naïve, € 5, “quoted”.\n";
    while (true)
    {
        "\b>";
        s := input();
        if (s = 'quit')
            break;
        "got [<< s >>] << length(s) >> bytes\n";
    }
    "Fin — the end.\n";
    quit();
}
