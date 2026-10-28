import type { CompanyModel } from "@transpera-flow/db";
import { describeAuditEntry, type AuditEntry } from "@/lib/change-log/audit";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Recent company-model writes from the audit log (owners and agency admins): Settings -> Change log. */
export function ChangeLog({ entries, model, people, stepNames }: { entries: AuditEntry[]; model: CompanyModel; people: Record<string, string>; stepNames: Record<string, string> }) {
  return (
    <section aria-labelledby="changes-heading">
      <h2 id="changes-heading" className="mb-1 text-base font-bold">
        Recent changes to the company model
      </h2>
      <p className="mb-2 text-fg-2">Every change to settings, services, people, clients and demand, made in the app. Only owners see this log.</p>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">No changes yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-panel shadow-xs">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 px-3 py-1.5 text-sm">
              <span className="w-36 shrink-0 text-xs text-fg-3 tabular-nums">{when(e.created_at)}</span>
              <span className="w-48 shrink-0 truncate text-xs text-fg-2">
                {e.actor_kind === "mcp" ? `Claude (API token of ${people[e.actor_id ?? ""] ?? "a user"})` : (people[e.actor_id ?? ""] ?? "Someone")}
              </span>
              <span className="min-w-0 grow">{describeAuditEntry(e, model, stepNames)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
