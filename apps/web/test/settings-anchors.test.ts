import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Links into Settings land on something that exists. Settings is one scrolling page of eight sections, each a heading band
// (SettingsBand, or a SettingsSection with `band`) whose id is the anchor (`/settings#people-roles`); every card inside has a heading
// `<card id>-heading` (`/settings#roles-heading`). A link to an id that isn't there opened the page at the top instead of the section.

const SRC = new URL("../src/", import.meta.url).pathname;
const SETTINGS = join(SRC, "app/w/[slug]/settings");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("links into Settings", () => {
  // Its sections: the Settings folder, the Purposes band, the Tiers & clients and People & roles parts (components/setup).
  const sources = [...files(SETTINGS), join(SRC, "components/purposes/purposes-settings.tsx"), ...files(join(SRC, "components/setup"))];
  const text = sources.map((f) => readFileSync(f, "utf8")).join("\n");
  const cards = [...text.matchAll(/<(?:SettingsSection|SectionCard|SettingsBand)\s+(?:\n\s*)?id=(?:"([^"]+)"|\{`([^`$]+)`)/g)].map((m) => m[1] ?? m[2]!);
  const bands = new Set([
    ...[...text.matchAll(/<SettingsBand\s+(?:\n\s*)?id="([^"]+)"/g)].map((m) => m[1]!),
    ...[...text.matchAll(/<SettingsSection\s+(?:\n\s*)?id="([^"]+)"\s+band\b/g)].map((m) => m[1]!),
  ]);
  const targets = new Set([...bands, ...cards.map((id) => `${id}-heading`)]);

  it("finds the eight bands and the cards' headings", () => {
    expect([...bands].sort()).toEqual(["access", "churn-drivers", "demand", "people-roles", "purposes", "simulation", "tiers-clients", "workspace"]);
    for (const h of ["workspace-heading", "simulation-heading", "purposes-heading", "people-heading", "roles-heading", "clients-heading"]) expect(targets).toContain(h);
  });

  it("the sub-nav lists every band, in the page's order", async () => {
    const { settingsNavEntries } = await import("@/components/settings/settings-nav");
    const ids = settingsNavEntries("s", true).map((e) => e.href.split("#")[1]);
    expect(ids).toEqual(["workspace", "simulation", "purposes", "churn-drivers", "demand", "tiers-clients", "people-roles", "access"]);
    expect(settingsNavEntries("s", false).map((e) => e.label)).not.toContain("Access");
    for (const e of settingsNavEntries("s", true)) expect(e.href).toMatch(/^\/w\/s\/settings#[a-z-]+$/);
    // The page renders the bands in that order.
    const page = readFileSync(join(SETTINGS, "page.tsx"), "utf8");
    const order = ["<WorkspaceDetails", "<SimulationSettings", "<PurposesSettings", "<ChurnDriversSettings", "<DemandSettings", 'id="tiers-clients"', 'id="people-roles"', "<AccessSection"].map((m) => page.indexOf(m));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("point at a band or a heading that exists", () => {
    const links = files(SRC).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/(?:\/settings|[pP]eopleHref\})#([a-z0-9-]+)/g)].map((m) => ({ file: f.slice(SRC.length), anchor: m[1]! })));
    expect(links.length).toBeGreaterThanOrEqual(10);
    for (const l of links) expect(targets.has(l.anchor), `${l.file}: #${l.anchor}`).toBe(true);
  });

  it("no link goes to the old Tiers & clients, People & roles or Access pages (they only redirect now)", () => {
    const old = files(SRC).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\/settings\/(clients|people|access)\b(?!-)/g)].map((m) => `${f.slice(SRC.length)}: ${m[0]}`));
    expect(old).toEqual([]);
  });
});

// The old pages' addresses (bookmarks, Set up's even older ones) redirect to their sections. A redirect's Location keeps the
// #fragment, so the browser lands on the band; the query string (Access's ?error= after a refused form) carries over.
describe("the old Settings pages redirect to their sections", () => {
  it("next.config.ts sends each to its anchor", async () => {
    const config = (await import("../next.config")).default as { redirects: () => Promise<{ source: string; destination: string }[]> };
    const to = new Map((await config.redirects()).map((r) => [r.source, r.destination]));
    expect(to.get("/w/:slug/settings/clients")).toBe("/w/:slug/settings#tiers-clients");
    expect(to.get("/w/:slug/settings/people")).toBe("/w/:slug/settings#people-roles");
    expect(to.get("/w/:slug/settings/access")).toBe("/w/:slug/settings#access");
    expect(to.get("/w/:slug/setup/clients")).toBe("/w/:slug/settings#tiers-clients");
    expect(to.get("/w/:slug/setup/people")).toBe("/w/:slug/settings#people-roles");
    expect(to.get("/w/:slug/settings/purposes")).toBe("/w/:slug/settings#purposes");
    // Their pages are gone, so nothing renders at the old address.
    for (const page of ["clients", "people", "access"]) expect(existsSync(join(SETTINGS, page, "page.tsx")), page).toBe(false);
  });

  it("Access's actions send the person back to the section, with the message in the query", () => {
    expect(readFileSync(join(SETTINGS, "access/actions.ts"), "utf8")).toContain("redirect(`/w/${encodeURIComponent(slug)}/settings?${new URLSearchParams(params)}#access`)");
  });
});

// D47: the Client health rules and the benchmark have no controls in Settings or Set up. The components and the engine defaults stay.
describe("client health controls are hidden (D47)", () => {
  it("the Settings page does not render the Client health rules", () => {
    expect(readFileSync(join(SETTINGS, "page.tsx"), "utf8")).not.toContain("HealthSettings");
  });
  it("Set up, Tiers & clients does not render the benchmark or the other-services editor (D46)", () => {
    const tiers = readFileSync(join(SRC, "components/setup/tiers-clients.tsx"), "utf8");
    for (const gone of ["ClientHealthBenchmark", "ClientGroupsSettings", "ServicesSettings", "other-services\"" ]) expect(tiers, gone).not.toContain(gone);
  });
});
