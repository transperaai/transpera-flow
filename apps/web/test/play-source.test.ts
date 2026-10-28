import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Play links (B4), read as source: what the visitor's code must never do.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("play mode keeps nothing and writes nothing", () => {
  it("the play section uses no browser storage, cookie or address state", () => {
    for (const f of ["src/components/share/play-section.tsx"]) {
      // Without comments (the file says in words what it keeps nowhere).
      const text = read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(text, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|router\.(push|replace)|searchParams/);
    }
  });

  it("the visitor's actions file makes no database call and the send action is gone", () => {
    const actions = read("src/app/s/[token]/actions.ts");
    expect(actions).not.toMatch(/\brpc(?:Rows)?\(|submitPlayIdea|submit_play_proposal|\.(selectFrom|insertInto|updateTable|deleteFrom)\(/);
    expect(actions).toMatch(/^"use server";/);
  });

  it("the visitor's page still reads only through open_share_link", () => {
    const page = read("src/app/s/[token]/page.tsx");
    expect(page.match(/\brpc(?:Rows)?\(\s*db,\s*"([a-z_]+)"/g)).toEqual(['rpc(db, "open_share_link"']);
    expect(page).not.toMatch(/\.(selectFrom|insertInto|updateTable|deleteFrom)\(/);
  });

  it("the Share dialog's play switch is for a process only, and it is off until chosen", () => {
    const dialog = read("src/components/share/share-dialog.tsx");
    expect(dialog).toContain('useState(false);\n  const [label');
    expect(dialog).toContain('play: kind === "process" && play');
  });
});
