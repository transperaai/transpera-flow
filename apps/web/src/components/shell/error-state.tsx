"use client";

import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * What a page shows when it fails (issue #44). `digest` is Next's id for a server error, which matches Sentry and the server logs.
 * It sits in the page's frame (the caller owns the gutter); only its text keeps a reading width. On `homeHref` itself the way
 * out would reload the page that just failed, so there it offers only "Try again".
 */
export function ErrorState({ title = "Something went wrong", digest, onRetry, homeHref = "/" }: { title?: string; digest?: string; onRetry?: () => void; homeHref?: string }) {
  const pathname = usePathname();
  const atHome = onRetry !== undefined && pathname === homeHref;
  return (
    <section role="alert" className="w-full rounded-token border border-line p-6">
      <h1 className="text-base font-semibold">{title}</h1>
      <p className="mt-2 max-w-prose text-fg-2">The page couldn&apos;t be shown. Try again, and if it keeps happening, tell us the reference below.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
        {!atHome && (
          <Button variant="outline" asChild>
            {/* A plain link, not next/link: after a crash a full page load is the safest way out. */}
            <a href={homeHref}>Go to your workspaces</a>
          </Button>
        )}
      </div>
      {digest && <p className="mt-4 font-mono text-xs text-fg-3">Reference: {digest}</p>}
    </section>
  );
}
