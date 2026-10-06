import type { Meta, StoryObj } from "@storybook/react-vite";
import { HomeIcon, ListIcon, MapIcon, SettingsIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from "@/components/ui/sidebar";

const meta: Meta = { title: "UI/Sidebar" };
export default meta;

const nav = (
  <>
    <SidebarHeader className="px-3 py-3 font-medium">Transpera Flow</SidebarHeader>
    <SidebarSeparator />
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive>
                <HomeIcon />
                <span>Overview</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <MapIcon />
                <span>Processes</span>
              </SidebarMenuButton>
              <SidebarMenuBadge>4</SidebarMenuBadge>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <ListIcon />
                <span>Issues</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton disabled>
                <SettingsIcon />
                <span>Disabled</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="px-3 py-3 text-xs text-muted-foreground">Footer</SidebarFooter>
  </>
);

/** The static sidebar (`collapsible="none"`), which stays inside the story's frame. */
export const Variants: StoryObj = {
  render: () => (
    <SidebarProvider className="h-96 min-h-0 w-72 overflow-hidden rounded-lg border">
      <Sidebar collapsible="none" className="w-full">
        {nav}
      </Sidebar>
    </SidebarProvider>
  ),
};

/** The docked desktop layout: a fixed sidebar beside the page content. */
export const Layout: StoryObj = {
  tags: ["visual-page"],
  parameters: { layout: "fullscreen" },
  render: () => (
    <SidebarProvider>
      <Sidebar>{nav}</Sidebar>
      <SidebarInset>
        <div className="p-6">Page content beside the sidebar.</div>
      </SidebarInset>
    </SidebarProvider>
  ),
};
