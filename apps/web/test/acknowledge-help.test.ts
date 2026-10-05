import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ACK_HELP } from "@/components/acknowledge-dialog";
import { INSIGHT_HELP } from "@/components/insights";
import { DIALOG_RATINGS, RATING_MEANINGS } from "@/lib/issues/draft";

// The insight pop-up reaches the source-linking provider, which saves through Server Actions: stand them in.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/w/[slug]/source-actions", () => ({ createSource: async () => ({}), saveSourceField: async () => ({}), deleteSource: async () => ({}), linkSource: async () => ({}), unlinkSource: async () => ({}) }));

// Every control in the Acknowledge dialog has an (i) with a plain-English description and an example (issue #112), and each of
// the four ratings is listed with its one-line meaning.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("Acknowledge dialog help", () => {
  const dialog = read("components/acknowledge-dialog.tsx");

  it("has a description and an example for every control", () => {
    expect(Object.keys(ACK_HELP).sort()).toEqual(["goal", "measure", "now", "owners", "process", "rating", "scope", "sources", "steps", "title"]);
    for (const [key, help] of Object.entries(ACK_HELP)) {
      expect(help.label.length, key).toBeGreaterThan(2);
      expect(help.description.length, `${key} description`).toBeGreaterThan(20);
      expect(help.example.length, `${key} example`).toBeGreaterThan(8);
    }
  });

  it("shows an (i) beside each of them", () => {
    for (const key of Object.keys(ACK_HELP)) {
      // Either the help object is spread into a <Help>/<HelpLabel>, or a field gets it through its `label` prop.
      const used = dialog.includes(`<Help {...ACK_HELP.${key}} />`) || dialog.includes(`<HelpLabel {...ACK_HELP.${key}} />`) || dialog.includes(`label={ACK_HELP.${key}}`);
      expect(used, `${key} has no (i) in the dialog`).toBe(true);
    }
  });

  it("asks the questions the prototype does, in its words", () => {
    for (const text of ["How bad is it?", "What does it touch?", "The whole process", "Specific steps (pick one or more)", "Add to issues"]) expect(dialog).toContain(text);
    expect(ACK_HELP.rating.label).toBe("How bad is it?");
    expect(ACK_HELP.scope.label).toBe("What does it touch?");
    expect(ACK_HELP.measure.label).toBe("Target measure");
    expect(ACK_HELP.goal.label).toBe("Goal");
  });

  it("lists the four ratings with a one-line meaning each", () => {
    expect(DIALOG_RATINGS).toEqual(["risk", "bad", "good", "great"]);
    for (const r of DIALOG_RATINGS) expect(RATING_MEANINGS[r].split("\n")).toHaveLength(1);
    expect(RATING_MEANINGS.risk).toBe("Could break delivery or lose clients. Fix now.");
    expect(dialog).toContain("RATING_MEANINGS[rating]");
  });

  it("the (i) texts keep to plain English: no jargon words", () => {
    for (const help of [...Object.values(ACK_HELP), ...Object.values(INSIGHT_HELP)]) {
      expect(`${help.description} ${help.example}`).not.toMatch(/\b(RLS|jsonb|payload|enum|schema|FK)\b/);
    }
  });

  it("the Dismiss help says a dismissed finding leaves the list, never reaches the map, and stays dismissed (B17)", () => {
    expect(INSIGHT_HELP.dismiss.description).toMatch(/never reaches the map/);
    expect(INSIGHT_HELP.dismiss.description).toMatch(/stays dismissed/);
    expect(INSIGHT_HELP.dismiss.example.length).toBeGreaterThan(10);
  });

  it("the register's New issue and Edit paths use the same dialog", () => {
    const register = read("components/issues-register.tsx");
    expect(register).toContain("<AcknowledgeDialog");
    expect(register).toContain("+ New issue");
    expect(register).toContain("onEdit(issue)");
    expect(register).not.toContain("LogIssueForm");
    expect(read("components/insights.tsx")).toContain("<AcknowledgeDialog");
  });
});
