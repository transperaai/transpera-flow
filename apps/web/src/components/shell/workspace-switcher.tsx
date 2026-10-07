"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronsUpDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";

export interface SwitcherWorkspace {
  name: string;
  href: string;
}

/** The current workspace at the top of the sidebar; opens the list of workspaces (or, on the demo, the two sample agencies). */
export function WorkspaceSwitcher({
  current,
  subtitle,
  workspaces,
  allHref = "/",
  logo = null,
}: {
  current: string;
  subtitle: string;
  workspaces: SwitcherWorkspace[];
  allHref?: string;
  /** The client's logo (a public URL), shown on a white tile instead of the monogram (issue #34). */
  logo?: string | null;
}) {
  const { isMobile } = useSidebar();
  const monogram = current.trim().charAt(0).toUpperCase() || "T";
  // A logo that fails to load (the object was deleted) falls back to the monogram, never a broken image.
  const [broken, setBroken] = useState<string | null>(null);
  const showLogo = logo !== null && broken !== logo;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-muted" aria-label={`Workspace: ${current}`}>
              {showLogo ? (
                <span aria-hidden data-allow-light className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-logo-tile ring-1 ring-line">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a small public logo; no optimiser, no remotePatterns */}
                  <img src={logo} alt="" decoding="async" className="size-full object-contain p-0.5" onError={() => setBroken(logo)} />
                </span>
              ) : (
                <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-accent font-display text-sm font-bold text-accent-fg">
                  {monogram}
                </span>
              )}
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold text-fg">{current}</span>
                <span className="truncate text-2xs text-muted-foreground">{subtitle}</span>
              </span>
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
