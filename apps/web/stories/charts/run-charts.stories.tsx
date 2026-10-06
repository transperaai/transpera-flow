import type { Meta, StoryObj } from "@storybook/react-vite";
import { KpiStrip } from "@/components/kpi-strip";
import { UtilisationBars } from "@/components/utilisation-bars";
import { WaitByStep } from "@/components/wait-by-step";
import { northbeamRun } from "../fixtures";

const meta: Meta = { title: "Charts/Run" };
export default meta;

export const Utilisation: StoryObj = {
  name: "UtilisationBars",
  tags: ["visual-phone"],
  render: () => {
    const { model, result } = northbeamRun();
    return (
      <div className="w-full max-w-3xl">
        <UtilisationBars model={model} result={result} />
      </div>
    );
  },
};

export const UtilisationNoRun: StoryObj = {
  name: "UtilisationBars (no run yet)",
  render: () => {
    const { model } = northbeamRun();
    return (
      <div className="w-full max-w-3xl">
        <UtilisationBars model={model} result={null} />
      </div>
    );
  },
};

export const Wait: StoryObj = {
  name: "WaitByStep",
  tags: ["visual-phone"],
  render: () => {
    const { model, result } = northbeamRun();
    return (
      <div className="w-full max-w-3xl">
        <WaitByStep model={model} result={result} stepIds={new Set(model.steps.map((s) => s.id))} />
      </div>
    );
  },
};

export const WaitNoRun: StoryObj = {
  name: "WaitByStep (no run yet)",
  render: () => {
    const { model } = northbeamRun();
    return (
      <div className="w-full max-w-3xl">
        <WaitByStep model={model} result={null} stepIds={new Set(model.steps.map((s) => s.id))} />
      </div>
    );
  },
};

export const Kpis: StoryObj = {
  name: "KpiStrip",
  tags: ["visual-phone"],
  render: () => {
    const { bundle, model, result } = northbeamRun();
    return <KpiStrip model={model} currency={bundle.workspace.settings.currency} result={result} status="done" durationMs={420} />;
  },
};

export const KpisRunning: StoryObj = {
  name: "KpiStrip (running)",
  render: () => {
    const { bundle, model } = northbeamRun();
    return <KpiStrip model={model} currency={bundle.workspace.settings.currency} result={null} status="running" />;
  },
};
