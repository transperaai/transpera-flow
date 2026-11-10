import type { ProvenanceMap, StepRow } from "@transpera-flow/db";
import { provenanceSource, stepProvenance } from "@/lib/editor/provenance";
import { cn } from "@/lib/utils";

const LABEL = { estimated: "Estimated", entered: "Entered" } as const;
const TONE = {
  estimated: "border-warn bg-warn-soft",
  entered: "border-line bg-panel-2",
} as const;

type Source = keyof typeof LABEL;

const dateOf = (at: string | null | undefined) => (at ? new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);

/**
 * Where a value came from: estimated (an assumption to confirm), or entered by a person. Give it a step and a column (the map's values),
 * or any row's provenance map and a field (a lead source, a month of seasonality, the demand growth).
 */
export function ProvenanceBadge(props: { step: StepRow; column: string } | { provenance: ProvenanceMap | null | undefined; field: string }) {
  let source: Source;
  let title: string;
  if ("step" in props) {
    source = provenanceSource(props.step, props.column);
    const when = dateOf(stepProvenance(props.step, props.column)?.at);
    title = when ? `${LABEL[source]} on ${when}` : LABEL[source];
  } else {
    const entry = props.provenance?.[props.field];
    // A source other than "entered" (none, or an old "measured") reads as an estimate, as `provenanceOf` in lib/demand does.
    source = entry?.source === "entered" ? "entered" : "estimated";
    const when = dateOf(entry?.at);
    title = [LABEL[source], when && `on ${when}`, entry?.note].filter(Boolean).join(" · ");
  }
  return (
    <span data-provenance={source} title={title} className={cn("inline-block rounded-md border px-1.5 text-2xs leading-4 text-fg-2", TONE[source])}>
      {LABEL[source]}
    </span>
  );
}
