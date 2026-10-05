"use client";

import { useState, useTransition } from "react";
import type { ScenarioRow } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import type { RemoveScenarioResult } from "@/lib/scenarios/store";

// Settings -> Levers, Saved scenarios (issue #182, B19): every saved set of lever changes in the workspace, and a way for
// owners and editors to delete one, after a confirm. An issue that named it as its fix keeps everything else. The delete
// comes in as `remove` (the server action, or a stand-in in the browser tests).

export function SavedScenarios({
  scenarios: initial,
  canEdit,
  remove,
}: {
  scenarios: ScenarioRow[];
  /** Owners and editors. */
  canEdit: boolean;
  remove: (id: string) => Promise<RemoveScenarioResult>;
}) {
  const [scenarios, setScenarios] = useState(initial);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const del = (s: ScenarioRow) =>
    start(async () => {
      setError(null);
      try {
        const r = await remove(s.id);
        if (r.status === "error") return setError(r.message);
        setScenarios((list) => list.filter((x) => x.id !== s.id));
        setConfirming(null);
      } catch {
        setError("Couldn't delete. Try again.");
      }
    });

  return (
    <Card role="region" aria-labelledby="saved-scenarios-heading" data-saved-scenarios>
      <CardHeader>
        <h2 id="saved-scenarios-heading" className="font-heading text-base font-medium">
          Saved scenarios
        </h2>
        <CardDescription>
          Sets of lever changes saved under a name, so they can be tried again or linked to an issue as its fix.
          {canEdit ? " Deleting one can't be undone; an issue that used it as its fix keeps everything else." : " Owners and editors can delete them."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {scenarios.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-fg-2" data-empty="scenarios">
            No saved scenarios.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {scenarios.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-2" data-scenario={s.name}>
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.description ? `${s.description} · ` : ""}
                    {s.patch.length} {s.patch.length === 1 ? "change" : "changes"}
                  </p>
                </div>
                {canEdit &&
                  (confirming === s.id ? (
                    <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`Delete ${s.name}?`}>
                      <span className="text-xs text-fg-2">Delete this scenario?</span>
                      <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => del(s)}>
                        {pending ? "Deleting…" : "Delete"}
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(s.id)} aria-label={`Delete ${s.name}`}>
                      Delete
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
