import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandingSettings } from "@/components/branding/branding-settings";
import { Page } from "@/components/shell/page";
import { buttonVariants } from "@/components/ui/button";
import { canManageWorkspace } from "@/lib/access-data";
import { logoUrl, readBranding } from "@/lib/branding/branding";
import { loadWorkspaceHead } from "@/lib/data";
import { removeWorkspaceLogo, saveBrandAccent } from "./actions";

/**
 * Settings -> Branding (issue #34, B5): the workspace's logo and accent colour. Everyone in the workspace sees them; owners
 * and agency admins change them (the workspace's own update rule, as for its name and currency).
 */
export default async function BrandingSettingsRoute(props: PageProps<"/w/[slug]/settings/branding">) {
  const { slug } = await props.params;
  const head = await loadWorkspaceHead(slug);
  if (!head) notFound();
  const canManage = await canManageWorkspace(head.id);
  const branding = readBranding(head.branding, head.id);
  return (
    <Page
      title="Branding"
      eyebrow="Settings"
      description="Make this workspace look like the client's: a logo and an accent colour. Changes save as you go."
      actions={
        <Link href={`/w/${slug}/settings`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Back to settings
        </Link>
      }
    >
      <BrandingSettings
        mode={canManage ? "live" : "readonly"}
        workspaceId={head.id}
        name={head.name}
        branding={branding}
        logoUrl={logoUrl(branding.logoPath, process.env.NEXT_PUBLIC_SUPABASE_URL)}
        saveAccent={saveBrandAccent}
        removeLogo={removeWorkspaceLogo}
      />
    </Page>
  );
}
