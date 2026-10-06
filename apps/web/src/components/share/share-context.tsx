"use client";

import { createContext, useContext } from "react";

/** What a shared view hides, for the figures a toggle governs. Absent (null) anywhere but inside a share link's page. */
export interface ShareContextValue {
  /** Costs, margins and overhead are shown. Off: money costs read "—" (revenue stays). */
  financials: boolean;
}

export const ShareContext = createContext<ShareContextValue | null>(null);

/** True inside a share link's page whose Financials toggle is off: money costs must show "—" with an (i). False everywhere else. */
export function useShareFinancialsHidden(): boolean {
  const ctx = useContext(ShareContext);
  return ctx !== null && !ctx.financials;
}

/** True inside a share link's page. */
export function useInShare(): boolean {
  return useContext(ShareContext) !== null;
}
