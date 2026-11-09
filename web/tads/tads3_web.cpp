/*
 * web/tads/tads3_web.cpp: startup for the TADS 3 interpreter (tads/tads3)
 * on the browser Glk.
 *
 * This plays the part of main_t3 in tads/t23run.cpp, the iOS app's combined
 * TADS 2/3 entry point, which this build does not use (it pulls in TADS 2).
 * The page writes the story into MEMFS and calls main() with its path; the
 * file must start with the T3 image signature, "T3-image" CR LF ^Z.
 * vm_run_image_main checks the rest of the image itself.
 */

#include <stdio.h>

#include "os.h"
#include "t3std.h"
#include "vmmain.h"
#include "vmmaincn.h"
#include "vmhostsi.h"

extern "C" {
#include "glk.h"
#include "glk_web.h"
}
#include "tads_web.h"

/* tads3/vmdict.cpp: iOS word completion reads the dictionaries only while
   a game runs (main_t3 sets it the same way). */
extern "C" void tads3_set_running(int running);

int main(int argc, char **argv)
{
    char *args[3];
    int targc = 2;
    int stat;

    if (argc < 2) {
        fprintf(stderr, "usage: tads3 story.t3\n");
        return 1;
    }
    glkweb_init(argv[1]);
    /* tads/osansi3.c names UTF-8 as the display and keyboard character
       set (os_get_charmap). */
    tadsweb_text_utf8(1);
    tadsweb_validate(argv[1], "T3-image\015\012\032", 11, "TADS 3");

    args[0] = (char *) "tads3";
    args[1] = argv[1];
    args[2] = NULL;

    {
        CVmMainClientConsole clientifc;
        CVmHostIfc *hostifc = new CVmHostIfcStdio(args[0]);

        os_init(&targc, args, 0, 0, 0);
        tads3_set_running(1);
        stat = vm_run_image_main(&clientifc, "t3run", targc, args,
                                 TRUE, FALSE, hostifc);
        tads3_set_running(0);
        os_uninit();
        delete hostifc;
    }
    os_term(stat);
    glkweb_finish();
    return stat;
}
