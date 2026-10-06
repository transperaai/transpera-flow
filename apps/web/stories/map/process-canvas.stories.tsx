import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { NO_SELECTION, ProcessCanvas, type Selection } from "@/components/process-canvas";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { ProcessEditor } from "@/lib/editor/editor";
import { MemoryStore } from "@/lib/editor/store";
import { demoBundle } from "@/lib/sources/demo";
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
      <ProcessCanvas bundle={bundle} handoffs showPlayback={false} />
    </Block>
  );
}

/** The company map: process cards joined by labelled handoff lines. */
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
