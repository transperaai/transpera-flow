"use client";

// The Capacity page's wrapper: builds the model from the live process (the view runs Today from it: the workspace's own length with new
// leads and churn off) and hands it to the view.

import { useMemo } from "react";
import { workspacePurposes, type CapacitySetup, type ProcessBundle } from "@transpera-flow/db";
import { capacityBaseModel } from "@/lib/capacity/model";
import { CapacityView } from "./capacity-view";

/** Step id → the process it sits in, over the live process and every other process the model draws steps from. */
export function stepProcessMap(bundle: ProcessBundle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of bundle.steps) out[s.id] = bundle.process.id;
  for (const p of bundle.otherProcesses ?? []) for (const s of p.steps) out[s.id] = p.process.id;
  return out;
}

export function CapacityPage({ bundle, setup, base }: { bundle: ProcessBundle; setup: CapacitySetup; base: string }) {
  const built = useMemo(() => capacityBaseModel(bundle), [bundle]);
  const stepProcess = useMemo(() => stepProcessMap(bundle), [bundle]);
  const purposes = useMemo(() => workspacePurposes(bundle.workspace.settings), [bundle.workspace.settings]);
  return <CapacityView setup={setup} model={built.model} modelError={built.error} base={base} stepProcess={stepProcess} purposes={purposes} />;
}
