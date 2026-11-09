# Licences for the bundled stories

Every file in this folder is a byte-for-byte copy of the file with the same name in `resources/Games`, which the iOS app already bundles. This file records the redistribution permission for each story, where it has been found.

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

## The other stories

The other 20 stories, listed with their authors in `stories.json`, are bundled because the iOS app already redistributes them from `resources/Games`. Their individual redistribution terms have **not** been checked for this web client. Before the web client is published, each needs the same evidence as *Balances* above, or it should be removed from `games/` and `stories.json`.
