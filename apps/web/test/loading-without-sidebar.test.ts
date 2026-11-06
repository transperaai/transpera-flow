import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorState } from "@/components/shell/error-state";
import { ShellHeader } from "@/components/shell/shell-header";
import { SidebarTrigger } from "@/components/ui/sidebar";

// The Editor is a full-screen page with no SidebarProvider (WorkspaceShell leaves it out). A loading state or an error screen on that
// route that drew the sidebar toggle threw "useSidebar must be used within a SidebarProvider": the Editor opened on "Try again" (Q12).
// Cause: `p/[processId]/loading.tsx` (the process page's skeleton, with the toggle in its top bar) wraps the `/edit` route too.
// So every loading state renders here with no provider, and so does the shell header the error screen uses.

const ROOT = join(fileURLToPath(new URL("../", import.meta.url)), "src/app");

function loadingFiles(dir: string): string[] {
  const here = existsSync(join(dir, "loading.tsx")) ? [join(dir, "loading.tsx")] : [];
  return [...here, ...readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => loadingFiles(join(dir, e.name)))];
}

const files = loadingFiles(ROOT);

describe("loading states need no SidebarProvider", () => {
  it("finds the loading states, including the Editor's and the process page's that wraps it", () => {
    const names = files.map((f) => relative(ROOT, f));
    expect(names).toContain(join("w", "[slug]", "p", "[processId]", "edit", "loading.tsx"));
    expect(names).toContain(join("w", "[slug]", "p", "[processId]", "loading.tsx"));
    expect(files.length).toBeGreaterThan(15);
  });

  for (const file of files) {
    it(`${relative(ROOT, file)} renders with no provider`, async () => {
      const mod = (await import(/* @vite-ignore */ file)) as { default: () => React.ReactElement };
      expect(() => renderToStaticMarkup(createElement(mod.default))).not.toThrow();
    });
  }

  it("the sidebar toggle and the shell header draw nothing to toggle outside a provider", () => {
    expect(renderToStaticMarkup(createElement(SidebarTrigger))).toBe("");
    const header = renderToStaticMarkup(createElement(ShellHeader, { title: "Something went wrong" }));
    expect(header).toContain("Something went wrong");
    expect(header).not.toContain("Toggle Sidebar");
  });

  it("the error screen the Editor route can fall back to renders with no provider", () => {
    expect(() => renderToStaticMarkup(createElement(ErrorState, { onRetry: () => {} }))).not.toThrow();
  });
});
