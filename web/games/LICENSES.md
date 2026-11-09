# Licences for the bundled stories

Every story in this folder is listed here with its release, its source, the text of the permission that lets it be redistributed, and the notices that have to go with it. A story without all four is not shipped. See "Adding a story to the catalogue" in `../README.md`.

The Z-code catalogue is *Balances* only, and the Glulx catalogue (`glulx-stories.json`) is *Glulxercise* only. *Adventure* (Glulx) is held back until its permission is cleared; see "Available after clearance" below. The 20 other stories that the iOS app bundles from `resources/Games` were removed from the web client, because their redistribution terms have not been recorded for it. That is a hold on evidence, not a finding that their authors forbid it.

## Balances (`Balances.z5`)

*Balances*, by Graham Nelson, Release 5 / Serial number 961216, is one of the standard example games of Inform 6. The header of its source in the Inform 6 distribution says so: "Balances 160701 — One of the standard Inform 6 example games" ([`demos/balances.inf`](https://github.com/DavidGriffith/inform6unix/blob/master/demos/balances.inf) in `DavidGriffith/inform6unix`, checked at commit `5f2abd7`).

Inform 6, together with its example games, is available under the original Inform licence or the Artistic License 2.0, at the user's choice. The `licence.txt` in the Inform 6.34 compiler source (`if-archive/infocom/compilers/inform6/source/old/inform634_source.zip`) gives the original licence:

> Inform, the program and its source code, its example games and documentation, including the text and typography of this book, are copyright (C) Graham Nelson 1993, 94, 95, 96, 97, 98, 99, 2000, 01.
>
> The Inform software may be freely distributed provided that: (a) distributed copies are not substantially different from those archived by the author, (b) this and other copyright messages are always retained in full, and (c) no profit is involved. The same conditions apply to distribution or conversion of any electronic form of this book which may be made available by the author. Exceptions to these conditions must be negotiated directly with the author.

The `COPYING` file in `inform6unix` quotes the same permission from the *Inform Designer's Manual*, 4th edition: Nelson is "happy for it to be freely distributed to anybody who wants a copy", on the same three conditions. It adds that "a story file produced with the Inform compiler (and libraries) then belongs to its author", so the story file is Nelson's own work as well as an example game.

How this copy meets the three conditions:

- **(a) Unchanged.** SHA-256 `10e717578f85200c6aadc8149d95e43f7b6c09fb473770d309a0d6afe3b29538`. This is identical to `resources/Games/Balances.z5` and to the IF Archive's copy, `if-archive/games/zcode/Balances.z5` (checked 2026-11-08).
- **(b) Copyright messages kept.** The story's own banner ("Copyright (c) 1994, 1995, 1996 by Graham Nelson.") is part of the file, and it is printed at the start of play. The notice above is kept here as well.
- **(c) No profit.** Web Frotz is distributed free of charge. This condition has to hold wherever the client is hosted.

Inform software, its example games included, is supplied "as is" and carries no warranty, actual or implied.

## Glulxercise (`glulxercise.ulx`, Glulx)

The Glulx client (`../glulx.html`) catalogues this file through `glulx-stories.json`. It is Andrew Plotkin's unit test for Glulx interpreters, not a game: it offers named tests, and `all` runs every one.

- **Release.** *Glulxercise*, "A Glulx interpreter unit test", Release 13 / Serial number 241202, compiled with Inform 6.43 (the banner reads "Release 13 / Serial number 241202 / Inform v6.43, compiler options S"; the same release and serial are in the file's header). SHA-256 `b732127fee4cb266a5330981c1111fdfaba237134525754e063e6dc5f449b348`, 231,680 bytes.
- **Source.** `unittests/glulxercise.ulx` in Plotkin's [`erkyrath/glk-dev`](https://github.com/erkyrath/glk-dev) repository, at commit `a1f45c58d1b2be3555f53d293ce9ff953c59f413` (2024-12-02, "Version number."), the latest commit that touches the file. Downloaded on 2026-11-08 twice, through the GitHub API and from `raw.githubusercontent.com`; both copies were byte-identical to the file here.
- **Permission.** The source, `unittests/glulxercise.inf` at the same commit (Release 13, Serial "241202"), says: "Written by Andrew Plotkin (erkyrath@eblong.com). This unit test suite, and its functions, are in the public domain." The same statement heads `src/glulxercise.inf` in Plotkin's `erkyrath/Inform6-Testing`.
- **Notices.** None are required for a public-domain work. The author and source are recorded here anyway.
- **One thing to know.** Under the benchmark harness (which pins the clock git seeds its random-number generator from), `all` reports "2 tests failed overall: random (2)". These are the statistical checks on git's random-number generator (bit balance of `random 0`); the test itself says such checks "may, very occasionally, fail through sheer bad luck". Every other test passes under the web Glk. In Safari, with a real clock, `all` ended "All tests passed." (2026-11-08).

## Available after clearance

These Glulx stories are not shipped in `web/`. Each needs a recorded decision before it is added to `glulx-stories.json`.

### Adventure (`Advent.ulx`) — condition (a) unconfirmed; James decides

- **Release.** *Adventure* ("Colossal Cave"), the original 350-point game by Will Crowther and Don Woods, reconstructed by Donald Ekman, David M. Baggett and Graham Nelson. Inform port by Graham Nelson, Release 5 / Serial number 961209, compiled for Glulx by Andrew Plotkin (the banner reads "Inform v6.21(G0.33) Library 6/10"). SHA-256 `264236f2c3504eb2f326ab560aef435902d357c1ef848127b6ea0329c10387f8`.
- **Source.** <https://ifarchive.org/if-archive/games/glulx/advent.ulx>, downloaded on 2026-11-08 (twice, byte-identical). The archive's index describes it as "Adventure aka Colossal Cave, the original 350 points version ported to Inform by Graham Nelson, based on Dave Baggett's TADS reconstruction 'Colossal Cave Revisited', and compiled under Glulx Inform by Andrew Plotkin. Release 5 / Serial number 961209."
- **Permission, and what is not settled.** *Advent* is one of the standard Inform 6 example games ([`demos/advent.inf`](https://github.com/DavidGriffith/inform6unix/blob/master/demos/advent.inf): "A classic and one of the standard Inform 6 example games"), so the original Inform licence quoted for *Balances* covers it, on condition that "(a) distributed copies are not substantially different from those archived by the author". This file was archived by Andrew Plotkin, as his Glulx compile of the example game, not by Graham Nelson. **Whether it meets condition (a) is unconfirmed.** It is the same game and release as Nelson's Z-code *Advent*, compiled for another virtual machine, but no text from Nelson or Plotkin says that such a compile counts. This is James's decision (Ganglion need `iosfrotz-web-catalogue`, whose recommended default is to ship only what is cleared).
- **Where it is now.** The benchmark still plays it, from `../bench/local/Advent.ulx`, which is ignored by git: download it from the URL above and check the SHA-256 (see `../README.md`, "Measurement"). Conditions (b) and (c) would be met as for *Balances*: the story prints its own credits at the start of play, the Inform notice is kept in this file, and the client is free of charge.

`../../git/test/Alabaster.gblorb`, which the benchmark also plays, stays in `git/test/`, where the Git distribution ships it as its test case. It is not copied into `web/` or offered in the client.
