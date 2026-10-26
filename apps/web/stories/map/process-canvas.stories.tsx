import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { NO_SELECTION, ProcessCanvas, type Selection } from "@/components/process-canvas";
import { StepIssueBadges } from "@/components/step-issue-badges";
import { diffBundles } from "@/lib/drafts/diff";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { ProcessEditor } from "@/lib/editor/editor";
import { MemoryStore } from "@/lib/editor/store";
import { demoBundle } from "@/lib/sources/demo";
import type { StepBadge } from "@/lib/issues/register";
import { companyBundle, northbeamRun, northbeamStepIds, ratingsByStep } from "../fixtures";

const meta: Meta = { title: "Map/ProcessCanvas", parameters: { layout: "padded" } };
export default meta;

/**
 * A read-only map sits in a block as wide as the page (never a bare flex row: there it shrink-wraps and refits late, the #99 flake).
 * Fixed at 1200 px on a wide screen, the full width on a phone.
 */
const Block = ({ children }: { children: ReactNode }) => <div style={{ width: "100%", maxWidth: 1200 }}>{children}</div>;

/** Northbeam with a run (queues on the cards) and every rating band on at least one step. */
export const ReadOnly: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const { bundle, result } = northbeamRun();
    return (
      <Block>
        <ProcessCanvas bundle={bundle} result={result} rating={ratingsByStep(bundle)} showPlayback={false} />
      </Block>
    );
  },
};

/** Two groups, one open (a box around its steps) and one closed (a card with a roll-up). */
export const GroupsOpen: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const bundle = withDemoGroups(demoBundle());
    return (
      <Block>
        <ProcessCanvas bundle={bundle} rating={ratingsByStep(bundle)} expanded={new Set([DEMO_GROUP_IDS.setup])} showPlayback={false} />
      </Block>
    );
  },
};

/**
 * The highlight is applied once the map has framed itself and held still, as it is in the app (a hover, after the page has
 * drawn): a highlight present at mount races the map's first fit, so where the map ends up would depend on timing.
 * `data-visual-pending` tells the visual suite the story is not ready until the highlight is on.
 */
function HighlightMap() {
  const { bundle } = northbeamRun();
  const [lit, setLit] = useState<readonly string[] | null>(null);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let frame = 0;
    let last = "";
    let still = 0;
    let done = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (done) return;
      const transform = document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
      still = transform && transform === last ? still + 1 : 0;
      last = transform;
      if (still >= 30) {
        setLit([northbeamStepIds.audit, northbeamStepIds.ppc]);
        settle = setTimeout(() => setPending(false), 600);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, []);
  return (
    <div data-visual-pending={pending ? "" : undefined}>
      <Block>
        <ProcessCanvas bundle={bundle} highlight={lit} showPlayback={false} />
      </Block>
    </div>
  );
}

/** Two steps highlighted, the rest dimmed. */
export const Highlight: StoryObj = {
  tags: ["visual-phone"],
  render: () => <HighlightMap />,
};

function CompanyMap_() {
  const bundle = useMemo(() => companyBundle(), []);
  return (
    <Block>
      <ProcessCanvas bundle={bundle} handoffs showPlayback={false} height="tall" />
    </Block>
  );
}

/** The company map: process cards joined by labelled handoff lines, centred in the Overview's tall panel, with the zoom, fit and full-screen buttons. */
export const CompanyMap: StoryObj = {
  tags: ["visual-phone"],
  render: () => <CompanyMap_ />,
};

function EditableMap() {
  const base = useMemo(() => demoBundle(), []);
  const editor = useMemo(() => new ProcessEditor(base, new MemoryStore(base)), [base]);
  const state = useSyncExternalStore(editor.subscribe, editor.getState, editor.getState);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  return (
    <div style={{ width: "100%", maxWidth: 1200, height: 560, display: "flex" }}>
      <ProcessCanvas
        bundle={state.bundle}
        editor={editor}
        editorState={state}
        selection={selection}
        onSelectionChange={setSelection}
        height="fill"
        showPlayback={false}
      />
    </div>
  );
}

/** The Editor's map: editable, filling a 1200 x 560 panel. */
export const Editable: StoryObj = {
  render: () => <EditableMap />,
};

/**
 * Waits for the map to frame itself and hold still (the viewport unchanged for 30 frames, as `HighlightMap` does), and for
 * every selector in `needs` to exist, then calls `ready`.
 */
function useSettled(needs: readonly string[], ready: () => void) {
  useEffect(() => {
    let frame = 0;
    let last = "";
    let still = 0;
    let done = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (done) return;
      const transform = document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
      still = transform && transform === last ? still + 1 : 0;
      last = transform;
      if (still >= 30 && needs.every((q) => document.querySelector(q))) {
        settle = setTimeout(ready, 400);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on mount
  }, []);
}

/** Fixed badges for two steps: Audit has two confirmed issues (the worst a risk), Kickoff one (bad). */
const BADGES: Record<string, StepBadge> = {
  [northbeamStepIds.audit]: { count: 2, rating: "risk", titles: ["One strategist does every audit", "Proposals wait on one person"] },
  [northbeamStepIds.kickoff]: { count: 1, rating: "bad", titles: ["Kickoff slips when the audit is late"] },
};

function NodeStatesMap() {
  const { bundle, result } = northbeamRun();
  const [pending, setPending] = useState(true);
  useSettled(["[data-issue-badge]"], () => setPending(false));
  // The run's own bottleneck is a step of another process, so name Audit the bottleneck to show the flag on a tile.
  const run = useMemo(() => ({ ...result, bnStep: northbeamStepIds.audit }), [result]);
  const cycle = useMemo(() => ratingsByStep(bundle), [bundle]);
  // Every rating band on a step, and one step unrated.
  const rating = useMemo(() => (id: string) => (id === northbeamStepIds.ppc ? null : cycle(id)), [cycle]);
  return (
    <div data-visual-pending={pending ? "" : undefined}>
      <Block>
        <ProcessCanvas
          bundle={bundle}
          result={run}
          rating={rating}
          selection={{ steps: [northbeamStepIds.onboard], edges: [] }}
          openIssues={{ [northbeamStepIds.audit]: 2, [northbeamStepIds.kickoff]: 1 }}
          showPlayback={false}
        />
        <StepIssueBadges badges={BADGES} onOpen={() => undefined} />
      </Block>
    </div>
  );
}

/**
 * Every state of a tile on one map (issue #242): each rating, unrated ("Nothing to fix"), the bottleneck (Audit), selected,
 * issues, a conflict (Audit), an assumption (Kickoff), a decision nobody works, and the start and end tiles.
 */
export const NodeStates: StoryObj = {
  tags: ["visual-phone"],
  render: () => <NodeStatesMap />,
};

function DraftMap() {
  const { bundle: live } = northbeamRun();
  const [pending, setPending] = useState(true);
  useSettled([], () => setPending(false));
  const { draft, diff } = useMemo(() => {
    const ids = northbeamStepIds;
    const added = { ...live.steps.find((st) => st.id === ids.kickoff)!, id: "e0000000-0000-4000-8000-0000000000f1", name: "Send reminder", x: 750, y: 170, work_hours: 0.5, wait_hours: 2, assumption: false, conflict: false };
    const steps = live.steps
      .filter((st) => st.id !== ids.live)
      .map((st) =>
        st.id === ids.qualify ? { ...st, name: "Qualify enquiry" } : st.id === ids.discovery ? { ...st, work_hours: 2, wait_hours: 12 } : st,
      )
      .concat(added);
    const edges = live.edges.filter((e) => e.from_step_id !== ids.live && e.to_step_id !== ids.live);
    const draft = { ...live, steps, edges };
    return { draft, diff: diffBundles(live, draft) };
  }, [live]);
  return (
    <div data-visual-pending={pending ? "" : undefined}>
      <Block>
        <ProcessCanvas bundle={draft} diff={diff} showPlayback={false} />
      </Block>
    </div>
  );
}

/** A draft against live: a renamed step (Changed), a step with new work and wait hours (Changed, the "Was" values), a new step (New) and a removed one (Removed ghost). */
export const Draft: StoryObj = {
  render: () => <DraftMap />,
};
