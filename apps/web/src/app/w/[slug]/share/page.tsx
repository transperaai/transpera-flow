import { notFound } from "next/navigation";
import { ShareLinksTable } from "@/components/share/share-links-table";
import { Page } from "@/components/shell/page";
import { canEditWorkspace } from "@/lib/access-data";
import { loadWorkspaceHead } from "@/lib/data";
import { loadShareLinks } from "@/lib/share/list";

/**
 * Share links (issue #32, B3): the read-only copies of pages this workspace has shared, listed, updated and turned off in one
 * place. Owners and editors only; everyone else gets a not-found page, as if it weren't there.
 */
export default async function ShareLinksPage(props: PageProps<"/w/[slug]/share">) {
  const { slug } = await props.params;
  const workspace = await loadWorkspaceHead(slug);
  if (!workspace) notFound();
  if (!(await canEditWorkspace(workspace.id))) notFound();
  const links = await loadShareLinks(workspace.id);
  return (
    <Page title="Share links" eyebrow="Company" description="Read-only copies of pages you've shared. A link shows the page as it was when you made it." width="max-w-6xl">
      <ShareLinksTable slug={slug} links={links} />
    </Page>
  );
}
