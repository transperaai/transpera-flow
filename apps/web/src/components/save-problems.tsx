"use client";

import type { ProcessBundle } from "@transpera-flow/db";
import { describeValue, fieldLabel, namesOf } from "@/lib/editor/describe";
import type { Conflict, ProcessEditor } from "@/lib/editor/editor";
import type { Value } from "@/lib/editor/ops";
import { isProvenanceField } from "@/lib/editor/provenance";
import { ConflictPrompt } from "./fields";

/** Same-field conflicts waiting for "keep mine / keep theirs", and the last failed save. */
export function SaveProblems({
  editor,
  bundle,
  conflicts,
  error,
}: {
  editor: ProcessEditor;
  bundle: ProcessBundle;
  conflicts: Conflict[];
  error: string | null;
}) {
  // A value's provenance is settled along with the value, so it gets no prompt of its own.
  conflicts = conflicts.filter((c) => !isProvenanceField(c.field));
  if (!conflicts.length && !error) return null;
  const names = namesOf(bundle);
  const show = (field: string, v: Value): string => describeValue(field, v, names);
  const subject = (c: Conflict) => {
    const label = fieldLabel(c.field);
    if (c.table === "steps") return `${names.get(c.id) ?? "a step"}'s ${label}`;
    const edge = bundle.edges.find((e) => e.id === c.id);
    return edge ? `the ${label} of ${names.get(edge.from_step_id)} → ${names.get(edge.to_step_id)}` : `a connection's ${label}`;
  };
  return (
    <div className="flex flex-col gap-2">
      {conflicts.map((c) => (
        <ConflictPrompt
          key={`${c.table}:${c.id}:${c.field}`}
          subject={subject(c)}
          theirs={show(c.field, c.theirs)}
          mine={show(c.field, c.mine)}
          onKeepMine={() => void editor.keepMine(c)}
          onKeepTheirs={() => editor.keepTheirs(c)}
        />
      ))}
      {error && (
        <p role="alert" className="rounded-token border border-crit bg-crit-soft p-2 text-xs">
          {error}{" "}
          <button type="button" onClick={() => editor.dismissError()} className="underline">
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
