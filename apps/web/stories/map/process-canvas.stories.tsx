import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
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

/** Two steps highlighted, the rest dimmed. */
export const Highlight: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const { bundle } = northbeamRun();
    return (
      <Block>
        <ProcessCanvas bundle={bundle} highlight={[northbeamStepIds.audit, northbeamStepIds.ppc]} showPlayback={false} />
      </Block>
    );
  },
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
