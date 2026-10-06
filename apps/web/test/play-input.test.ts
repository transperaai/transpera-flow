import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEVER_KIND_IDS } from "@transpera-flow/db";
import { MESSAGES, PLAY_CAPS, parsePlayIdea, playPatchProblem, playResultMessage, type PlayIdeaInput } from "@/lib/share/play-input";
import { LEVER_KINDS } from "@/lib/scenarios/lever-catalogue";
import { buildLevers } from "@/lib/scenarios/levers";

// What a play-link visitor sends (B4): the TypeScript twin of the database's lever check, run against the table of cases the database
// test also reads, and the text rules the database repeats.

const fixture = JSON.parse(readFileSync(new URL("../../../packages/db/test/fixtures/play-patch-cases.json", import.meta.url), "utf8")) as {
  messages: Record<string, string>;
  cases: { name: string; levers: unknown; expect: string | null; hidden?: string[]; people?: boolean; dbOnly?: boolean }[];
};

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ID = { step: u(1), stepOther: u(2), role: u(3), person: u(4), service: u(5), unseenStep: u(6), foreignStep: u(7), retiredStep: u(8), inventedStep: u(9), deletedStep: u(10) };
const IN_SNAPSHOT = {
  steps: new Set([ID.step, ID.stepOther, ID.deletedStep]),
  roles: new Set([ID.role]),
  people: new Set([ID.person]),
  services: new Set([ID.service]),
};
const substitute = (s: string) => {
  let out = s;
  for (const [k, v] of Object.entries(ID).sort((a, b) => b[0].length - a[0].length)) out = out.replaceAll(`$${k}`, v);
  return out.replaceAll("$role", ID.role).replaceAll("$person", ID.person).replaceAll("$service", ID.service);
};

describe("playPatchProblem agrees with the database's table of cases", () => {
  it("the messages are the fixture's", () => {
    for (const [k, v] of Object.entries(fixture.messages)) expect(MESSAGES[k as keyof typeof MESSAGES], k).toBe(v);
  });

  for (const k of fixture.cases) {
    if (k.dbOnly) continue;
    it(k.name, () => {
      const levers = typeof k.levers === "string" ? Array.from({ length: Number(k.levers.split(":")[1]) }, () => ({ path: "demand.leads_per_week", op: "set", value: 9 })) : JSON.parse(substitute(JSON.stringify(k.levers)));
      const got = playPatchProblem(levers, { hidden: k.hidden ?? ["process.rework"], showPeople: k.people ?? false, ids: IN_SNAPSHOT });
      expect(got).toBe(k.expect === null ? null : fixture.messages[k.expect]);
    });
  }

  it("without a snapshot (the Server Action) it skips the hidden-kind, people and id checks, which the database does", () => {
    expect(playPatchProblem([{ path: `steps.${ID.foreignStep}.rework_rate`, op: "set", value: 0.1 }])).toBeNull();
    expect(playPatchProblem([{ path: "demand.leads_per_week", op: "set", value: 10001 }])).toBe(MESSAGES.range);
    expect(playPatchProblem("nope")).toBe(MESSAGES.invalid);
  });
});

describe("the sliders stop at the database's caps, so a real visitor is never refused", () => {
  const big = { leadsPerWeek: 9000, activeClients: 90000, retainer: 9_000_000, hoursPerWeek: 40, steps: [], roles: { r: { name: "R", count: 499, cost: 0, ongoing: 0 } }, services: {} } as never;
  it("on a huge workspace no slider can reach a value the check refuses", () => {
    const levers = buildLevers(big);
    const by = (path: string) => levers.find((l) => l.path === path);
    expect(by("demand.leads_per_week")!.max).toBe(PLAY_CAPS.leads);
    expect(by("demand.active_clients")!.max).toBe(PLAY_CAPS.clients);
    expect(by("finances.retainer")!.max).toBe(PLAY_CAPS.price);
    for (const l of levers.filter((x) => x.op === "set" && x.path !== "demand.churn_monthly")) {
      expect(playPatchProblem([{ path: l.path, op: "set", value: l.max }], {}), l.path).not.toBe(MESSAGES.range);
    }
  });
  it("a normal workspace's sliders are unchanged", () => {
    const levers = buildLevers({ ...(big as object), leadsPerWeek: 10, activeClients: 20, retainer: 2000 } as never);
    expect(levers.find((l) => l.path === "demand.leads_per_week")!.max).toBe(30);
    expect(levers.find((l) => l.path === "demand.active_clients")!.max).toBe(40);
  });
});

describe("the lever kind ids", () => {
  it("the database package's copy equals the catalogue, in order", () => {
    expect([...LEVER_KIND_IDS]).toEqual(LEVER_KINDS.map((k) => k.id));
  });
});

describe("parsePlayIdea", () => {
  const LEVER = [{ path: "demand.leads_per_week", op: "set", value: 9 }];
  const good = (over: Partial<PlayIdeaInput> = {}): PlayIdeaInput => ({ title: "One more strategist", note: "", name: "Marta Okoye", email: "Marta@Example.com", issue: null, levers: LEVER, ...over });

  it("accepts a good idea, trims, lower-cases the email and turns an empty note into null", () => {
    const r = parsePlayIdea(good({ title: "  One more strategist ", note: "  " }));
    expect(r).toEqual({ ok: true, value: { title: "One more strategist", note: null, name: "Marta Okoye", email: "marta@example.com", issue: null, levers: LEVER } });
  });

  it("refuses with the database's own sentences", () => {
    const cases: [Partial<PlayIdeaInput>, string][] = [
      [{ title: " " }, "Give your idea a name."],
      [{ title: "t".repeat(121) }, "Keep the name under 120 characters."],
      [{ name: "" }, "Add your name."],
      [{ name: "n".repeat(101) }, "Keep your name under 100 characters."],
      [{ email: "" }, "Add your email address so the team can reply."],
      [{ email: "marta at example" }, "That isn't an email address."],
      // A mailto: link must not be able to add a header, a body or a second address.
      [{ email: "a@b.co?cc=evil%40attacker.example&body=hi" }, "That isn't an email address."],
      [{ email: "a@b.co&bcc=x@y.co" }, "That isn't an email address."],
      [{ email: "a%40b@c.co" }, "That isn't an email address."],
      [{ email: "a@b.co,c@d.co" }, "That isn't an email address."],
      [{ email: "a/b@c.co" }, "That isn't an email address."],
      [{ email: "a@b" }, "That isn't an email address."],
      [{ email: `${"e".repeat(246)}@x.example` }, "That isn't an email address."],
      [{ note: "n".repeat(1001) }, "Keep the note under 1,000 characters."],
      [{ title: "a\u0001b" }, "Remove the unusual characters and try again."],
      [{ title: "a\nb" }, "Remove the unusual characters and try again."],
      [{ note: "a\u0007b" }, "Remove the unusual characters and try again."],
      [{ levers: [] }, "Move at least one lever first."],
      [{ issue: "not-an-id" }, "Pick an issue from this page, or none."],
    ];
    for (const [over, message] of cases) expect(parsePlayIdea(good(over)), message).toEqual({ ok: false, message });
  });

  it("a note may hold line breaks; limits are inclusive", () => {
    expect(parsePlayIdea(good({ note: "one\ntwo", title: "t".repeat(120), name: "n".repeat(100) })).ok).toBe(true);
  });

  it("a restricted link needs no typed email (the verified one is used), but a typed one must still be an address", () => {
    expect(parsePlayIdea(good({ email: "" }), { needEmail: false })).toMatchObject({ ok: true, value: { email: null } });
    expect(parsePlayIdea(good({ email: "nope" }), { needEmail: false })).toEqual({ ok: false, message: "That isn't an email address." });
  });

  it("does not look at what the text says (names, emails and amounts are the database's to hold)", () => {
    expect(parsePlayIdea(good({ note: "Ask priya@northbeam.example about £4,100" })).ok).toBe(true);
  });

  it("each answer has a plain sentence", () => {
    expect(playResultMessage({ status: "rate_limited" })).toBe("A lot of ideas have been sent from this link recently. Try again in an hour.");
    expect(playResultMessage({ status: "busy" })).toBe("The team has a lot of ideas waiting. Try again later.");
    expect(playResultMessage({ status: "gone" })).toBe("This link has expired or been turned off.");
    expect(playResultMessage({ status: "sign_in" })).toBe("Sign in again with the address this link was sent to.");
    expect(playResultMessage({ status: "not_allowed" })).toBe("Sign in again with the address this link was sent to.");
    expect(playResultMessage({ status: "error", message: "x" })).toBe("x");
  });
});
