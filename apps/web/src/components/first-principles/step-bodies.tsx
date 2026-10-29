"use client";

// The seven steps of the first-principles flow (issue #119): what each one asks, as forms over the answers. Every
// control has an (i) in plain English with an example (docs/research/first-principles.md Part B has the method).

import {
  ownerProblem,
  SUCCESS_KPI_FORM,
  type FirstPrinciples,
  type FpContext,
  type FpDeleteCandidate,
  type FpImprovement,
  type FpMeasure,
  type FpRequirement,
  type FpStage,
  type FpStatement,
  type FpStepKey,
  type SuccessCheck,
  type SuccessKpi,
} from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { AddButton, Choice, ItemCard, NumberAnswer, PickAnswer, RemoveButton, TextAnswer } from "./fields";

export type Edit = (change: (doc: FirstPrinciples) => FirstPrinciples) => void;

interface BodyProps {
  doc: FirstPrinciples;
  edit: Edit;
  ctx: FpContext;
  disabled: boolean;
  checks: readonly SuccessCheck[];
}

/** Replace the item at `i` of a list. */
const setAt = <T,>(list: readonly T[], i: number, patch: Partial<T>): T[] => list.map((x, j) => (j === i ? { ...x, ...patch } : x));
const without = <T,>(list: readonly T[], i: number): T[] => list.filter((_, j) => j !== i);

/** The questions, the method behind each, and where it comes from (plain wording; see the research note). */
export const STEP_TEXT: Record<FpStepKey, { question: string; method: string }> = {
  job: {
    question: "Who does this process serve, what progress are they trying to make, and what does done look like?",
    method: "Jobs to be done (Christensen, HBR 2016)",
  },
  truths: {
    question: "What can't be argued away (law, contract, real capacity)? What is only habit or copied from others? Every truth needs a source; every assumption needs a test.",
    method: "Musk, TED 2013: “boil things down to their fundamental truths”",
  },
  reqs: {
    question: "List every rule the process follows. Each one needs a named person who owns it, not a team, and a reason. Then decide: keep, change, drop or challenge.",
    method: "Musk's algorithm, step 1: make the requirements less dumb",
  },
  del: {
    question: "Which steps could go? For each, what would break and who has to agree? Aim to delete enough that you might add one back.",
    method: "Musk's algorithm, step 2: delete the part or process",
  },
  saa: {
    question: "Only after deleting. Simplify what is left, then speed it up, then automate. In that order.",
    method: "Musk's algorithm, steps 3 to 5",
  },
  why: {
    question: "Name the biggest problem, then ask why until you reach a cause in the process, not a person.",
    method: "Toyota's 5 Whys (Ohno, 1978)",
  },
  measures: {
    question: "Two to four measures, each tied to a number the simulation produces, with a target and a time horizon.",
    method: "Checked against every simulation run",
  },
};

const stepOptions = (ctx: FpContext, none: string) => [{ value: "", label: none }, ...ctx.steps.map((s) => ({ value: s.id, label: s.name }))];
const personOptions = (ctx: FpContext, none: string) => [{ value: "", label: none }, ...ctx.people.map((p) => ({ value: p.id, label: p.name }))];

export function StepBody({ step, ...p }: BodyProps & { step: FpStepKey }) {
  switch (step) {
    case "job":
      return <JobStep {...p} />;
    case "truths":
      return <TruthsStep {...p} />;
    case "reqs":
      return <RequirementsStep {...p} />;
    case "del":
      return <DeleteStep {...p} />;
    case "saa":
      return <ImproveStep {...p} />;
    case "why":
      return <WhyStep {...p} />;
    case "measures":
      return <MeasuresStep {...p} />;
  }
}

// 1. The job -----------------------------------------------------------------------------------------------------

function JobStep({ doc, edit, disabled }: BodyProps) {
  const set = (patch: Partial<FirstPrinciples["job"]>) => edit((d) => ({ ...d, job: { ...d.job, ...patch } }));
  return (
    <div className="flex flex-col gap-3">
      <TextAnswer
        label="Who it serves"
        help={{
          description: "The customer this process is for: the kind of person or business that ends up on the other side of it.",
          example: "Owners of 5 to 20 person businesses whose own marketing has stalled.",
        }}
        value={doc.job.who}
        disabled={disabled}
        missing={!doc.job.who.trim()}
        placeholder="e.g. Founders of local service businesses"
        onChange={(who) => set({ who })}
      />
      <TextAnswer
        label="The progress they want"
        help={{
          description: "What they are trying to get done, in their words, not what you sell. Say what changes for them if the process works.",
          example: "A trusted partner running their marketing within two weeks, without a long buying process.",
        }}
        value={doc.job.progress}
        disabled={disabled}
        missing={!doc.job.progress.trim()}
        multiline
        placeholder="e.g. Get more enquiries they can trust without learning marketing themselves"
        onChange={(progress) => set({ progress })}
      />
      <TextAnswer
        label="The situation"
        help={{
          description: "What is going on for them when they come to you. The situation matters more than who they are.",
          example: "After a referral, or after a bad experience with another agency.",
        }}
        value={doc.job.situation}
        disabled={disabled}
        placeholder="e.g. After a referral"
        onChange={(situation) => set({ situation })}
      />
      <TextAnswer
        label="What done looks like"
        help={{
          description: "How you will know the job is finished for them. If it mentions speed, a success measure can check it.",
          example: "A signed retainer and a kickoff date in the diary.",
        }}
        value={doc.job.done}
        disabled={disabled}
        missing={!doc.job.done.trim()}
        placeholder="e.g. A signed 12-month retainer and a kickoff call"
        onChange={(done) => set({ done })}
      />
    </div>
  );
}

// 2. Hard truths against assumptions -----------------------------------------------------------------------------

function TruthsStep({ doc, edit, disabled }: BodyProps) {
  const set = (i: number, patch: Partial<FpStatement>) => edit((d) => ({ ...d, statements: setAt(d.statements, i, patch) }));
  return (
    <div className="flex flex-col gap-3">
      {doc.statements.map((s, i) => (
        <ItemCard key={i}>
          <div className="flex flex-wrap items-end gap-3">
            <TextAnswer
              className="min-w-56 flex-1"
              label="Statement"
              help={{
                description: "One thing you believe about this process. Write it as a plain sentence you could check.",
                example: "Every proposal has to be written from scratch.",
              }}
              value={s.text}
              disabled={disabled}
              placeholder="A statement about this process"
              onChange={(text) => set(i, { text })}
            />
            <Choice
              label="Truth or assumption"
              help={{
                description: "A truth cannot be argued away: a law, a signed contract, a hard limit on capacity. An assumption only feels true. If you are not sure, call it an assumption.",
                example: "“Retainers are 12-month contracts” is a truth. “Leads go cold after 48 hours” is an assumption.",
              }}
              value={s.kind}
              disabled={disabled}
              options={[
                { value: "truth", label: "Truth" },
                { value: "assumption", label: "Assumption" },
              ]}
              onChange={(kind) => set(i, { kind })}
            />
          </div>
          {s.kind === "truth" ? (
            <TextAnswer
              label="Source: where does this come from?"
              help={{
                description: "The document, law, signed paper or setting that makes it true. A truth with no source is treated as an assumption.",
                example: "The contract template, version 3. Or: People settings, the strategist's hours.",
              }}
              value={s.source}
              disabled={disabled}
              missing={!s.source.trim()}
              placeholder="e.g. contract, law, People settings"
              onChange={(source) => set(i, { source })}
            />
          ) : (
            <TextAnswer
              label="Test: how would you prove it wrong?"
              help={{
                description: "A quick way to check whether the assumption is really true. The simulation can often be the check.",
                example: "Send five proposals with a light audit and compare the win rate with the last twenty.",
              }}
              value={s.test}
              disabled={disabled}
              missing={!s.test.trim()}
              placeholder="e.g. try it on 5 leads and compare"
              onChange={(test) => set(i, { test })}
            />
          )}
          <div className="flex justify-end">
            <RemoveButton label="statement" disabled={disabled} onClick={() => edit((d) => ({ ...d, statements: without(d.statements, i) }))} />
          </div>
        </ItemCard>
      ))}
      <AddButton
        label="Add a statement"
        disabled={disabled}
        help={{
          description: "Add something that is true of this process, or that people believe is true. Aim for a few of each.",
          example: "“Only the managing director can close a deal.” Is that a truth or an assumption?",
        }}
        onClick={() => edit((d) => ({ ...d, statements: [...d.statements, { text: "", kind: "assumption", source: "", test: "", linked_parameter: null }] }))}
      />
    </div>
  );
}

// 3. Requirements ------------------------------------------------------------------------------------------------

function RequirementsStep({ doc, edit, ctx, disabled }: BodyProps) {
  const set = (i: number, patch: Partial<FpRequirement>) => edit((d) => ({ ...d, requirements: setAt(d.requirements, i, patch) }));
  return (
    <div className="flex flex-col gap-3">
      {doc.requirements.map((r, i) => {
        const owner = ownerProblem(r, ctx);
        return (
          <ItemCard key={i}>
            <div className="flex flex-wrap items-end gap-3">
              <TextAnswer
                className="min-w-56 flex-1"
                label="Requirement"
                help={{
                  description: "A rule or check this process has to follow. Write it as the rule, not as the step it creates.",
                  example: "The managing director reviews every proposal before it goes out.",
                }}
                value={r.text}
                disabled={disabled}
                placeholder="A rule this process follows"
                onChange={(text) => set(i, { text })}
              />
              <Choice
                label="Verdict"
                help={{
                  description: "What you decide about the rule. Keep it as it is, change it, drop it, or challenge it, which means you are not sure yet and want to dig.",
                  example: "“Review every proposal”: change it to review only proposals over £3k a month.",
                }}
                value={r.verdict}
                disabled={disabled}
                options={[
                  { value: "keep", label: "Keep" },
                  { value: "change", label: "Change" },
                  { value: "drop", label: "Drop" },
                  { value: "challenge", label: "Challenge" },
                ]}
                onChange={(verdict) => set(i, { verdict })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <PickAnswer
                label="Owner (a person, not a team)"
                help={{
                  description: "The person who set this rule, by name. A department can't be asked why the rule exists; a person can. People come from People settings.",
                  example: "Sarah, the managing director. Not “Finance”.",
                }}
                value={r.owner_person_id ?? ""}
                disabled={disabled}
                missing={owner !== null && !r.owner_text.trim()}
                options={personOptions(ctx, "Pick a person")}
                onChange={(id) => set(i, { owner_person_id: id || null, owner_text: id ? "" : r.owner_text })}
              />
              <TextAnswer
                label="Or type a name"
                help={{
                  description: "For an owner who isn't in People settings, such as someone at the client. Use their name. A team or a role name is flagged.",
                  example: "Priya Nair (the client's finance director).",
                }}
                value={r.owner_text}
                disabled={disabled}
                missing={owner !== null && !r.owner_person_id}
                placeholder="Only if they aren't in People"
                onChange={(owner_text) => set(i, { owner_text, owner_person_id: owner_text.trim() ? null : r.owner_person_id })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextAnswer
                label="Why it exists"
                help={{
                  description: "The reason, not the habit. Ask why up to five times. “We've always done it” means nobody knows.",
                  example: "One proposal was under-priced in 2024 and cost a month's fee.",
                }}
                value={r.why}
                disabled={disabled}
                missing={!r.why.trim()}
                placeholder="The reason, not the habit"
                onChange={(why) => set(i, { why })}
              />
              <PickAnswer
                label="Step it creates"
                help={{
                  description: "The step in the process that exists because of this rule, if any. The checks use it to catch speeding up a step you are still challenging.",
                  example: "“Manager reviews every proposal” creates the Proposal review step.",
                }}
                value={r.step_id ?? ""}
                disabled={disabled}
                options={stepOptions(ctx, "No step")}
                onChange={(id) => set(i, { step_id: id || null })}
              />
            </div>
            <div className="flex justify-end">
              <RemoveButton label="requirement" disabled={disabled} onClick={() => edit((d) => ({ ...d, requirements: without(d.requirements, i) }))} />
            </div>
          </ItemCard>
        );
      })}
      <AddButton
        label="Add a requirement"
        disabled={disabled}
        help={{
          description: "Add a rule the process has to follow: an approval, a check, a format. Aim to list every one, then challenge them.",
          example: "“Credit check before the contract goes out.”",
        }}
        onClick={() => edit((d) => ({ ...d, requirements: [...d.requirements, { text: "", owner_person_id: null, owner_text: "", why: "", verdict: "challenge", step_id: null }] }))}
      />
    </div>
  );
}

// 4. Delete ------------------------------------------------------------------------------------------------------

function DeleteStep({ doc, edit, ctx, disabled }: BodyProps) {
  const set = (i: number, patch: Partial<FpDeleteCandidate>) => edit((d) => ({ ...d, deletes: setAt(d.deletes, i, patch) }));
  const unused = ctx.steps.find((s) => !doc.deletes.some((d) => d.step_id === s.id));
  return (
    <div className="flex flex-col gap-3">
      {doc.deletes.map((d, i) => (
        <ItemCard key={i} tone={d.added_back ? "back" : undefined}>
          <div className="flex flex-wrap items-end gap-3">
            <PickAnswer
              className="min-w-56 flex-1"
              label="Step to delete"
              help={{
                description: "A step, handoff or approval that might not need to exist. Pick it from this process's steps.",
                example: "Qualify lead, if the booking form can do the same job.",
              }}
              value={d.step_id}
              disabled={disabled}
              options={ctx.steps.some((s) => s.id === d.step_id) ? ctx.steps.map((s) => ({ value: s.id, label: s.name })) : [{ value: d.step_id, label: "A step no longer in the process" }, ...ctx.steps.map((s) => ({ value: s.id, label: s.name }))]}
              onChange={(step_id) => set(i, { step_id })}
            />
            <Choice
              label="Added back?"
              help={{
                description: "If you try deleting it and find you need it after all, mark it added back. Musk's rule of thumb: you should add back about 1 in 10, or you did not delete enough.",
                example: "Deleting the manager's review brought pricing errors back, so it is added back.",
              }}
              value={d.added_back ? "yes" : "no"}
              disabled={disabled}
              options={[
                { value: "no", label: "Delete it" },
                { value: "yes", label: "Added back" },
              ]}
              onChange={(v) => set(i, { added_back: v === "yes" })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextAnswer
              label="What breaks without it"
              help={{
                description: "What would go wrong if this step disappeared tomorrow. If you can't think of anything, that is a good sign it can go.",
                example: "Nothing before the discovery call; notes get taken on the call instead.",
              }}
              value={d.breaks_if_removed}
              disabled={disabled}
              onChange={(breaks_if_removed) => set(i, { breaks_if_removed })}
            />
            <PickAnswer
              label="Who has to agree"
              help={{
                description: "The person who must say yes before the step goes. Pick them from People settings.",
                example: "Tom, who runs the sales team.",
              }}
              value={d.agreed_by ?? ""}
              disabled={disabled}
              options={personOptions(ctx, "Pick a person")}
              onChange={(id) => set(i, { agreed_by: id || null })}
            />
          </div>
          <div className="flex justify-end">
            <RemoveButton label="delete candidate" disabled={disabled} onClick={() => edit((x) => ({ ...x, deletes: without(x.deletes, i) }))} />
          </div>
        </ItemCard>
      ))}
      <AddButton
        label="Add a step to delete"
        disabled={disabled || !unused}
        help={{
          description: "Add a step you think might not need to exist. You can have as many as you like; the aim is to find the limit.",
          example: "The second negotiation call: send the revised proposal by email instead.",
        }}
        onClick={() => unused && edit((d) => ({ ...d, deletes: [...d.deletes, { step_id: unused.id, breaks_if_removed: "", agreed_by: null, added_back: false }] }))}
      />
      <p className="text-xs text-fg-2">Rule of thumb from Musk: if you never have to add anything back, you didn&apos;t delete enough. Aim to add back about 1 in 10.</p>
      <p className="text-xs text-fg-2" data-delete-purpose-note>
        Steps listed here count as “Could be removed” in the Sandbox&apos;s time split, unless a step&apos;s purpose is chosen in the editor.
      </p>
    </div>
  );
}

// 5. Simplify, accelerate, automate ------------------------------------------------------------------------------

const LANES: { stage: FpStage; title: string; help: { description: string; example: string } }[] = [
  {
    stage: "simplify",
    title: "1 · Simplify",
    help: { description: "Make what is left simpler: fewer parts, fewer handoffs, a template, a clearer rule. Do this first.", example: "Three proposal templates by package size." },
  },
  {
    stage: "accelerate",
    title: "2 · Accelerate",
    help: { description: "Make it faster: shorter waits, quicker replies, work done side by side. Only after simplifying.", example: "Book discovery calls straight from the lead form." },
  },
  {
    stage: "automate",
    title: "3 · Automate",
    help: { description: "Let software or AI do the step. This comes last. Automating a step that should not exist just makes mistakes faster.", example: "Send the contract for e-signature as soon as the proposal is accepted." },
  },
];

function ImproveStep({ doc, edit, ctx, disabled }: BodyProps) {
  const set = (i: number, patch: Partial<FpImprovement>) => edit((d) => ({ ...d, improvements: setAt(d.improvements, i, patch) }));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-3">
        {LANES.map((lane) => (
          <div key={lane.stage} className="flex min-w-0 flex-col gap-3 rounded-token border border-line bg-panel-2 p-3">
            <span className="flex items-center text-xs font-semibold tracking-wide text-fg-2 uppercase">
              {lane.title}
              <Help label={lane.title.slice(4)} {...lane.help} />
            </span>
            {doc.improvements
              .map((item, gi) => ({ item, gi }))
              .filter(({ item }) => item.stage === lane.stage)
              .map(({ item, gi }) => (
                <ItemCard key={gi}>
                  <TextAnswer
                    label="Change"
                    help={{ description: "One change you would make to a step that stays. Say what, plainly.", example: "Send the proposal within 24 hours of the call." }}
                    value={item.text}
                    disabled={disabled}
                    placeholder="e.g. One proposal template"
                    onChange={(text) => set(gi, { text })}
                  />
                  <PickAnswer
                    label="Step it changes"
                    help={{
                      description: "The step this change touches. The checks warn if it is a step you plan to delete, because that is the wrong order.",
                      example: "Audit & proposal.",
                    }}
                    value={item.step_id ?? ""}
                    disabled={disabled}
                    options={stepOptions(ctx, "No step")}
                    onChange={(id) => set(gi, { step_id: id || null })}
                  />
                  <div className="flex justify-end">
                    <RemoveButton label="change" disabled={disabled} onClick={() => edit((d) => ({ ...d, improvements: without(d.improvements, gi) }))} />
                  </div>
                </ItemCard>
              ))}
            <AddButton
              label="Add"
              disabled={disabled}
              help={{ description: `Add a change to ${lane.stage}.`, example: lane.help.example }}
              onClick={() => edit((d) => ({ ...d, improvements: [...d.improvements, { step_id: null, stage: lane.stage, text: "", scenario_id: null }] }))}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-fg-2">Musk: “I literally automated, accelerated, simplified and then deleted.” The checks warn when a change runs out of order.</p>
    </div>
  );
}

// 6. Root cause --------------------------------------------------------------------------------------------------

function WhyStep({ doc, edit, disabled }: BodyProps) {
  const setWhy = (patch: Partial<FirstPrinciples["why"]>) => edit((d) => ({ ...d, why: { ...d.why, ...patch } }));
  return (
    <div className="flex flex-col gap-3">
      <TextAnswer
        label="The biggest problem"
        help={{
          description: "The one thing that hurts this process most today. Use a fact you can see, not a feeling.",
          example: "Deals take six weeks to close.",
        }}
        value={doc.why.problem}
        disabled={disabled}
        placeholder="e.g. Proposals go out late"
        onChange={(problem) => setWhy({ problem })}
      />
      <ol className="flex flex-col gap-3">
        {doc.why.chain.map((w, i) => (
          <li key={i}>
            <TextAnswer
              label={`Why ${i + 1}`}
              help={{
                description: "Ask why about the answer above it. Keep going until you reach something you can fix.",
                example: "Why do proposals wait? Because the managing director reviews all of them.",
              }}
              value={w}
              disabled={disabled}
              onChange={(v) => setWhy({ chain: doc.why.chain.map((c, j) => (j === i ? v : c)) })}
            />
          </li>
        ))}
      </ol>
      <AddButton
        label="Ask why again"
        disabled={disabled || doc.why.chain.length >= 10}
        help={{
          description: "Add another why. Toyota's rule of thumb is to ask five times, but stop when you reach a cause you can act on.",
          example: "Why are there no pricing rules? Nobody was asked to write them.",
        }}
        onClick={() => setWhy({ chain: [...doc.why.chain, ""] })}
      />
      <TextAnswer
        label="Root cause"
        help={{
          description: "Where the chain ends: a cause in how the process works, not a person. “Tom is slow” is not a root cause; “nobody has written the pricing rules” is.",
          example: "There are no written pricing and scoping rules.",
        }}
        value={doc.why.root}
        disabled={disabled}
        missing={!doc.why.root.trim()}
        placeholder="Something in the process you can fix"
        onChange={(root) => setWhy({ root })}
      />
    </div>
  );
}

// 7. Success measures --------------------------------------------------------------------------------------------

const KPI_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Not something the simulation can work out" },
  ...(Object.keys(SUCCESS_KPI_FORM) as SuccessKpi[]).map((k) => ({ value: k, label: SUCCESS_KPI_FORM[k].label })),
];

function MeasuresStep({ doc, edit, disabled, checks }: BodyProps) {
  const set = (i: number, patch: Partial<FpMeasure>) => edit((d) => ({ ...d, measures: setAt(d.measures, i, patch) }));
  return (
    <div className="flex flex-col gap-3">
      {doc.measures.map((m, i) => {
        const form = m.kpi ? SUCCESS_KPI_FORM[m.kpi] : null;
        const check = checks.find((c) => c.measure.id === m.id);
        const met = check?.status === "rated" ? Math.round(check.metShare * 100) : null;
        return (
          <ItemCard key={m.id}>
            <div className="flex flex-wrap items-end gap-3">
              <TextAnswer
                className="min-w-56 flex-1"
                label="Measure"
                help={{
                  description: "How you will know the process does its job better, in your own words.",
                  example: "Win rate above 25%.",
                }}
                value={m.text}
                disabled={disabled}
                placeholder="e.g. Win rate above 30%"
                onChange={(text) => set(i, { text })}
              />
              <PickAnswer
                className="min-w-56"
                label="Simulation number"
                help={{
                  description: "The number the simulation works out that this measure is about. If none fits, the measure stays on the list but is marked not checked by the simulation.",
                  example: "“Win rate” for “win more of the leads we get”.",
                }}
                value={m.kpi ?? ""}
                disabled={disabled}
                missing={m.kpi === null}
                options={KPI_OPTIONS}
                onChange={(kpi) => set(i, { kpi: (kpi || null) as SuccessKpi | null, target: null })}
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <PickAnswer
                label="Goal"
                help={{
                  description: "Whether the number should be at least the target (wins, win rate) or at most it (time, cost).",
                  example: "Win rate: at least 30%. Time to complete: at most 120 hours.",
                }}
                value={m.comparator}
                disabled={disabled}
                options={[
                  { value: "atLeast", label: "At least" },
                  { value: "atMost", label: "At most" },
                ]}
                onChange={(comparator) => set(i, { comparator: comparator as FpMeasure["comparator"] })}
              />
              <NumberAnswer
                label="Target"
                help={{
                  description: "The number to reach, in the unit shown next to the box. Each run of the simulation either meets it or does not.",
                  example: "30, for a win rate of at least 30%.",
                }}
                value={m.target === null || !form ? m.target : Math.round(m.target * form.scale * 1e6) / 1e6}
                unit={form?.unit}
                disabled={disabled || !m.kpi}
                missing={m.kpi !== null && m.target === null}
                onChange={(v) => set(i, { target: v === null ? null : v / (form?.scale ?? 1) })}
              />
              <TextAnswer
                className="min-w-40"
                label="By when"
                help={{
                  description: "When the target should be met. This is a note for people; the simulation uses the horizon picked on the process page.",
                  example: "6 months.",
                }}
                value={m.horizon}
                disabled={disabled}
                placeholder="e.g. 6 months"
                onChange={(horizon) => set(i, { horizon })}
              />
              <div className="flex min-w-40 flex-1 flex-col gap-1">
                <span className="flex items-center text-xs font-medium text-fg-2">
                  Met today
                  <Help
                    label="Met today"
                    description="The share of the simulation's 30 runs that meet this target for the process as it is now. 80% or more is healthy; under 20% is a risk."
                    example="58% of runs: more than half the runs reach it, but it is not safe."
                  />
                </span>
                {met !== null ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 flex-1 rounded-full bg-panel-2">
                      <span className={`block h-2 rounded-full ${met >= 80 ? "bg-good" : met >= 50 ? "bg-warn" : "bg-crit"}`} style={{ width: `${met}%` }} />
                    </span>
                    <span className="text-xs tabular-nums">{met}% of runs</span>
                  </span>
                ) : (
                  <span className="text-xs text-fg-2">{check?.status === "not_checked" ? check.reason : "Waiting for the simulation"}</span>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <RemoveButton label="measure" disabled={disabled} onClick={() => edit((d) => ({ ...d, measures: without(d.measures, i) }))} />
            </div>
          </ItemCard>
        );
      })}
      <AddButton
        label="Add a measure"
        disabled={disabled || doc.measures.length >= 50}
        help={{
          description: "Add a way to tell the process is doing its job better. Two to four is plenty. Pick a simulation number so it gets a pass rate.",
          example: "New wins over the next three months: at least 6.",
        }}
        onClick={() =>
          edit((d) => ({
            ...d,
            measures: [...d.measures, { id: nextMeasureId(d.measures), text: "", kpi: null, comparator: "atLeast", target: null, horizon: "" }],
          }))
        }
      />
    </div>
  );
}

function nextMeasureId(measures: readonly FpMeasure[]): string {
  const used = new Set(measures.map((m) => m.id));
  for (let n = measures.length + 1; ; n++) if (!used.has(`m${n}`)) return `m${n}`;
}
