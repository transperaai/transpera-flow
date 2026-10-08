import Link from "next/link";
import { Circle, CircleCheck } from "lucide-react";
import { Help } from "@/components/help";
import { NewProcessButton, type CreateProcess } from "@/components/new-process-dialog";
import { UploadProcessButton, type UploadProcess } from "@/components/processes/upload-process-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { ShellHeader } from "@/components/shell/shell-header";
import { buttonVariants } from "@/components/ui/button";
import { EDIT_ONLY } from "@/lib/phone";
import type { SetupItem } from "@/lib/overview/setup";
import { cn } from "@/lib/utils";

/**
 * The Overview of a workspace with nothing published (a new client; issue #243): for editors, the ways to build it out
 * (New process, Upload process, the company map) and a checklist ticked from counts; for members and viewers, one plain
 * sentence, with no names, counts or buttons (#30). All data comes in as props, so it renders in tests and Storybook.
 */
export function StartOverview({
  slug,
  name,
  canEdit,
  checklist,
  drafts,
  companyEditHref,
  create,
  upload,
  canRestore,
}: {
  slug: string;
  name: string;
  canEdit: boolean;
  /** Editors only. */
  checklist: SetupItem[] | null;
  /** Processes not yet published (editors only). */
  drafts: { id: string; name: string }[];
  /** `${base}/p/${companyId}/edit?from=${encodeURIComponent(base)}`: editors with a company map only. */
  companyEditHref: string | null;
  create?: CreateProcess;
  upload?: UploadProcess;
  canRestore: boolean;
}) {
  const base = `/w/${slug}`;
  if (!canEdit) {
    return (
      <div>
        <ShellHeader title="Overview" />
        <div className="mx-auto mt-6 w-full max-w-3xl">
          <EmptyState data-start-overview title={`${name} has nothing published yet`}>
            The Overview shows the company map, headline numbers and trends once an owner or editor publishes a process.
          </EmptyState>
        </div>
      </div>
    );
  }
  return (
    <div>
      <ShellHeader title="Overview" />
      <section data-start-overview className="mx-auto mt-6 w-full max-w-3xl rounded-token border border-line p-6">
        <h1 className="text-base font-bold">Set up {name}</h1>
        <p className="mt-2 text-fg-2">
          Build the company&apos;s processes by hand, upload them from a file, or lay out the company map. The Overview shows the map, headline numbers and trends once a process is published.
        </p>
        <PhoneNotice />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {create && <NewProcessButton create={create} />}
          {upload && <UploadProcessButton upload={upload} />}
          {companyEditHref && (
            <Link
              href={companyEditHref}
              data-build-company-map
              data-edit-entry
              className={cn(buttonVariants({ size: "sm" }), "bg-edit text-edit-fg hover:bg-edit/90", EDIT_ONLY)}
            >
              ✎ Build the company map
            </Link>
          )}
        </div>
        <p className="mt-3 text-sm text-fg-2">New processes get a card on the company map. Arrange the cards and draw the handoffs between them in its Editor.</p>
      </section>
      {checklist && (
        <section data-setup-checklist className="mx-auto mt-4 w-full max-w-3xl rounded-token border border-line p-6">
          <h2 className="text-base font-bold">Getting started</h2>
          <ol className="mt-3 space-y-2">
            {checklist.map((item) => (
              <li key={item.key} data-setup-item={item.key} data-done={item.done ? "" : undefined} className="flex items-center gap-2">
                {item.done ? <CircleCheck aria-hidden className="size-4 shrink-0 text-good" /> : <Circle aria-hidden className="size-4 shrink-0 text-fg-3" />}
                <Link href={item.href} className="font-medium text-accent hover:underline">
                  {item.label}
                </Link>
                <span className="sr-only">{item.done ? "(done)" : "(to do)"}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {drafts.length > 0 && (
        <section className="mx-auto mt-4 w-full max-w-3xl rounded-token border border-line p-6">
          <p className="text-fg-2">These haven&apos;t been published yet:</p>
          <ul className="mt-1 list-disc pl-5">
            {drafts.map((p) => (
              <li key={p.id}>
                <Link href={`${base}/p/${p.id}`} className="font-semibold hover:underline">
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mx-auto mt-4 w-full max-w-3xl rounded-token border border-line p-4">
        <h2 className="text-sm font-bold">Other ways to start</h2>
        <p className="mt-2 text-sm text-fg-2">
          Import with Claude: import a process with Claude (<code>set_active_workspace</code>, then <code>import_process</code>). Create a token under{" "}
          <Link href="/settings/tokens" className="underline">
            API tokens
          </Link>{" "}
          to connect it.
        </p>
        {canRestore && (
          <div data-restore-card className="mt-4 border-t border-line pt-4">
            <h3 className="text-sm font-bold">
              Restore a backup
              <Help
                label="Restore a backup"
                description="Every process comes back as a draft of its latest published version. Publish each to see its numbers. Older versions, history and solutions stay in the file."
                example="Restore northbeam-workspace-2026-10-05.json into a new workspace made for Northbeam."
              />
            </h3>
            <p className="mt-2 text-sm text-fg-2">Fill this new workspace from a JSON backup another workspace exported.</p>
            <p className="mt-3 text-sm">
              <Link href={`${base}/restore`} className="font-semibold underline">
                Choose a backup file
              </Link>
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
