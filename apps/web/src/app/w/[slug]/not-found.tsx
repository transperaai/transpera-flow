"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { pageBodyClass } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import { buttonVariants } from "@/components/ui/button";

/**
 * A `notFound()` from a page of a workspace (a process, issue or solution that doesn't exist, or that you can't see). It
 * renders inside the workspace layout, so the sidebar stays. A missing workspace is thrown by that layout itself, which this
 * file doesn't wrap, so it falls to `app/not-found.tsx`. Not-found files get no props: the slug comes from the URL.
 */
export default function WorkspaceNotFound() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <div>
      <ShellHeader title="Not found" />
      <div className={pageBodyClass()}>
        <section data-not-found className="w-full rounded-token border border-line p-6">
          <h1 className="text-base font-semibold">Page not found</h1>
          <p className="mt-2 max-w-prose text-fg-2">
            This page isn&apos;t in the workspace. It may have been deleted or archived, or the link may be wrong.
          </p>
          <div className="mt-4">
            <Link href={`/w/${slug}/overview`} className={buttonVariants({ variant: "outline" })}>
              Go to the Overview
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
