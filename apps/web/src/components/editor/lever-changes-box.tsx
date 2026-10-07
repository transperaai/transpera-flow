"use client";

// "Lever changes" in the Editor's solution mode (issue #33, B4): the lever moves an idea brought (a visitor's play-link idea), one line
// each in words with Remove, and a note for any the server left out because what they named has gone. They are saved with the solution
// and used whenever it is simulated. Nothing here adds one: the Editor only shows those an idea brought.

import { useMemo } from "react";
import type { ProcessBundle } from "@transpera-flow/db";
import type { ScenarioPatch } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { describeLeverChange } from "@/lib/suggestions/lever-changes";

export const LEVER_CHANGES_HELP = {
  label: "Lever changes",
  description: "Changes to numbers rather than steps, such as more leads or one more person in a role. They're saved with the solution and used whenever it is simulated.",
  example: "Leads per week set to 12; Hands-on time on Check fit −20%.",
} as const;

export function LeverChangesBox({ levers, notes, bundle, onRemove }: { levers: readonly ScenarioPatch[]; notes: readonly string[]; bundle: ProcessBundle; onRemove: (index: number) => void }) {
  const names = useMemo(() => {
    const steps: Record<string, string> = {};
    for (const s of [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)]) steps[s.id] = s.name;
    return {
      steps,
      roles: Object.fromEntries(bundle.roles.map((r) => [r.id, r.name])),
      services: Object.fromEntries(bundle.services.map((s) => [s.id, s.name])),
      // The Editor is for owners and editors, who see everyone.
      people: Object.fromEntries(bundle.people.map((p) => [p.id, p.name])),
    };
  }, [bundle]);
  const currency = bundle.workspace.settings.currency;
  return (
    <section aria-labelledby="lever-changes-heading" className="flex flex-col gap-1.5 rounded-token border border-edit/50 bg-edit-soft p-2 text-xs" data-lever-changes>
      <h3 id="lever-changes-heading" className="flex items-center font-semibold">
        Lever changes
        <Help {...LEVER_CHANGES_HELP} />
      </h3>
      <ul className="flex flex-col gap-1">
        {levers.map((l, i) => (
          <li key={l.path} className="flex items-start justify-between gap-2" data-lever-change={l.path}>
            <span>{describeLeverChange(l, names, currency)}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => onRemove(i)} aria-label={`Remove: ${describeLeverChange(l, names, currency)}`}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {notes.map((n) => (
        <p key={n} className="text-fg-2" data-lever-note>
          {n}
        </p>
      ))}
    </section>
  );
}
