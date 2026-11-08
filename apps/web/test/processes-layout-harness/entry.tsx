// The whole Processes page (header buttons, toolbar, table, row menu, Change type dialog) on a bare page with the app's stylesheet,
// for ../processes-layout-browser.test.ts. Bundled with ../build-harness.ts; nothing here ships. The server is stood in for by an
// in-memory store, as in ../process-admin-harness/entry.tsx; every write is noted on `window.calls`.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProcessCategory } from "@transpera-flow/db";
import { ProcessesPage } from "@/components/processes/processes-page";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { ArchivedProcess, ProcessAdminOps, ProcessKind } from "@/lib/processes/admin";
import { processRows, type ProcessFacts } from "@/lib/processes/rows";

declare global {
  interface Window {
    mountProcessesLayout: (opts: { canEdit: boolean; published: boolean }) => void;
    calls: unknown[][];
  }
}

const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const fact = (n: number, name: string, kind: ProcessKind, category: ProcessCategory, parentId: string | null = null): ProcessFacts => ({
  id: id(n),
  name,
  kind,
  category,
  description: null,
  parentId,
  live: true,
  draft: false,
});

const START: ProcessFacts[] = [
  fact(1, "Lead to signed retainer", "pipeline", "sales"),
  fact(2, "Client onboarding", "servicing", "onboarding"),
  fact(3, "Monthly reporting", "servicing", "routine_client_work"),
  fact(4, "Website change requests", "servicing", "ad_hoc"),
  fact(5, "Quarterly planning", "servicing", "internal"),
  fact(6, "Creative review", "servicing", "routine_client_work", id(3)),
];

function Harness({ canEdit, published }: { canEdit: boolean; published: boolean }) {
  const [facts, setFacts] = useState(START);
  const [archived] = useState<ArchivedProcess[]>([{ id: id(9), name: "Old audit", kind: "pipeline", archivedAt: "2026-09-20T10:00:00Z" }]);
  const log = (...args: unknown[]) => window.calls.push(args);
  const rows = processRows({ processes: facts, steps: [], issues: [], versions: new Map() });
  const ops: ProcessAdminOps = {
    async rename(pid, name) {
      log("rename", pid, name);
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
      return { status: "ok" };
    },
    async restore(pid) {
      log("restore", pid);
      return { status: "ok" };
    },
  };
  return (
    <ProcessesPage
      rows={rows}
      hrefs={Object.fromEntries([...facts, ...archived].map((p) => [p.id, `/w/northbeam/p/${p.id}`]))}
      companyMap={published ? { href: "/w/northbeam", edit: false, editHref: canEdit ? "/w/northbeam/edit" : undefined } : canEdit ? { href: "/w/northbeam/edit", edit: true } : undefined}
      companyHistoryHref={published ? "/w/northbeam/history" : undefined}
      companyRow={published ? { version: { number: 4, publishedAt: "2026-09-29T10:00:00Z" }, draft: true, href: "/w/northbeam", historyHref: "/w/northbeam/history", editHref: canEdit ? "/w/northbeam/edit" : undefined } : undefined}
      loadCard={async () => null}
      create={canEdit ? async () => ({}) : undefined}
      upload={canEdit ? { preview: async () => ({ error: "Not in this test." }), create: async () => ({ error: "Not in this test." }) } : undefined}
      archived={archived}
      admin={canEdit ? ops : undefined}
    />
  );
}

window.calls = [];
window.mountProcessesLayout = ({ canEdit, published }) => {
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <Harness canEdit={canEdit} published={published} />
    </SidebarProvider>,
  );
};
