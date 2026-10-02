# OBSOLETE - do not paste these into Apps Script

> **`Code.gs` in this folder has been overwritten with the complete backend**
> (1,324 lines, ends in `}`) so it can be copied straight into the Apps Script
> editor. The other five files (`WebApp.gs`, `Sessions.gs`, `Registration.gs`,
> `Jobs.gs`, `Support.gs`) are stale split fragments - **do not paste them**;
> the complete `Code.gs` already contains everything they define.

These six `.gs` files were the split form of the **superseded** ~2,410-line backend
(`_backup/Code.gs.monolith.bak`). The live backend is a single file:

    src/apps-script/Code.gs        <- the ONLY file that goes in the editor's Code.gs
    src/apps-script/appsscript.json <- goes in a SEPARATE box (Project Settings -> Show appsscript.json)

## Why this folder is a trap

The split exists because the editor truncates large pastes. That only works when **all six
files are present in the project**, because Apps Script merges every `.gs` into one global
scope. Pasting `Code.gs` from here on its own leaves every helper its siblings define
undefined, so a run fails immediately with:

```
ReferenceError: currentSchemaVersion_ is not defined
writeNotesTab_ @ Code.gs:474
setupDatabase  @ Code.gs:295
```

(`currentSchemaVersion_` lives in `Support.gs` - file 6 of 6.)

The same six files are also stale in substance: they predate the rewrite and do not
contain `productionNotes` in `emptyRecordTemplate_()` or the 49,000-character
`record_too_large` guard in `saveJob_()`.

## What to use instead

```powershell
npm run apps:ascii     # prints the authoritative line count for Code.gs
npm run apps:chunks    # rewrites src/apps-script/paste-chunks/ from Code.gs
```

Paste `part1.txt` ... `part4.txt` in order into **one** `Code.gs`, pressing Ctrl+End
between pastes. The generator verifies the parts rebuild `Code.gs` byte for byte, so a
truncated or stale set cannot go unnoticed.

`scripts/split-once.mjs` (the script that produced this folder) is a one-off for the older
generation: its section markers (`* 5B. APPLICATION`, `* 6. ACTIONS`, `* 8. SHEET ACCESS`)
no longer exist in `Code.gs`, so it now aborts with `Marker not found` rather than emitting
a split.
