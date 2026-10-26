# QA guide: transcript to draft, timed (issue #27)

Copperleaf Marketing is an invented paid media agency (37.5 hour week, so a working day is 7.5 hours: a deliberate trap). The process is **Enquiry to signed client** (a pipeline). The two transcripts are messy on purpose. `ANSWER-KEY.md` lists what each planted item should become. **Do not open it until after the timed run.**

## Once, untimed

1. Already done on production (30 Sep 2026); skip unless you have reset it. Run `setup-workspace.sql` with `bash packages/db/scripts/db-sql.sh -f docs/extraction/qa/setup-workspace.sql` (`DATABASE_URL` set to the owner's connection string). It adds the workspace "Copperleaf Marketing (QA)" with slug `copperleaf-qa` and stops with an error if that slug exists. Every agency admin gets a membership.
2. Create an API token at `/settings/tokens` and connect Claude (see `docs/extraction/README.md`).
3. Run Claude **outside the repo**, so the answer key and the dry-run examples are out of its reach: Claude desktop with the skill body as Project instructions, or Claude Code in an empty folder with the `~/.claude/skills/extract-process` symlink.
4. Check that `list_workspaces` shows "Copperleaf Marketing (QA)".

## Timed run

1. Start the timer. Run `/extract-process` (or the Project) with `interview-1.txt`.
2. Review on the canvas at `/w/copperleaf-qa/p/<id>` and settle the checklist. Accept or reject on `/w/copperleaf-qa/suggestions`.
3. Publish. Record the split time.
4. Give it `interview-2.txt` as the same process. Check the process list still has one process and the draft shows a diff.
5. Settle and publish. Stop the timer.

Target: under 60 minutes in total.

## Judge against ANSWER-KEY.md

Pass or fail each:
- Quotes are verbatim and support the values (spot-check ten).
- Every uncited number has sensible reasoning.
- Unit conversions use 7.5 hours a day.
- Structure is right: one start, sensible steps, roles, branches summing to 1.
- Each planted conflict is flagged with the right range, and the perception-gap issues appear on `/w/copperleaf-qa/issues`.
- Interview 2 produced no new process and a correct diff.
- All planted suggestions arrived, nothing was applied live, and none of the traps were suggested.
- The summary has every section and the ledger is complete.

## Notes template

Post this to #27:

```
Total time: __ min (split after interview 1: __ min)
Friction points:
-
Wrong or missing items (against the key):
-
Criteria failed:
-
```

## Rerun

Run `reset-workspace.sql`, then `setup-workspace.sql` again.
