import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SimulationGap } from "@transpera-flow/db/simulation-gaps";
import { PayHidden } from "@/components/pay-hidden";
import { GapList, IncompleteDataNote, MissingForSimulation } from "@/components/simulation-gaps";
import { HorizonPicker } from "@/components/horizon-picker";
import { ProvenanceBadge } from "@/components/provenance-badge";
import { StepIssueBadges } from "@/components/step-issue-badges";
import { northbeamRun } from "../fixtures";

const meta: Meta = { title: "Shared/Small components" };
export default meta;

const gaps: SimulationGap[] = [
  { kind: "hands_on", stepId: "s1", stepName: "Write proposal", text: "Write proposal has no hands-on time", fix: { type: "step", stepId: "s1" } },
  { kind: "wait", stepId: "s2", stepName: "Client review", text: "Client review has no wait time", fix: { type: "step", stepId: "s2" } },
  { kind: "volume", stepId: null, stepName: null, text: "No incoming volume: add lead volume in Settings or accept the suggestion", fix: { type: "settings", where: "demand" } },
];

export const PayHiddenFigure: StoryObj = {
  name: "PayHidden",
  render: () => (
    <p>
      Overtime cost: <PayHidden />
    </p>
  ),
};

export const Gaps: StoryObj = {
  name: "Simulation gaps",
  tags: ["visual-phone"],
  render: () => (
    <div className="flex max-w-xl flex-col gap-4">
      <MissingForSimulation gaps={gaps} onSelectStep={() => undefined} settingsHref="/demo/settings" />
      <GapList gaps={gaps} onSelectStep={() => undefined} settingsHref="/demo/settings" />
      <IncompleteDataNote count={3} />
      <IncompleteDataNote count={1} />
    </div>
  ),
};

export const Horizon: StoryObj = {
  name: "HorizonPicker",
  tags: ["visual-phone"],
  render: () => (
    <div className="flex flex-col gap-4">
      <HorizonPicker weeks={26} onChange={() => undefined} />
      <HorizonPicker weeks={52} onChange={() => undefined} help={false} />
      <HorizonPicker weeks={30} onChange={() => undefined} />
    </div>
  ),
};

export const Provenance: StoryObj = {
  name: "ProvenanceBadge",
  render: () => {
    const base = northbeamRun().bundle.steps[0]!;
    const step = {
      ...base,
      provenance: {
        work_hours: { source: "entered" as const, at: "2026-09-20T10:00:00.000Z" },
        wait_hours: { source: "measured" as const, at: "2026-09-21T10:00:00.000Z" },
      },
    };
    return (
      <div className="flex items-center gap-3">
        <ProvenanceBadge step={step} column="work_hours" />
        <ProvenanceBadge step={step} column="wait_hours" />
        <ProvenanceBadge step={step} column="rework_rate" />
      </div>
    );
  },
};

/** The badges portal into a map's step cards; two stand-in cards give them somewhere to land. */
export const StepBadges: StoryObj = {
  name: "StepIssueBadges",
  render: () => (
    <div data-process-map className="flex gap-6 p-4">
      {["a", "b", "c"].map((id) => (
        <div key={id} data-id={id} className="react-flow__node relative w-40 rounded-lg border bg-card p-3">
          Step {id.toUpperCase()}
        </div>
      ))}
      <StepIssueBadges
        badges={{ a: { count: 2, rating: "bad", titles: ["Slow review", "Rework"] }, c: { count: 1, rating: "risk", titles: ["Single point of failure"] } }}
        onOpen={() => undefined}
      />
    </div>
  ),
};
