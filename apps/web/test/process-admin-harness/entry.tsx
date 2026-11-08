// The Processes page's list with its admin (issue #182, B19 2/2) on a bare page, for ../process-admin-browser.test.ts. Bundled
// with ../build-harness.ts and driven through `window.mountProcessAdmin`; nothing here ships. The server is stood in for by an
// in-memory store that answers as the server actions do (and, as `router.refresh()` does, re-renders with what was saved). The
// writes themselves are tested over PostgREST (packages/mcp/test/postgrest-process-admin.test.ts) and in the database
// (packages/db/test/process-archive.test.ts).

import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProcessCategory } from "@transpera-flow/db";
import { NewProcessButton } from "@/components/new-process-dialog";
import { ArchivedBanner } from "@/components/processes/archived-banner";
import { ProcessesList } from "@/components/processes/processes-list";
import type { ArchivedProcess, ProcessAdminOps, ProcessKind } from "@/lib/processes/admin";
import { processRows, type ProcessFacts } from "@/lib/processes/rows";

declare global {
  interface Window {
    mountProcessAdmin: (opts: { canEdit: boolean; refuseArchive?: string }) => void;
    /** An archived process's banner; `refuse` makes Restore answer with that message. */
    mountArchivedBanner: (opts: { canEdit: boolean; refuse?: string }) => void;
    /** Every write the page asked for, as the server action would have received it. */
    calls: unknown[][];
  }
}

const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const START: ProcessFacts[] = [
  { id: id(1), name: "Sales", kind: "pipeline", category: "sales", description: "Win new retainers.", parentId: null, live: true, draft: false },
  { id: id(2), name: "Onboarding", kind: "pipeline", category: "onboarding", description: null, parentId: id(1), live: true, draft: false },
  { id: id(3), name: "Monthly reporting", kind: "servicing", category: "routine_client_work", description: null, parentId: null, live: true, draft: false },
  { id: id(4), name: "Ad-hoc requests", kind: "servicing", category: "ad_hoc", description: null, parentId: null, live: false, draft: true },
];

function Harness({ canEdit, refuseArchive }: { canEdit: boolean; refuseArchive?: string }) {
  const [facts, setFacts] = useState(START);
  const [archived, setArchived] = useState<ArchivedProcess[]>([{ id: id(9), name: "Old audit", kind: "pipeline", archivedAt: "2026-09-20T10:00:00Z" }]);
  const log = (...args: unknown[]) => window.calls.push(args);
  const rows = processRows({ processes: facts, steps: [], issues: [], versions: new Map() });

  const ops: ProcessAdminOps = {
    async rename(pid, name) {
      log("rename", pid, name);
      if (facts.some((p) => p.id !== pid && p.name.toLowerCase() === name.toLowerCase())) return { status: "error", message: `There is already a process called '${name}'.` };
      setFacts((list) => list.map((p) => (p.id === pid ? { ...p, name } : p)));
      return { status: "ok" };
    },
    async changeKind(pid, kind: ProcessKind) {
      log("kind", pid, kind);
      setFacts((list) => list.map((p) => (p.id === pid ? { ...p, kind } : p)));
      return { status: "ok" };
    },
    async changeCategory(pid, category: ProcessCategory) {
      log("category", pid, category);
      setFacts((list) => list.map((p) => (p.id === pid ? { ...p, category } : p)));
      return { status: "ok" };
    },
    async archive(pid) {
      log("archive", pid);
      if (refuseArchive) return { status: "error", message: refuseArchive };
      const p = facts.find((x) => x.id === pid)!;
      setFacts((list) => list.filter((x) => x.id !== pid));
      setArchived((list) => [{ id: p.id, name: p.name, kind: p.kind, archivedAt: "2026-10-05T09:00:00Z" }, ...list]);
      return { status: "ok" };
    },
    async restore(pid) {
      log("restore", pid);
      const p = archived.find((x) => x.id === pid)!;
      setArchived((list) => list.filter((x) => x.id !== pid));
      setFacts((list) => [...list, { id: p.id, name: p.name, kind: p.kind, category: p.kind === "pipeline" ? "sales" : "routine_client_work", description: null, parentId: null, live: true, draft: false }]);
      return { status: "ok" };
    },
  };

  return (
    <main className="flex flex-col gap-4 p-4">
      {canEdit && (
        <NewProcessButton
          create={async (_prev, form) => {
            log("create", form.get("name"), form.get("category"));
            return form.get("category") ? {} : { error: "Choose what kind of process it is." };
          }}
        />
      )}
      <ProcessesList
        rows={rows}
        hrefs={Object.fromEntries([...facts, ...archived].map((p) => [p.id, `/w/northbeam/p/${p.id}`]))}
        loadCard={async () => null}
        archived={archived}
        admin={canEdit ? ops : undefined}
      />
    </main>
  );
}

window.calls = [];
window.mountProcessAdmin = (opts) => {
  createRoot(document.getElementById("root")!).render(<Harness {...opts} />);
};

window.mountArchivedBanner = ({ canEdit, refuse }) => {
  const restore = async () => {
    window.calls.push(["restore", id(3)]);
    return refuse ? ({ status: "error", message: refuse } as const) : ({ status: "ok" } as const);
  };
  createRoot(document.getElementById("root")!).render(<ArchivedBanner name="Monthly reporting" archivedAt="2026-10-03T09:00:00Z" restore={canEdit ? restore : undefined} />);
};
