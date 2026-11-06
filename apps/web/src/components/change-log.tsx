import { History } from "lucide-react";
import type { CompanyModel } from "@transpera-flow/db";
import { EmptyState, SectionCard } from "@/components/page-kit";
import { describeAuditEntry, type AuditEntry } from "@/lib/change-log/audit";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Recent company-model writes from the audit log (owners and agency admins): Settings -> Change log. */
export function ChangeLog({ entries, model, people, stepNames }: { entries: AuditEntry[]; model: CompanyModel; people: Record<string, string>; stepNames: Record<string, string> }) {
  return (
    <SectionCard
      id="changes"
      title="Recent changes to the company model"
      description="Every change to settings, services, people, clients and demand, made in the app. Only Agency admins and the Owner see this log."
    >
      {entries.length === 0 ? (
        <EmptyState icon={History}>No changes yet.</EmptyState>
      ) : (
        <ul className="-mx-2 flex flex-col divide-y divide-line">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 px-2 py-2 text-sm">
              <span className="w-36 shrink-0 text-xs text-fg-3 tabular-nums">{when(e.created_at)}</span>
              <span className="w-48 shrink-0 truncate text-xs text-fg-2">
                {e.actor_kind === "mcp" ? `Claude (API token of ${people[e.actor_id ?? ""] ?? "a user"})` : (people[e.actor_id ?? ""] ?? "Someone")}
                {e.diff.suggestion_id ? " · accepted suggestion" : ""}
              </span>
              <span className="min-w-0 grow">{describeAuditEntry(e, model, stepNames)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
