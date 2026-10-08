import Link from "next/link";
import { NewProcessButton, type CreateProcess } from "@/components/new-process-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { EDIT_ONLY } from "@/lib/phone";
import { cn } from "@/lib/utils";

/**
 * What a page shows in a workspace where nothing is published yet (a new client: only the company map, or only drafts), in
 * place of what needs a simulation (issue #243). It isn't a missing page. Members and viewers read a sentence and get no
 * action, name or count.
 */
export function NotPublished({
  what,
  canEdit,
  base,
  firstDraft,
  create,
}: {
  /** One sentence: what this page shows once a process is published. */
  what: string;
  canEdit: boolean;
  /** `/w/<slug>`. */
  base: string;
  /** The oldest draft-only process, if any: the next step is publishing it. */
  firstDraft: { id: string; name: string } | null;
  /** createProcess bound to the workspace; only passed to editors. */
  create?: CreateProcess;
}) {
  return (
    <EmptyState
      data-not-published
      title="Nothing published yet"
      action={
        canEdit ? (
          <>
            {firstDraft ? (
              <Link
                href={`${base}/p/${firstDraft.id}/edit`}
                className={cn(buttonVariants({ size: "sm" }), "bg-edit text-edit-fg hover:bg-edit/90", EDIT_ONLY)}
                data-edit-entry
              >
                ✎ Open {firstDraft.name} to publish it
              </Link>
            ) : (
              create && <NewProcessButton create={create} />
            )}
            <Link href={`${base}/processes`} className="self-center font-medium text-accent hover:underline">
              Open Processes →
            </Link>
          </>
        ) : undefined
      }
    >
      {what} {canEdit ? "Publish a process and this page fills in." : "An owner or editor publishes a process first, then this page fills in."}
    </EmptyState>
  );
}
