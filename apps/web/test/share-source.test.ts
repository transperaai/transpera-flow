import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Share links (issue #32, B3): what the visitor's page may and may not touch, checked on the source text. The page is the one
// unauthenticated door into a workspace's data, so it is kept to a single call.

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const page = read("src/app/s/[token]/page.tsx");

describe("the visitor's page", () => {
  it("imports no loader that reads a workspace's tables (the snapshot is its only data)", () => {
    const imports = [...page.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]!);
    for (const banned of ["@/lib/data", "@/lib/overview/data", "@/lib/ai/data", "@/lib/company-data", "@/lib/access-data", "@/lib/first-principles/data", "@/lib/share/list"]) {
      expect(imports, banned).not.toContain(banned);
    }
    // Only the client factory, the snapshot type and the screens: no other module of lib that talks to the database.
    for (const i of imports) expect(i, i).not.toMatch(/^@\/lib\/.*(data|loader|queries)$/);
  });

  it("calls one database function, open_share_link, and reads no table", () => {
    expect([...page.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["open_share_link"]);
    expect(page).not.toMatch(/\.from\(/);
    expect(page).not.toMatch(/service[_-]?role/i);
    // The visitor's own address comes from their session, never from the link.
    expect(page).toContain("db.auth.getUser()");
  });

  it("is not indexed, shows the same words for every dead link, and checks the token and the format", () => {
    expect(page).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
    expect(page).toContain("SHARE_TOKEN.test(token)");
    expect(page).toContain("SHARE_SNAPSHOT_VERSION");
    expect(read("src/app/s/[token]/not-found.tsx")).toContain("This link has expired or been turned off.");
    expect(read("src/app/s/[token]/not-found.tsx")).toContain("Ask whoever sent it for a new one.");
    expect(page).toContain("Continue with Google");
    expect(page).toContain("This link wasn&apos;t shared with");
    expect(page).toContain("Sign in with a different account");
  });

  it("is a Server Component that waits for the request (no prerender of a private page)", () => {
    expect(page).not.toMatch(/^"use client"/);
    expect(page).toContain("await connection()");
    expect(page).toContain("await props.params");
  });
});

describe("the proxy and the headers", () => {
  it("lets /s through signed out, and nothing else new", () => {
    const proxy = read("src/proxy.ts");
    expect(proxy).toMatch(/const PUBLIC_PATHS = \["\/login", "\/auth", "\/demo", "\/privacy", "\/s"\];/);
  });

  it("sets Referrer-Policy, Cache-Control and X-Robots-Tag for /s/:path*", () => {
    const config = read("next.config.ts");
    const block = config.slice(config.indexOf('source: "/s/:path*"'));
    expect(block).toContain('key: "Referrer-Policy", value: "no-referrer"');
    expect(block).toContain('key: "Cache-Control", value: "private, no-store"');
    expect(block).toContain('key: "X-Robots-Tag", value: "noindex, nofollow"');
  });
});

describe("making links", () => {
  const actions = read("src/app/w/[slug]/share-actions.ts");
  it("is a Server Action file that checks the editor, builds as the editor, and shows the link once", () => {
    expect(actions).toMatch(/^"use server";/);
    expect(actions).toContain("canEditWorkspace(");
    expect(actions).toContain("loadShareData(");
    expect(actions).toContain("shareSnapshotLeaks(");
    expect(actions).toContain('randomBytes(32).toString("base64url")');
    expect(actions).toContain('createHash("sha256")');
    // The token is never stored or logged: only its hash is written.
    expect(actions).not.toMatch(/token_hash:\s*token\b/);
    expect(actions).not.toMatch(/console\.\w+\([^)]*token/);
    expect(actions).not.toMatch(/service[_-]?role/i);
  });

  it("loads nothing for the snapshot through the page loaders (they would read as the page, with real names)", () => {
    expect(actions).not.toContain("loadMemberNames");
    expect(actions).not.toContain('from "@/lib/data"');
  });
});
