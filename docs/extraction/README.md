# Interview transcripts and the process-file skill

Removed 28 Oct 2026 (docs/plans/cut-list.md item 5): the `extract-process` skill and the MCP flow that wrote a draft process, sources,
first principles and company suggestions through MCP. MCP is read-only now; Claude and ChatGPT only query.

To turn interviews into a process, use the `process-file` skill (`.claude/skills/process-file`). It writes `transpera-process/2` files that
you upload in the app (Processes -> Upload process). See [`docs/import/README.md`](../import/README.md).

What stays here is test material:

- `examples/tidewater`: two invented interviews (Tidewater Digital, Monthly client report). `docs/import/examples/tidewater-monthly-client-report.json`
  is the process file built from them, and `packages/db/test/process-file-skill-fixtures.test.ts` checks that every quote is word for word.
- `qa`: the Copperleaf Marketing (QA) interviews, their answer key and the scripts that set up and reset the QA workspace
  (`packages/mcp/test/db-qa-workspace.test.ts` runs them). The answer key was written for the MCP flow: its "suggestion" items are now
  facts to enter in the app by hand, and its tool payloads are history.
