import Link from "next/link";
import { TransperaMark } from "@/components/shell/transpera-mark";
import { Button, buttonVariants } from "@/components/ui/button";

/** The bar above the pages that sit outside a workspace (the workspace list, API tokens). */
export function AppHeader({ workspace, signedIn }: { workspace?: string; signedIn: boolean }) {
  return (
    <header className="flex h-12 items-center gap-2 border-b">
      {/* "/" is the workspace list, or with one workspace that workspace itself (docs/adr/0024-*). */}
      <Link href="/" className="flex items-center gap-2.5 font-display text-base font-semibold tracking-tight">
        <TransperaMark />
        Transpera Flow
      </Link>
      {workspace && <span className="text-muted-foreground">{workspace}</span>}
      <span className="flex-1" />
      {signedIn && (
        <Link href="/settings/tokens" className={buttonVariants({ variant: "ghost" })}>
          API tokens
        </Link>
      )}
      {signedIn && (
        <form action="/auth/signout" method="post">
          <Button type="submit" variant="ghost">
            Sign out
          </Button>
        </form>
      )}
    </header>
  );
}
