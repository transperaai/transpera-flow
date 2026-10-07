import { Button } from "@/components/ui/button";

/** What a page shows when it fails (issue #44). `digest` is Next's id for a server error, which matches Sentry and the server logs. */
export function ErrorState({ title = "Something went wrong", digest, onRetry, homeHref = "/" }: { title?: string; digest?: string; onRetry?: () => void; homeHref?: string }) {
  return (
    <section role="alert" className="mx-auto mt-6 w-full max-w-3xl rounded-token border border-line p-6">
      <h1 className="text-base font-bold">{title}</h1>
      <p className="mt-2 text-fg-2">The page couldn&apos;t be shown. Try again, and if it keeps happening, tell us the reference below.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
        <Button variant="outline" asChild>
          {/* A plain link, not next/link: after a crash a full page load is the safest way out. */}
          <a href={homeHref}>Go to your workspaces</a>
        </Button>
      </div>
      {digest && <p className="mt-4 font-mono text-xs text-fg-3">Reference: {digest}</p>}
    </section>
  );
}
