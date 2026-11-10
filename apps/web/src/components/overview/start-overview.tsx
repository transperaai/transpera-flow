import Link from "next/link";
import { Circle, CircleCheck } from "lucide-react";
import { Help } from "@/components/help";
import { NewProcessButton, type CreateProcess } from "@/components/new-process-dialog";
import { UploadProcessButton, type UploadProcess } from "@/components/processes/upload-process-dialog";
import { PageHeader } from "@/components/page-kit";
import { EmptyState } from "@/components/shell/empty-state";
import { pageBodyClass } from "@/components/shell/page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { ShellHeader } from "@/components/shell/shell-header";
import { buttonVariants } from "@/components/ui/button";
import { EDIT_ONLY } from "@/lib/phone";
import type { SetupItem } from "@/lib/overview/setup";
import { cn } from "@/lib/utils";

/** One panel of the start page: a bordered surface with a plain heading (no card inside it). */
function Panel({ title, children, className, ...rest }: { title: string; children: React.ReactNode; className?: string } & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-card p-5", className)} {...rest}>
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The Overview of a workspace with nothing published (a new client; issue #243): for editors, the ways to build it out
 * (New process, Upload process, the company map) and a checklist ticked from counts, with the other ways to start (Claude, a backup)
 * beside it; for members and viewers, one plain sentence, with no names, counts or buttons (#30). All data comes in as props, so it
 * renders in tests and Storybook.
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
  /** The workspace is still empty enough to restore a backup into (lib/restore/empty.ts) and the viewer may. */
  canRestore: boolean;
}) {
  const base = `/w/${slug}`;
  if (!canEdit) {
    return (
      <div>
        <ShellHeader title="Overview" />
        <div className={pageBodyClass()}>
          <EmptyState data-start-overview title={`${name} has nothing published yet`}>
            <p className="max-w-prose">The Overview shows the company map, headline numbers and trends once an Agency admin publishes a process.</p>
          </EmptyState>
        </div>
      </div>
    );
  }
  return (
    <div>
      <ShellHeader title="Overview" />
      <div className={pageBodyClass()} data-start-overview>
        <PageHeader
          label="Overview"
          title={`Set up ${name}`}
          meta={
            <p className="max-w-prose text-sm text-fg-2">
              Build the company&apos;s processes by hand, upload them from a file, or lay out the company map. The Overview shows the map, headline numbers
              and trends once a process is published.
            </p>
          }
          below={<PhoneNotice />}
          actionsLabel="Ways to build"
          actions={
            <>
              {companyEditHref && (
                <Link href={companyEditHref} data-build-company-map data-edit-entry className={cn(buttonVariants({ variant: "outline" }), EDIT_ONLY)}>
                  <span aria-hidden className="text-edit">
                    ✎
                  </span>
                  Build the company map
                </Link>
              )}
              {upload && <UploadProcessButton upload={upload} />}
              {create && <NewProcessButton create={create} />}
            </>
          }
        />
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
            {checklist && (
              <Panel title="Getting started" data-setup-checklist>
                <ol className="flex flex-col divide-y divide-line">
                  {checklist.map((item) => (
                    <li key={item.key} data-setup-item={item.key} data-done={item.done ? "" : undefined} className="flex items-center gap-2.5 py-2.5 first:pt-0 last:pb-0">
                      {item.done ? <CircleCheck aria-hidden className="size-4 shrink-0 text-good" /> : <Circle aria-hidden className="size-4 shrink-0 text-fg-3" />}
                      <Link href={item.href} className={cn("font-medium hover:underline", item.done ? "text-fg-2" : "text-accent")}>
                        {item.label}
                      </Link>
                      <span className="sr-only">{item.done ? "(done)" : "(to do)"}</span>
                    </li>
                  ))}
                </ol>
                <p className="max-w-prose text-sm text-fg-2">New processes get a card on the company map. Arrange the cards and draw the handoffs between them in its Editor.</p>
              </Panel>
            )}
            {drafts.length > 0 && (
              <Panel title="Not published yet">
                <p className="text-sm text-fg-2">These haven&apos;t been published yet:</p>
                <ul className="list-disc pl-5 text-sm">
                  {drafts.map((p) => (
                    <li key={p.id}>
                      <Link href={`${base}/p/${p.id}`} className="font-semibold hover:underline">
                        {p.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
          <Panel title="Other ways to start" className="lg:col-span-4">
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold">With Claude</h3>
              <p className="text-sm text-fg-2">
                Ask Claude to turn your interviews, notes or SOPs into a process file, then choose Upload process above. Claude can read the workspace once
                it&apos;s connected (it can&apos;t change anything): create a token under{" "}
                <Link href="/settings/tokens" className="underline">
                  API tokens
                </Link>
                .
              </p>
            </div>
            {canRestore && (
              <div data-restore-card className="flex flex-col gap-1.5 border-t border-line pt-3">
                <h3 className="text-sm font-semibold">
                  Restore a backup
                  <Help
                    label="Restore a backup"
                    description="Every process comes back as a draft of its latest published version. Publish each to see its numbers. Older versions, history and solutions stay in the file."
                    example="Restore northbeam-workspace-2026-10-05.json into a new workspace made for Northbeam."
                  />
                </h3>
                <p className="text-sm text-fg-2">Fill this new workspace from a JSON backup another workspace exported.</p>
                <p className="rounded-md border-l-2 border-warn bg-warn-soft px-3 py-2 text-sm" data-restore-only-empty>
                  <b className="font-semibold">Only into an empty workspace.</b> Restore before you add anything: the first role, person, client, process,
                  issue or source you add closes this option.
                </p>
                <p className="text-sm">
                  <Link href={`${base}/restore`} className="font-semibold underline">
                    Choose a backup file
                  </Link>
                </p>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
