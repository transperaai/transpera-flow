"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { useIsPhone } from "@/hooks/use-mobile";

/**
 * The Editor needs a wider screen (issue #44: phones are read-only). Under 640 px it shows a notice instead of its children.
 * The server can't know the width, so a phone gets the Editor's HTML first and the notice right after hydration (accepted).
 * The notice is written into a status region that is always there (empty, and with no box, on a wider screen), so a screen
 * reader announces it when it replaces the Editor.
 * The Editor is outside the sidebar, so the header here has no sidebar toggle (`ShellHeader` needs the sidebar's provider).
 */
export function EditorPhoneGate({ backHref, children }: { backHref: string; children: ReactNode }) {
  const isPhone = useIsPhone();
  return (
    <>
      {!isPhone && children}
      <div role="status" className="contents">
        {isPhone && (
          <div data-phone-gate className="min-h-svh bg-bg">
            <header className="flex h-12 items-center border-b bg-background px-4">
              <span className="text-sm font-medium text-muted-foreground">Editor</span>
            </header>
            <div className="p-4">
              <EmptyState
                title="Editing needs a wider screen"
                action={
                  <Button asChild variant="outline">
                    <Link href={backHref}>Back to the process</Link>
                  </Button>
                }
              >
                Open this on a tablet or computer to edit the process. On a phone you can read everything.
              </EmptyState>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
