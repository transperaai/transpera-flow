// A named client's fields (the part of a Set up row under "More"), workspace details and deleting a solution on a bare page, for ../manual-entry-browser.test.ts
// (issue #182, B19). Bundled by esbuild and driven through `window.mountManual`; nothing here ships. The server is stood in
// for by an in-memory store that answers as the server actions do (and, as `refresh()` does, re-renders with what was saved).
// The writes themselves are tested over PostgREST in packages/mcp/test/postgrest-manual-entry.test.ts.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ClientAssignmentRow, ClientRow, ClientServiceRow } from "@transpera-flow/db";
import { ClientMore, type ClientOps } from "@/app/w/[slug]/settings/clients-settings";
import { WorkspaceDetails } from "@/app/w/[slug]/settings/workspace-details";
import { DeleteSolution } from "@/components/solutions/delete-solution";
import { formatWholeCurrency } from "@/lib/format";

declare global {
  interface Window {
    mountManual: (opts: { canEdit: boolean; canManage: boolean }) => void;
    /** Every write the page asked for, as the server action would have received it. */
    calls: unknown[][];
    deleted: string[];
  }
}

const WS = "00000000-0000-4000-8000-000000000001";
const SEO = "10000000-0000-4000-8000-000000000001";
const PPC = "10000000-0000-4000-8000-000000000002";
const AD = "20000000-0000-4000-8000-000000000001";
const AM = "20000000-0000-4000-8000-000000000002";
const MAYA = "30000000-0000-4000-8000-000000000001";
const TOM = "30000000-0000-4000-8000-000000000002";

const client = (id: string, name: string, over: Partial<ClientRow> = {}): ClientRow => ({
  id,
  workspace_id: WS,
  name,
  start_date: "2025-03-01",
  mrr: 3600,
  health: null,
  provenance: {},
  notes: null,
  active: true,
  ...over,
});

function Harness({ canEdit, canManage }: { canEdit: boolean; canManage: boolean }) {
  const [clients, setClients] = useState<ClientRow[]>([
    client("40000000-0000-4000-8000-000000000001", "Harbour Lane Dental"),
    client("40000000-0000-4000-8000-000000000002", "Old Mill Bakery", { active: false, mrr: 1200 }),
  ]);
  const [services, setServices] = useState<ClientServiceRow[]>([{ client_id: "40000000-0000-4000-8000-000000000001", service_id: SEO, workspace_id: WS, start_date: null }]);
  const [assignments, setAssignments] = useState<ClientAssignmentRow[]>([]);
  const [name, setName] = useState("Northbeam");
  const [currency, setCurrency] = useState("AUD");
  const log = (...args: unknown[]) => window.calls.push(args);

  const ops: ClientOps = {
    async saveField(id, field, _base, value) {
      log("field", id, field, value);
      setClients((list) => list.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
      return { status: "saved", value };
    },
    async saveServices(id, workspaceId, _base, next) {
      log("services", id, workspaceId, next);
      setServices((list) => [...list.filter((s) => s.client_id !== id), ...next.map((sid) => ({ client_id: id, service_id: sid, workspace_id: WS, start_date: null }))]);
      return { status: "saved", value: next };
    },
    async saveAssignment(id, workspaceId, roleId, _base, next) {
      log("assignment", id, workspaceId, roleId, next);
      setAssignments((list) => [...list.filter((a) => !(a.client_id === id && a.role_id === roleId)), ...(next ? [{ client_id: id, role_id: roleId, person_id: next, workspace_id: WS }] : [])]);
      return { status: "saved", value: next };
    },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <WorkspaceDetails
        workspaceId={WS}
        name={name}
        currency={currency}
        canManage={canManage}
        saveName={async (_ws, _base, next) => {
          log("workspace name", next);
          setName(next ?? "");
          return { status: "saved", value: next };
        }}
        saveCurrency={async (_ws, _base, next) => {
          log("currency", next);
          setCurrency(next ?? "AUD");
          return { status: "saved", value: next };
        }}
        saveOverhead={async (_ws, _base, next) => {
          log("overheads", next);
          return { status: "saved", value: next };
        }}
      />
      <section role="region" aria-labelledby="clients-heading">
        <h2 id="clients-heading">Clients</h2>
        {clients.map((c) => (
          <details key={c.id} data-client={c.name}>
            <summary>
              {c.name} {formatWholeCurrency(Number(c.mrr), currency)} a month
            </summary>
            <ClientMore
              client={c}
              workspaceId={WS}
              currency={currency}
              clients={clients}
              clientServices={services}
              clientAssignments={assignments}
              services={[
                { id: SEO, name: "SEO", active: true },
                { id: PPC, name: "PPC", active: true },
              ]}
              roles={[
                { id: AD, name: "Account director", active: true },
                { id: AM, name: "Account manager", active: true },
              ]}
              people={[
                { id: MAYA, name: "Maya Collins", active: true },
                { id: TOM, name: "Tom Reid", active: true },
              ]}
              personRoles={[
                { person_id: MAYA, role_id: AD },
                { person_id: TOM, role_id: AM },
              ]}
              canEdit={canEdit}
              ops={ops}
            />
          </details>
        ))}
      </section>
      {canEdit && (
        <DeleteSolution
          name="Second check"
          linked={2}
          remove={async () => {
            log("delete solution");
            return { status: "ok" };
          }}
          onDeleted={() => window.deleted.push("Second check")}
        />
      )}
    </div>
  );
}

window.calls = [];
window.deleted = [];
window.mountManual = (opts) => {
  createRoot(document.getElementById("root")!).render(<Harness {...opts} />);
};
