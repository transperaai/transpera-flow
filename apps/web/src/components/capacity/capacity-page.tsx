"use client";

// The Capacity page's wrapper: builds the two models from the live process (Today is the workspace's own length with new leads and churn
// off; the next 12 months is the forecast's model with planned hires and leavers) and hands them to the view.

import { useMemo, useState } from "react";
import type { CapacitySetup, ProcessBundle } from "@transpera-flow/db";
import { capacityBaseModel } from "@/lib/capacity/model";
import { forecastModel, today as todayIso } from "@/lib/forecast/forecast";
import { CapacityView } from "./capacity-view";

/** Step id → the process it sits in, over the live process and every other process the model draws steps from. */
export function stepProcessMap(bundle: ProcessBundle): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of bundle.steps) out[s.id] = bundle.process.id;
  for (const p of bundle.otherProcesses ?? []) for (const s of p.steps) out[s.id] = p.process.id;
  return out;
}

export function CapacityPage({ bundle, setup, base }: { bundle: ProcessBundle; setup: CapacitySetup; base: string }) {
  const [start] = useState(() => todayIso());
  const built = useMemo(() => capacityBaseModel(bundle), [bundle]);
  const year = useMemo(() => {
    const f = forecastModel(bundle, 12, start);
    return f.model ? { model: f.model, monthStarts: f.monthStarts } : null;
  }, [bundle, start]);
  const stepProcess = useMemo(() => stepProcessMap(bundle), [bundle]);
  return <CapacityView setup={setup} model={built.model} modelError={built.error} year={year} base={base} stepProcess={stepProcess} startDate={start} />;
}
