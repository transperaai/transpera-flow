# Process files: from materials to an upload

The `process-file` skill turns a mix of materials (interview transcripts, rough process maps, SOPs, spreadsheets) into `transpera-process/2` JSON files, one per process. You run it in Claude, outside the app, then upload each file on the Processes page. The skill is [`.agents/skills/process-file/SKILL.md`](../../.agents/skills/process-file/SKILL.md). It does not use the MCP server or an API token. (The older MCP route, `extract-process`, is described in [`docs/extraction/README.md`](../extraction/README.md).)

| File | What it is |
|---|---|
| `transpera-process-2.schema.json` | The format. Field names, limits and the plain-words descriptions. |
| `transpera-process-2.example.json` | A small file with every section. |
| `transpera-process-1.*` | The older format. `/1` files still upload. |
| `examples/` | What the skill writes for the Tidewater and Copperleaf interviews (below). |

## Install

**Claude desktop (or claude.ai).**
1. Create a Project.
2. Paste the body of `SKILL.md` (everything after the frontmatter) into the Project instructions.
3. Attach `transpera-process-2.schema.json` and `transpera-process-2.example.json` to the Project knowledge. The skill names the schema as the source of field names.

**Claude Code.**
- Inside this repo: type `/process-file`, or describe the job ("turn these into process files"); the skill is linked at `.claude/skills/process-file`.
- Elsewhere: `ln -s <repo>/.agents/skills/process-file ~/.claude/skills/process-file`, and keep the repo (or a copy of the two schema files) reachable.

## Run it

1. Give it the materials: attach or paste them. A drawn map can be an image or a description.
2. It lists what it found (processes, people, numbers, conflicts between sources) and asks at most five blocking questions in one message. Answer them, or say "go" to take its stated defaults.
3. It writes one `.json` file per process, then a short summary: what was built, assumptions, conflicts between sources, **Missing for simulation**, what it left out, and open questions.

## Upload

1. In the app, open **Processes**, then **Upload process**, and choose a file (or drop it). Do this once per file.
2. The preview shows the counts per section (steps, sources, suggestions, proposals), the conflicts between your sources, the conflicts with your company's own values, any role to map, and the **Missing for simulation** list. Fix anything it quotes by asking Claude to correct the file, or edit the draft afterwards.
3. Create. Each file becomes a **draft**: nothing is live until you publish it. Company facts wait on **Suggestions** to accept or reject, as do the issues, and nothing is applied silently.
4. Fill the gaps (the open questions in the summary say which to ask first), place each draft with the library, then publish.

## The examples

`examples/` holds what the skill produces for two packs already in the repo, hand-written the way the skill would write them and kept as fixtures:

- `tidewater-monthly-client-report.json`: both Tidewater interviews (`docs/extraction/examples/tidewater`) as one servicing process.
- `copperleaf-enquiry-to-signed-client.json`: both Copperleaf QA interviews (`docs/extraction/qa/interview-1.txt`, `interview-2.txt`) as one pipeline.

The answers to the skill's blocking questions are assumed to be: a 40-hour week at Tidewater (8-hour day) and a 37.5-hour week at Copperleaf (7.5-hour day); the role titles, services and Kofi's surname from the company's own records.

They are tested twice. `packages/db/test/process-file-skill-fixtures.test.ts` checks that each validates against the schema and the checker, that every quote is word for word on the line at its time and said by that speaker, that every number has evidence or an assumed reason, and that the conflicts and gaps are the expected ones. `packages/mcp/test/postgrest-skill-fixtures.test.ts` uploads each over PostgREST as an editor (with `POSTGREST_URL` set; see "MCP end-to-end suites" in the root `README.md`) and checks the draft, the sources and their links, the pending suggestions and proposals, and that nothing company-level changed.
