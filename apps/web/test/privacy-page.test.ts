import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";

// The privacy policy names who holds data and what is kept. These checks tie its claims to the code they describe.

const text = renderToStaticMarkup(createElement(PrivacyPage)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("privacy page", () => {
  it("names Neon in Sydney for the database and no longer Supabase", () => {
    expect(text).toContain("Neon: database, hosted on AWS in Sydney");
    expect(text).not.toMatch(/supabase/i);
  });

  it("says sign-in sessions are kept with their IP address and browser, as Better Auth's session table does", () => {
    const migration = readFileSync(new URL("../../../packages/db/migrations/20261228000000_better_auth.sql", import.meta.url), "utf8");
    expect(migration).toMatch(/create table "better_auth"\."session" \([^;]*"ipAddress" text, "userAgent" text/);
    expect(text).toMatch(/sign-in sessions, each recorded in our database with the IP address and browser/);
  });
});
