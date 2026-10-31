import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Links into a section of Settings (`/settings#roles-heading`) land on the section's heading, whose id is `<section id>-heading`
// (SettingsSection). A link to `#workspace` or `#simulation` (the section id without "-heading") pointed at nothing, so the page
// opened at the top instead of the section: the Sandbox's "Set them in Settings, under Workspace" and the calibration panels'.

const SRC = new URL("../src/", import.meta.url).pathname;
const SETTINGS = join(SRC, "app/w/[slug]/settings");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("links into Settings", () => {
  const sections = new Set(files(SETTINGS).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/<SettingsSection\s+id="([^"]+)"/g)].map((m) => `${m[1]}-heading`)));

  it("finds the sections", () => {
    expect(sections).toContain("workspace-heading");
    expect(sections).toContain("people-heading");
  });

  it("point at a section heading that exists", () => {
    const links = files(SRC).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/(?:\/settings|[pP]eopleHref\})#([a-z0-9-]+)/g)].map((m) => ({ file: f.slice(SRC.length), anchor: m[1]! })));
    expect(links.length).toBeGreaterThan(5);
    for (const l of links) expect(sections.has(l.anchor), `${l.file}: #${l.anchor}`).toBe(true);
  });
});

// The same for the Set up pages (capacity build P1): Tiers & clients and People & roles, whose sections come from components/setup and
// the Settings parts they reuse. A link to `/setup/people#roles-heading` must land on a heading of that page.
describe("links into Set up", () => {
  const PAGES: Record<string, string[]> = {
    clients: ["components/setup/tiers-clients.tsx", "app/w/[slug]/settings/services-settings.tsx", "app/w/[slug]/settings/client-groups-settings.tsx", "app/w/[slug]/settings/clients-settings.tsx"],
    people: ["components/setup/people-roles.tsx", "app/w/[slug]/settings/roles-settings.tsx", "app/w/[slug]/settings/people-settings.tsx"],
  };
  const sectionsOf = (page: string) =>
    new Set(PAGES[page]!.flatMap((f) => [...readFileSync(join(SRC, f), "utf8").matchAll(/<SettingsSection\s+(?:\n\s*)?id=(?:"([^"]+)"|\{`([^`$]+)`)/g)].map((m) => `${m[1] ?? m[2]}-heading`)));

  it("finds the sections", () => {
    expect(sectionsOf("people")).toContain("people-heading");
    expect(sectionsOf("people")).toContain("roles-heading");
    expect(sectionsOf("clients")).toContain("clients-heading");
  });

  it("point at a section heading that exists", () => {
    const links = files(SRC).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\/setup\/(clients|people)#([a-z0-9-]+)/g)].map((m) => ({ file: f.slice(SRC.length), page: m[1]!, anchor: m[2]! })));
    expect(links.length).toBeGreaterThan(3);
    for (const l of links) expect(sectionsOf(l.page).has(l.anchor), `${l.file}: ${l.page}#${l.anchor}`).toBe(true);
  });
});
