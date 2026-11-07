# 23. The company map drives the run

Date: 7 Nov 2026 · Status: accepted · D51 (amends D50) · `docs/plans/capacity/q17-company-map-run-brief.md`; amends 0014's "the company map is a picture"

## Context

Today the run is built from one bundle (`toEngineModel`): the workspace's first top-level process as the sales pipeline (`pipelineOf`),
the processes its holder steps link to (`heldProcesses`), and every live servicing process, run for the clients of each service it is
linked to (`engineServicing`, through `service_servicing`). The company map (`processes.is_company`: one card, a `subprocess` holder step,
per top-level process; edges as hand-off lines) is drawn only, and `toEngineModel` refuses it. The database keeps the live map in step with
the processes: every new top-level process gets a card and a line to or from each card of the other kind (`company_add_holder`), in a
system-made version. Since B12 a person can take a card off in a draft and publish, and can draw any line.

D51: the processes on a company map version are what is simulated, and its lines route work between them.

## Decision

### 1. Which processes run

The cards of the chosen revision, at their processes' live revisions (with Q16's swaps on top, section 4), and the child processes those
processes hold, as today. A map version never brings back an earlier version of a process: an earlier map is which processes and which
lines, not what they were then.

- **The sales pipeline** (where leads arrive) is the first pipeline card, in the workspace's process order (the order that picks today's
  pipeline), that no line from another pipeline card leads into. Other pipeline cards run only when a line hands work into them (section 2);
  one with no line in is on the map but not simulated, as today. No pipeline card left: the run can't start ("The company map has no sales
  pipeline on it. Add one to simulate the business."), as today's "publish a pipeline process".
- **A servicing card** runs for its services' clients through its service links, as today. Lines into a servicing card don't change the
  run: servicing runs for every client of the service, existing ones included, not only after a win, so a line can't say when it starts.
- **Not on the map, or not runnable**, each a note in the Sandbox under the map (plain words), and the run goes on without it:
  - a servicing process linked to a service but not on the map: excluded. "'Monthly reporting' is linked to Organic Tier 1 but isn't on
    this company map, so its work isn't simulated." The service still runs (clients, fees, churn); only that process's tasks go.
  - today's pipeline not on the map: the next pipeline card by the rule above runs. "'Sales' isn't on this company map."
  - a card whose process was never published or is archived: "'Renewals' has no published version, so it isn't simulated."
  - a servicing card with no service link: "Nothing starts 'Audit': it isn't linked to a service."
  - a service that enters a process other than the sales pipeline (`entry_process_id`): no arrivals, as today; named in a note.

### 2. What a line means in the engine

| Line | Meaning | Engine |
|---|---|---|
| Sales pipeline (or a process it hands to) to a **pipeline** card, e.g. Onboarding | Each won client carries on into that process. | Each `won` end of the from-process (the won sink and any other won end) gets `EngineEnd.handoff` = the to-process's entry; its graph is resolved as a held child's is (`resolveGraph`) and its steps join the model. A chain (Sales, Onboarding, Delivery) hands each process's `done` ends on the same way. Supported today (`enterTarget`: reach the end, then `enter(handoff)`); `flattenModel` maps hand-offs into groups. |
| Pipeline to **servicing** card | Drawn only (the default wiring). | None: service links run it. |

Lines the engine can't honour, each a note and left out of the run:
- **Two or more lines out of one process to pipeline cards** (a fork): a hand-off has one target. The run follows the first by process order:
  "'Sales' hands on to 'Onboarding' and 'Delivery'. The run follows only 'Onboarding'."
- **A line's share** below 100% or a condition tag on a company line: the hand-off takes every won client. "The 60% on the line to
  'Onboarding' isn't used: every won client goes through it."
- **A line out of a servicing card**: a servicing task ends in its own process and books nothing ("Work handed on from 'Monthly
  reporting' isn't simulated.").
- **A line into the sales pipeline**, a line from a card that doesn't run, and a line to or from a group of cards: drawn only.
- **A loop** of hand-offs (Onboarding back to Sales, or A to B to A): the line that closes it is left out, named in a note.
- **A lost end in a handed-to process** doesn't lose the client: a win sticks in the engine (`reachEnd`). Its ends are mapped as `done`;
  the note names a handed-to process with a lost end once.

Consequences in the numbers, said in the help: a won client is won at the sales pipeline's won end, so cycle time stops there; work in a
handed-to process is after the sale (its steps are after-sale for purposes, which `resolveAll` must be told, since `afterSaleSteps` reads
only won-or-lost reach).

### 3. Equality with today

- **By construction.** The map is applied to the bundle, not the model: `companyBundle(bundle, companyPart, parts)` returns the bundle
  rooted at the map's sales pipeline, with `otherProcesses` cut to the map's processes and their children (kept in today's order, the
  handed-to pipelines after), and an optional `handoffs` list that `toEngineModel` reads (absent: the code path is not taken). For a map that
  holds every process today's run uses, with no pipeline-to-pipeline line, the bundle comes back with the same root, the same
  `otherProcesses` and no `handoffs`, so `toEngineModel` gives the same model, deep-equal. The system-made map is always such a map.
- **Proof.** `engine-model-snapshot.test.ts` gains, for Northbeam and Larkspur and every variant (plain, planned, purposes, payHidden,
  noGroups), the model through `companyEngineModel` with `defaultCompanyPart` of the bundle's processes, compared with the saved snapshot
  entry of the same variant (no new keys: the snapshot file doesn't change). A database test does the same for the example workspace
  (`capacity:example`) and for the seeded workspaces through the loader, with the stored, backfilled map. Goldens run unapproved;
  `ENGINE_VERSION` stays (section 6).
- **A live map that a person already changed** (published before Q17 with a card taken off or a pipeline-to-pipeline line) would move a
  run nobody touched. So **the live map drives the run only once a person publishes a company map version after Q17**. One column,
  `processes.map_drives_run boolean not null default true` (company map rows only; migration `20270134000000`), backfilled `false` for a
  workspace any of whose company map versions a person published (`published_by` not null), and set `true` by a trigger when a person
  publishes a company map version (system-made versions leave it). Until then the live run is today's, and the Sandbox, on the live map,
  says how the map differs: "The live company map leaves out 'Audit'. The run still includes it until a company map version is published."
  A workspace whose map only the system made gets `true`: its map run is today's run anyway. The draft and earlier versions, chosen in the
  Sandbox, always run from their map.

### 4. Process versions on top

Q16's per-process versions (a solution from a month, E6) still go through `withSolution` on the bundle. On the company bundle every process
on the map is the root or in `otherProcesses`, so a swap applies to any of them, handed-to pipelines included. A version of a process not on
the chosen map is skipped with the existing problem ("changes a process the forecast doesn't run", reworded: "'X' isn't on this company map,
so its version isn't used."). The Sandbox lists processes to swap from the company bundle, not from `live`.

### 5. Where it's used

- **One entry**, `companyEngineModel(companyPart, bundle, parts, options)` = `toEngineModel(companyBundle(...).bundle)` with the notes.
  `parts` is `loadLiveParts` (every live process), which the Sandbox already loads.
- **The Sandbox.** The "Company map" select runs: the live map (default), the open draft (an unpublished map can be tested) or an earlier
  version. Today's path stays the live map; another map version is part of the changed path, in its run key, so the verdict and charts show
  what the map change does. The note under the select loses "the run is the same"; it shows the section 1 and 2 notes.
- **Capacity, the Overview and everything else that runs the company** (`loadLiveProcess`: issues, solutions' verdicts, Set up, MCP) get the
  live map through the loader: when `map_drives_run`, the default bundle (no process id) is built with `companyBundle` and the live map, so they
  read the same as the Sandbox's default. A process page (a bundle opened by process id, its draft included) is unchanged: it simulates the
  process in view as today. Share links' snapshots build their bundle through the same function.
- **No "One process" scope** (D50 amended): nothing for it is built; phase 2 checks no `?scope=`/`?process=` handling or UI remains.

### 6. The engine

No change for what runs: hand-offs from won and done ends, into a process's entry or a group, exist and are tested (`hourly.test.ts`,
`services.test.ts`). One gap: the Sandbox's "Win new clients" (`wonClients`) puts an injected client at the first after-sale step, or makes
it won at once when the pipeline has none, so it would skip a handed-to Onboarding. Proposed fix: when there is no after-sale step and the
won sink's end has a `handoff`, the injected client enters there. It reads only the existing optional `EngineEnd.handoff` on the won sink,
which no model from the database carries today and no golden carries: unset, nothing changes, no stream moves. It is pinned by a test in
`won-clients.test.ts`, not a new golden, and needs no bump by P7's precedent (an optional input no golden uses); if a bump is wanted,
`golden:approve --bump`. Without it, the Sandbox notes that added clients skip the handed-to process.

## Risks

- **The loader seam.** Every company run must come through `companyBundle` once the flag is on, or two screens disagree. Mitigation: the
  loader does it (`loadProcessBySlug` default, share-link and MCP bundles), and a test asserts Capacity's and the Sandbox's default models
  are equal for a map-driven workspace with a card taken off.
- **The flag.** A person's publish flips it, for good; restore of an old version by a person counts as a publish. The help says that from
  then on the map decides what is simulated.
- **Meaning shifts** when someone moves onboarding into its own process: cycle time stops at the win, and a lost end there loses no one.
- **Forks and shares** are the obvious next ask; they need a routing step the engine doesn't have.
- **Purposes**: handed-to steps must count as after the sale, or their default purposes differ from the same steps inside the pipeline.
