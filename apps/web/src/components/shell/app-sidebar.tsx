"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronsUpDown,
  CircleAlert,
  KeyRound,
  Layers,
  LayoutGrid,
  Lightbulb,
  LogOut,
  Network,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { workspaceNav, type CountTone, type NavCounts, type NavIcon, type NavItem } from "@/lib/shell/nav";
import { cn } from "@/lib/utils";
import { TransperaMark } from "./transpera-mark";
import { WorkspaceSwitcher, type SwitcherWorkspace } from "./workspace-switcher";

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutGrid,
  processes: Network,
  issues: CircleAlert,
  solutions: Lightbulb,
  library: Layers,
  people: Users,
  sandbox: TrendingUp,
  settings: Settings2,
  access: ShieldCheck,
};

const BADGE: Record<CountTone, string> = {
  plain: "bg-muted text-fg-2",
  warn: "border border-warn bg-warn-soft text-fg",
};

export type ShellProps = {
  mode: "live";
  slug: string;
  workspaceName: string;
  /** The workspace's logo (a public URL), or null: the monogram stays (client branding, issue #34). */
  logoUrl: string | null;
  workspaces: SwitcherWorkspace[];
  canManage: boolean;
  counts: NavCounts;
  viewer: { name: string; email: string | null } | null;
};

export function AppSidebar(props: ShellProps) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const groups = workspaceNav({ slug: props.slug, pathname, canManage: props.canManage, counts: props.counts });

  const item = (i: NavItem) => {
    const Icon = ICONS[i.icon];
    const showCount = i.count !== undefined && i.count > 0;
    return (
      <SidebarMenuItem key={i.key}>
        <SidebarMenuButton
          asChild
          isActive={i.active}
          tooltip={showCount ? `${i.label} · ${i.count}` : i.label}
          className="data-active:bg-panel data-active:shadow-xs data-active:ring-1 data-active:ring-line data-active:[&_svg]:text-accent"
        >
          <Link
            href={i.href}
            aria-current={i.active ? "page" : undefined}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
          >
            <Icon />
            <span>{i.label}</span>
            {showCount && <span className="sr-only">, {i.count} {i.countNoun ?? ""}</span>}
          </Link>
        </SidebarMenuButton>
        {showCount && (
          <SidebarMenuBadge aria-hidden className={cn("rounded-full font-mono text-[11px]", BADGE[i.tone ?? "plain"])}>
            {i.count}
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3">
        <div className="flex items-center gap-2.5 px-2 pt-1">
          <TransperaMark />
          <span className="truncate font-display text-base font-bold tracking-tight group-data-[collapsible=icon]:hidden">Transpera Flow</span>
        </div>
        <WorkspaceSwitcher current={props.workspaceName} subtitle="Workspace" workspaces={props.workspaces} logo={props.logoUrl} />
      </SidebarHeader>
      <SidebarContent>
        {groups.map((g) => (
          <SidebarGroup key={g.key}>
            {g.label && <SidebarGroupLabel className="text-2xs font-semibold tracking-wider uppercase">{g.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>{g.items.map(item)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser viewer={props.viewer} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The signed-in person at the foot of the sidebar: their token page and Sign out. */
function NavUser({ viewer }: { viewer: { name: string; email: string | null } | null }) {
  const { isMobile } = useSidebar();
  const name = viewer?.name ?? "Account";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-muted" aria-label={`Account: ${name}`}>
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-fg">
                {name.charAt(0).toUpperCase()}
              </span>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium text-fg">{name}</span>
                {viewer?.email && <span className="truncate text-2xs text-muted-foreground">{viewer.email}</span>}
              </span>
              <ChevronsUpDown className="ml-auto text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56 rounded-lg" align="end" side={isMobile ? "bottom" : "right"} sideOffset={8}>
            <DropdownMenuLabel className="font-normal">
              <span className="block truncate text-sm font-medium text-fg">{name}</span>
              {viewer?.email && <span className="block truncate text-xs text-muted-foreground">{viewer.email}</span>}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/tokens">
                <KeyRound /> API tokens
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => (document.getElementById("sign-out") as HTMLFormElement | null)?.requestSubmit()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
