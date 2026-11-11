"use client";

import Link from "next/link";
import { Check, ChevronsUpDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";

export interface SwitcherWorkspace {
  name: string;
  href: string;
}

/**
 * The current workspace at the top of the sidebar. With two or more workspaces it opens the list of them and "All workspaces";
 * with one (a client's deployment, docs/adr/0024-one-workspace-per-deployment.md) it shows the name alone, with no menu.
 */
export function WorkspaceSwitcher({
  current,
  subtitle,
  workspaces,
  allHref = "/",
}: {
  current: string;
  subtitle: string;
  workspaces: SwitcherWorkspace[];
  allHref?: string;
}) {
  const { isMobile } = useSidebar();
  const monogram = current.trim().charAt(0).toUpperCase() || "T";
  const tile = (
    <>
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-accent-fg">
        {monogram}
      </span>
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-semibold text-fg">{current}</span>
        <span className="truncate text-2xs text-muted-foreground">{subtitle}</span>
      </span>
    </>
  );
  // One workspace (a client's deployment): the name alone, with nothing to switch to and no list of workspaces to go back to.
  if (workspaces.length <= 1) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild size="lg" className="cursor-default hover:bg-transparent active:bg-transparent">
            <div role="group" aria-label={`Workspace: ${current}`} data-workspace-name>
              {tile}
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-muted" aria-label={`Workspace: ${current}`}>
              {tile}
              <ChevronsUpDown className="ml-auto text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56 rounded-lg" align="start" side={isMobile ? "bottom" : "right"} sideOffset={8}>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workspaces</DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem key={w.href} asChild>
                <Link href={w.href} aria-current={w.name === current ? "page" : undefined}>
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.name === current && <Check className="size-4 text-accent" aria-hidden />}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={allHref}>All workspaces</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
