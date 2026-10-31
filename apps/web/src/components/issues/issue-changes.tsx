"use client";

// "Changes anchored to this issue" on the issue page (capacity build P8, prototype `pageIssue`): the Sandbox changes that name this issue, with the
// hours each frees a month and how many more clients the department can hold. One run per change, in the worker, only while this page is open.

import { useMemo } from "react";
import type { CapacityChangeRow, CapacitySetup, ProcessBundle } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Card } from "@/components/ui/card";
import { capacityBaseModel } from "@/lib/capacity/model";
import { formatNumber } from "@/lib/format";
import { ISSUE_PAGE_HELP } from "@/lib/issues/help";
import { useIssueChangeRuns } from "@/lib/sim/use-issue-change-runs";

const KIND_WORDS: Record<CapacityChangeRow["kind"], string> = { automation: "Automation", augmentation: "Augmentation" };
const CARD_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

/** "+3", "−2", "0": a signed whole number. */
export const signedWhole = (v: number): string => {
  const r = Math.round(v);
  return r === 0 ? "0" : `${r > 0 ? "+" : "−"}${formatNumber(Math.abs(r), 0)}`;
};

export function IssueChanges({ changes, setup, bundle, base }: { changes: CapacityChangeRow[]; setup: CapacitySetup; bundle: ProcessBundle; base: string }) {
  const built = useMemo(() => (changes.length ? capacityBaseModel(bundle) : { model: null, error: null }), [bundle, changes.length]);
  const runs = useIssueChangeRuns(setup, built.model, changes);
  return (
    <section className="flex flex-col gap-2" data-section="changes">
      <div>
        <h2 className={`${CARD_TITLE} flex items-center`}>
          Changes anchored to this issue
          <Help {...ISSUE_PAGE_HELP.changes} />
        </h2>
        <p className="text-sm text-muted-foreground">
          Sandbox automations and augmentations that name this issue, each run on its own against today.{" "}
          <a href={`${base}/sandbox`} className="font-medium text-accent hover:underline">
            Open the Sandbox
          </a>
        </p>
      </div>
      {changes.length === 0 ? (
        <Card className="px-4 py-6 text-sm text-muted-foreground" data-empty="changes">
          No changes anchored to this issue yet. In the Sandbox, add an automation or augmentation and pick this issue as the one it fixes.
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[32rem] text-left text-sm" data-changes-table>
            <thead>
              <tr className="border-b border-border text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                <th className="px-4 py-2">Change</th>
                <th className="px-3 py-2 text-right">Hours freed a month</th>
                <th className="px-3 py-2 text-right">More clients the department can hold</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => {
                const f = runs.figures[c.id];
                return (
                  <tr key={c.id} className="border-b border-border last:border-0" data-change-row={c.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{KIND_WORDS[c.kind]}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" data-freed>
                      {f ? formatNumber(f.freed, 0) : "…"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums" data-more-clients>
                      {f ? signedWhole(f.moreClients) : "…"}
                      {f?.department && <div className="text-xs text-muted-foreground">{f.department.name}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {built.error && (
        <p role="alert" className="text-sm text-destructive" data-changes-error>
          The figures can&apos;t be worked out yet: {built.error}
        </p>
      )}
      {runs.status === "running" && (
        <p role="status" className="text-sm text-muted-foreground" data-changes-progress>
          Working out {runs.done} of {runs.total} changes…
        </p>
      )}
      {runs.status === "error" && (
        <p role="alert" className="text-sm text-destructive" data-changes-error>
          {runs.error ?? "The runs failed."}
        </p>
      )}
    </section>
  );
}
