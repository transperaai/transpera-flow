import type { Metadata } from "next";
import Link from "next/link";
import { TransperaMark } from "@/components/shell/transpera-mark";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Not found · Transpera Flow" };

/**
 * Every `notFound()` that no deeper not-found catches, and every URL that matches no route: a workspace that doesn't exist (or
 * that you can't see, which reads the same), and pages outside a workspace. Inside a workspace, `app/w/[slug]/not-found.tsx`
 * answers instead and keeps the sidebar.
 */
export default function NotFound() {
  return (
    <main data-not-found className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-4 py-16">
      <p className="flex items-center gap-2.5 font-display text-base font-bold tracking-tight">
        <TransperaMark />
        Transpera Flow
      </p>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-prose text-fg-2">There&apos;s nothing at this address, or you don&apos;t have access to it. Check the link, or start again from the home page.</p>
      <div>
        {/* "/" is the workspace list, or with one workspace that workspace itself (docs/adr/0024-*). */}
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Go to the home page
        </Link>
      </div>
    </main>
  );
}
