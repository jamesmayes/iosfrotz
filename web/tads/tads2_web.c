/*
 * web/tads/tads2_web.c: startup for the TADS 2 interpreter (tads/tads2) on
 * the browser Glk.
 *
 * This plays the part of main_t2 in tads/t23run.cpp, the iOS app's
 * combined TADS 2/3 entry point, which this build does not use (it pulls in
 * TADS 3). The page writes the story into MEMFS and calls main() with its
 * path; the file must start with the TADS 2 signature, "TADS2 bin" and
 * LF CR ^Z. trdmain checks the rest of the header itself.
 */

#include <stdio.h>

#include "os.h"
#include "trd.h"
#include "glk.h"
#include "glk_web.h"
#include "tads_web.h"

int main(int argc, char **argv)
{
    char *args[3];
    int targc = 2;
    int stat;

    if (argc < 2) {
        fprintf(stderr, "usage: tads2 story.gam\n");
        return 1;
    }
    glkweb_init(argv[1]);
    tadsweb_validate(argv[1], "TADS2 bin\012\015\032", 12, "TADS 2");

    args[0] = "tads2";
    args[1] = argv[1];
    args[2] = NULL;

    os_init(&targc, args, 0, 0, 0);
    stat = trdmain(targc, args, NULL, NULL);
    os_uninit();
    /* Not os_term (tads/osglk.c): it closes the root window, which drops
       the text not yet handed to the page, and the browser Glk then takes
       every window off the page, the game's last words with them, and the
       page's end notice has nowhere to go. One game per instance, so there
       is nothing to tear down: hand over what is pending and stop, with the
       windows as the game left them. */
    glkweb_finish();
    return stat;
}
