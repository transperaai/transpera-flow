// Client branding (issue #34) on a bare page, for ../branding-browser.test.ts. Bundled by esbuild and driven through
// `window.mountBranding`, `window.setBrandStyle` and `window.mountSwitcher`; nothing here ships. The server is stood in for by
// functions that note the write the page asked for (on `window.calls`) and answer as a saved write would.

import { createRoot, type Root } from "react-dom/client";
import { BrandingSettings } from "@/components/branding/branding-settings";
import { TransperaMark } from "@/components/shell/transpera-mark";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { SidebarProvider } from "@/components/ui/sidebar";
import { brandingCss, readBranding, type Branding } from "@/lib/branding/branding";

declare global {
  interface Window {
    mountBranding: (opts: { mode: "live" | "readonly"; branding?: unknown; logoUrl?: string | null; upload?: "ok" | "error" }) => void;
    /** Mount (or, with null, unmount) the layout's `<style data-brand>` for this stored branding. */
    setBrandStyle: (raw: unknown | null) => string | null;
    mountSwitcher: (logo: string | null) => void;
    mountMark: () => void;
    calls: unknown[][];
  }
}

const WS = "0d5f6f0e-0000-4000-8000-000000000001";
const NEW_LOGO = `${WS}/11111111-2222-4333-8444-555555555555.png`;
// A 1x1 transparent PNG: loads, so the sidebar tile and the previews show an <img>.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

window.calls = [];
const log = (...args: unknown[]) => window.calls.push(args);

let root: Root | null = null;
const mountInto = (el: React.ReactNode) => {
  root?.unmount();
  root = createRoot(document.getElementById("root")!);
  root.render(el);
};

window.mountBranding = ({ mode, branding = {}, logoUrl = null, upload = "ok" }) =>
  mountInto(
    <BrandingSettings
      mode={mode}
      workspaceId={WS}
      name="Northbeam Digital"
      branding={readBranding(branding, WS)}
      logoUrl={logoUrl}
      saveAccent={async (_ws, theme, base, value) => {
        log("accent", theme, base, value);
        return { status: "saved", value };
      }}
      removeLogo={async (_ws, base) => {
        log("remove", base);
        return { status: "ok", path: null, url: null };
      }}
      uploadLogo={async (_ws, base, file) => {
        log("upload", file.name, file.type, file.size, base);
        return upload === "ok" ? { status: "ok", path: NEW_LOGO, url: PIXEL } : { status: "error", message: "That image is over 512 KB." };
      }}
    />,
  );

let styleRoot: Root | null = null;
window.setBrandStyle = (raw) => {
  if (!styleRoot) {
    const host = document.createElement("div");
    host.id = "style-host";
    document.body.appendChild(host);
    styleRoot = createRoot(host);
  }
  const css = raw === null ? null : brandingCss(readBranding(raw, WS) as Branding);
  // As the workspace layout renders it: a plain <style>, no href or precedence.
  styleRoot.render(css ? <style data-brand="">{css}</style> : null);
  return css;
};

window.mountMark = () => mountInto(<TransperaMark />);

window.mountSwitcher = (logo) =>
  mountInto(
    <SidebarProvider>
      <WorkspaceSwitcher current="Northbeam Digital" subtitle="Workspace" workspaces={[{ name: "Northbeam Digital", href: "/w/northbeam" }]} logo={logo} />
    </SidebarProvider>,
  );
