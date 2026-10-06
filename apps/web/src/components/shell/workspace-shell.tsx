"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar, type ShellProps } from "./app-sidebar";
import { isEditorPath } from "@/lib/editor/modes";
import { MapPanelRequestProvider } from "./map-panel-request";

/**
 * The frame around every page of a workspace and of the demo (issue #93): the sidebar, and the page as its `<main>`. A share
 * link's page (`mode: "share"`, B3) gets the same providers the screens need, and no nav groups, switcher or counts.
 */
export function WorkspaceShell({ defaultOpen, children, ...sidebar }: (ShellProps | { mode: "share" }) & { defaultOpen: boolean; children: ReactNode }) {
  const pathname = usePathname();
  if (sidebar.mode === "share") {
    return (
      <SidebarProvider defaultOpen={false}>
        <TooltipProvider delayDuration={300}>
          <MapPanelRequestProvider>
            <SidebarInset className="min-w-0">{children}</SidebarInset>
          </MapPanelRequestProvider>
        </TooltipProvider>
      </SidebarProvider>
    );
  }
  // The Editor is its own full-screen page (issue #104): no sidebar, so it can't be mistaken for a page of the app.
  if (isEditorPath(pathname)) return <TooltipProvider delayDuration={300}>{children}</TooltipProvider>;
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <TooltipProvider delayDuration={300}>
        <MapPanelRequestProvider>
          <AppSidebar {...sidebar} />
          <SidebarInset className="min-w-0">{children}</SidebarInset>
        </MapPanelRequestProvider>
      </TooltipProvider>
      {/* The sidebar's Sign out submits this. */}
      {sidebar.mode === "live" && <form id="sign-out" action="/auth/signout" method="post" hidden />}
    </SidebarProvider>
  );
}
