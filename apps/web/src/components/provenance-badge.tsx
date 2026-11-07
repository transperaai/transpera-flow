import type { StepRow } from "@transpera-flow/db";
import { provenanceSource, stepProvenance } from "@/lib/editor/provenance";

const LABEL = { estimated: "Estimated", entered: "Entered" } as const;
const TONE = {
  estimated: "border-warn bg-warn-soft",
  entered: "border-line bg-panel-2",
} as const;

/** Where a step's value came from: estimated (an assumption to confirm), or entered by a person. */
export function ProvenanceBadge({ step, column }: { step: StepRow; column: string }) {
  const source = provenanceSource(step, column);
  const at = stepProvenance(step, column)?.at;
  const when = at ? new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
  return (
    <span
      data-provenance={source}
      title={when ? `${LABEL[source]} on ${when}` : LABEL[source]}
      className={`inline-block rounded-token border px-1.5 text-[11px] leading-4 text-fg-2 ${TONE[source]}`}
    >
      {LABEL[source]}
    </span>
  );
}
