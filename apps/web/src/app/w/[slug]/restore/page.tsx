import { notFound } from "next/navigation";
import { Page } from "@/components/shell/page";
import { RestoreBackup } from "@/components/restore/restore-backup";
import { canEditWorkspace, canManageWorkspace } from "@/lib/access-data";
import { loadWorkspaceHead } from "@/lib/data";
import { NOT_EMPTY_MESSAGE, ROLE_MESSAGE } from "@/lib/restore/errors";
import { workspaceIsEmpty } from "@/lib/restore/empty";
import { authEnv } from "@/lib/auth/env";
import { getDb } from "@/lib/auth/session";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";

/**
 * Restore a backup (issue #39, B10 2b): fill this new, empty workspace from a JSON backup another workspace exported. Only
 * Agency admins and the Owner can; creating the workspace is the Owner's job (ADR 0012), so Agency admins restore into a
 * workspace the Owner has set up for them. Not signed in: the proxy has already redirected.
 */
export default async function RestorePage(props: PageProps<"/w/[slug]/restore">) {
  const { slug } = await props.params;
  const description = "Fill this new workspace from a JSON backup another workspace exported (Export → JSON backup). Every process comes back as a draft of its latest published version; publish each to see its numbers.";
  const refused = (message: string) => (
    <Page title="Restore a backup" eyebrow="Workspace" description={description} width="max-w-3xl">
      <p data-restore-refused className="rounded-token border border-dashed border-line p-6 text-fg-2">
        {message}
      </p>
    </Page>
  );
  if (!authEnv()) return refused("Restoring needs a connected workspace; the demo has none.");
  const head = await loadWorkspaceHead(slug);
  if (!head) notFound();
  if (!(await canEditWorkspace(head.id))) return refused(ROLE_MESSAGE);
  if (!(await workspaceIsEmpty(await getDb(), head.id))) return refused(NOT_EMPTY_MESSAGE);
  return (
    <Page title="Restore a backup" eyebrow="Workspace" description={description} width="max-w-3xl">
      <PhoneReadOnly>
        <RestoreBackup slug={slug} canManage={await canManageWorkspace(head.id)} />
      </PhoneReadOnly>
    </Page>
  );
}
