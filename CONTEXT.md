# Transpera Flow

A process-map simulator. A consultant maps a company's workflows, the engine simulates them, and the team acts on what it finds. Product spec: `docs/PRD.md`. Rating rules: `docs/analysis-rules.md`.

## Language

### Processes

**Process**:
A map of steps that work moves through, such as "Lead to cash". The company map is the top process, and every process can sit inside another.
_Avoid_: Workflow, flow, pipeline (a pipeline is one kind of process)

**Sub-process**:
A step that holds its own steps, as a group or a child process. Example: "Audit and proposal" opens into five smaller steps. The engine always simulates the small steps, so the numbers are the same open or closed.
_Avoid_: Child map. Say "child process" for a process that sits inside another, and "group" for a box of steps inside one process; "nested" describes how deep either goes, not a thing of its own.

**Group**:
A box of steps inside one process, opened or closed on the map. It has no hours, role or rework of its own; a closed group shows a roll-up of its steps (how many, total hands-on time, open issues, worst rating). Example: "Qualify" holding "Receive enquiry" and "Check fit".
_Avoid_: Folder, container, sub-process (that is a group or a child process)

**Company map**:
The workspace's top process, stored like any other (one per workspace). Each process on it is a card held by a link in its live version, at a stored position; a **handoff** is a line between two cards (a picture for now: the simulation ignores it). Placing a process on the map never edits that process. The engine never simulates the company map.
_Avoid_: Root process (in the UI), overview map

**Child process**:
A process that sits inside a step of another process, with its own page, versions and first principles. The company map is the root: its steps are the top-level processes. A process has one parent. Example: "Onboarding" inside the step "Onboarding" of "Lead to live".
_Avoid_: Sub-map, nested process

**Block**:
A saved group of steps that can be inserted into a process. Example: a "Send proposal and chase" block used in three processes. A block marked AI was made by the AI.
_Avoid_: Template, snippet, module

**Lever**:
A "what if" dial on a number, such as 25% more leads a week. It changes numbers, never steps.
_Avoid_: Slider, parameter, scenario

**First principles**:
Seven short answers for one process that separate hard truths from copied assumptions, and end in goals. Example: "Proposals take 3 days" is an assumption. "The client needs a price before they can decide" is a hard truth.
_Avoid_: Process charter, goals sheet

**Editor**:
The full-screen page, in its own colour, where a process's steps are changed. It edits a draft (or, later, a solution or a block), never the live map; **Publish** makes the draft the next live version and keeps the old one in History. The map is for reading only. Example: "Open the Editor, add a wait step after the discovery call, simulate it against live, then publish version 4."
_Avoid_: Edit mode, edit toggle

### Analysis

**Rating**:
One of four levels a rule gives a finding: Great, Good could improve, Bad not urgent, Operational risk. Example: a strategist busy 82% of the time rates Good could improve, and is raised to Operational risk if a bad month hits 97% and she is the bottleneck.
_Avoid_: Severity, priority, critical, warning

**Insight**:
A finding from a rule or from the AI, with a rating and a cost per month. It stays off the map until someone acknowledges it. Example: "Proposals wait 3 days for the strategist."
_Avoid_: Alert, detection, finding

**Issue**:
A problem the team has decided to own. It comes from an acknowledged insight or is logged by hand, and has owners, a target and a status. Example: "Leads go cold while waiting for a proposal", owned by the sales lead, target 60% won.
_Avoid_: Bug, ticket, risk

**Solution**:
A separate copy of a process with changed steps, plus optional lever changes, built to fix one or more issues. Example: a copy of "Lead to cash" where proposals are drafted by a template. A process can have many.
_Avoid_: Scenario, fix, what-if

**AI idea**:
A solution or issue the AI proposes, built from blocks. You Build it or Dismiss it. Example: "Swap manual proposal writing for the Proposal template block."
_Avoid_: AI suggestion (a suggestion is any pending change awaiting review)

**Suggestion**:
Any change waiting for a human decision, such as an AI idea or an AI edit to the company model.
_Avoid_: Proposal (a visitor's proposal arrives as a suggestion)

### Company model

**Client group**:
The clients of one service, counted but not named: how many, the fee, normal churn, typical stay and starting health. Example: "34 SEO clients paying $2,000 a month". A process whose services have clients counted simulates the groups, and named clients (Settings, Clients) are a record only there; any other process simulates the active named clients; a client who leaves is made inactive, never deleted (PRD D42).
_Avoid_: Client roster, client list, account
Not to be confused with a **group**, which is a box of steps inside a process (above): a group holds steps, a client group counts clients.

**Churn driver**:
A reason clients leave, with a weight and an on/off switch. Example: "Late work", responsible for 40% of the clients lost this year.
_Avoid_: Churn factor, churn cause

**Market condition**:
The outside climate for demand: a preset (Boom, Stable, Soft, Downturn) or your own, as a 24-month schedule. Example: a Downturn with 30% fewer leads from month 3.
_Avoid_: Economy, scenario, seasonality (seasonality is a separate monthly demand pattern)

## Relationships

- A **rule** turns a simulation number into a **rating**. Rules and the AI write **insights**.
- An acknowledged **insight** can become an **issue**. An **issue** can have many **solutions**, and one **solution** can solve many **issues**.
- A **solution** is a copy of a **process**. A **process** keeps one live version and at most one draft.
- **Client groups** and **churn drivers** set how clients leave. **Market conditions** set how many arrive.
