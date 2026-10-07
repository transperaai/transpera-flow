import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Play links (B4), read as source: what the visitor's code must never do.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("play mode keeps nothing and writes nowhere but through the one function", () => {
  it("the play section and the Send dialog use no browser storage, cookie or address state", () => {
    for (const f of ["src/components/share/play-section.tsx", "src/components/share/send-idea.tsx"]) {
      // Without comments (the file says in words what it keeps nowhere).
      const text = read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(text, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|router\.(push|replace)|searchParams/);
    }
  });

  it("the Server Action calls only submit_play_proposal, revalidates nothing, and never logs the token", () => {
    const actions = read("src/app/s/[token]/actions.ts");
    const send = actions.slice(actions.indexOf("export async function submitPlayIdea"));
    expect(send.match(/\.rpc\("([a-z_]+)"/g)).toEqual(['.rpc("submit_play_proposal"']);
    expect(send).not.toMatch(/\.from\(|revalidate|refresh\(|console\./);
    expect(actions).toMatch(/^"use server";/);
  });

  it("the visitor's page still reads only through open_share_link", () => {
    const page = read("src/app/s/[token]/page.tsx");
    expect(page.match(/\.rpc\("([a-z_]+)"/g)).toEqual(['.rpc("open_share_link"']);
    expect(page).not.toMatch(/\.from\(/);
  });

  it("the Share dialog's play switch is for a process only, and it is off until chosen", () => {
    const dialog = read("src/components/share/share-dialog.tsx");
    expect(dialog).toContain('useState(false);\n  const [label');
    expect(dialog).toContain('play: kind === "process" && play');
  });

  it("a visitor's typed text is never name-checked in the app (the database holds it for members)", () => {
    const input = read("src/lib/share/play-input.ts");
    expect(input).not.toMatch(/loadShareSecrets|nameTokenIndex|shareSnapshotLeaks|redactShareSnapshot/);
  });
});
