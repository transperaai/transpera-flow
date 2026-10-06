"use client";

import type { ReactNode } from "react";
import { NO_LINK_TARGETS } from "@transpera-flow/db";
import { SourceLinkingProvider } from "@/components/sources/linking";

/** The Sources blocks read this provider; in a share link's page it holds no sources and no links, and changes nothing ("+ Link" is hidden). */
export function ShareLinkingScope({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return (
    <SourceLinkingProvider workspaceId={workspaceId} mode="share" sources={[]} links={[]} targets={NO_LINK_TARGETS}>
      {children}
    </SourceLinkingProvider>
  );
}
