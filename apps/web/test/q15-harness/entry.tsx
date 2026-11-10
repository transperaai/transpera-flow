// The Block library list and the Editor editing a block, on the example agency's four blocks, for ../q15-blocks-browser.test.ts
// (checks and screenshots). Test only, nothing here ships. Server Actions are stand-ins that note each call on `window.__serverActions`.

import { createRoot } from "react-dom/client";
import type { BlockRow, ProcessBundle } from "@transpera-flow/db";
import { BlockLibrary, type BlockRole } from "@/components/blocks/block-library";
import { EditorPhoneGate } from "@/components/editor/editor-phone-gate";
import { EditorView } from "@/components/editor/editor-view";
import { SidebarProvider } from "@/components/ui/sidebar";
import { readBlock } from "@/lib/blocks/blocks";
import type { blockUsers } from "@/lib/blocks/rows";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    __serverActions?: { name: string; args: unknown[] }[];
    q15Data: {
      blocks: BlockRow[];
      users: ReturnType<typeof blockUsers>;
      roles: BlockRole[];
      workspaceId: string;
      bundle: ProcessBundle;
    };
    q15MountLibrary: (o: { editor: boolean; empty?: boolean; base?: "ok" | "none" | "fail" | "fail-once" }) => void;
    q15MountEditor: (o: { blockId: string }) => void;
  }
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const script = window.workerScripts[String(url).split("/").pop()!];
    if (!script) throw new Error("No bundled worker");
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
  }
} as typeof Worker;

window.q15MountLibrary = ({ editor, empty, base = "ok" }) => {
  const d = window.q15Data;
  // Stands in for the Server Action that loads the live bundle of the workspace's first process.
  // "fail-once": the first load fails and the next one works, as when the server was briefly unreachable.
  let calls = 0;
  const openBase = async () => {
    calls++;
    if (base === "fail" || (base === "fail-once" && calls === 1)) throw new Error("down");
    return d.bundle;
  };
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <div className="mx-auto w-full min-w-0 p-4">
        <BlockLibrary
          blocks={empty ? [] : d.blocks}
          mode={editor ? "live" : "readonly"}
          newHref={editor ? "/w/example/p/x/edit?mode=block&from=%2Fw%2Fexample%2Fblocks" : null}
          editBase={editor ? "/w/example/p/x/edit" : null}
          libraryHref="/w/example/blocks"
          workspaceId={d.workspaceId}
          solutionsBase="/w/example"
          users={d.users}
          roles={d.roles}
          slug="example"
          baseProcessId={base === "none" ? null : d.bundle.process.id}
          openBase={openBase}
        />
      </div>
    </SidebarProvider>,
  );
};

window.q15MountEditor = ({ blockId }) => {
  const d = window.q15Data;
  const row = d.blocks.find((b) => b.id === blockId)!;
  createRoot(document.getElementById("root")!).render(
    <EditorPhoneGate backHref="/w/example/blocks">
      <EditorView
        live={d.bundle}
        draft={null}
        mode="live"
        editorMode="block"
        blocks={d.blocks}
        userId="user-a"
        tourDismissed
        exitHref="/w/example/blocks"
        editBlock={{ id: row.id, name: row.name, description: row.description, bundle: readBlock(row.steps) }}
      />
    </EditorPhoneGate>,
  );
};
