import { describe, expect, it } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { larkspurBundle, northbeamBundle } from "@transpera-flow/db";
import { scrubBreadcrumb, scrubEvent, scrubText, scrubUrl, shapeMessage } from "@/lib/monitoring/scrub";
import { ALLOWED_WORDS } from "@/lib/monitoring/words";

// Sentry stores what it receives (issue #44, ADR 0017), so nothing personal may leave the app: the scrubber is tested against
// events shaped like the SDK's own, seeded with the fixtures' people and clients, money, tokens and cookies.

const bundles = [northbeamBundle(), larkspurBundle()];
const people = bundles.flatMap((b) => b.people.map((p) => p.name));
const clients = bundles.flatMap((b) => (b.clients ?? []).map((c) => c.name));
const nameWords = (names: string[]) => names.flatMap((n) => n.toLowerCase().match(/[\p{L}']+/gu) ?? []).filter((w) => w.length > 1);

const TOKEN = "k3J9xQ2vB7mN4pL8wR5tY1uZ6cD0fG3hA9sE2iO4yX1"; // a 43-character share token
const SESSION_COOKIE = "base64-eyJhY2Nlc3NfdG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlKOSIsInRva2VuX3R5cGUiOiJiZWFyZXIifQ";
const BEARER = "Bearer tfk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const EMAILS = ["maya.collins@northbeam.example", "hana@larkspur.example"];
const MONEY = ["£4,100", "$85/h", "4,512€", "1,200 GBP"];
const UUID = "a0000000-0000-4000-8000-000000000001";
const SQL = `${clients[0]} is client work for ${clients[1]}. Unlink it from that in Settings, Services, then archive it.`;

const secrets = [...people, ...people.flatMap((n) => n.split(" ")), ...clients, ...EMAILS, ...MONEY, TOKEN, SESSION_COOKIE, "tfk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0", "eq.maya@northbeam.example"];

const poison = `${people[2]} ${EMAILS[0]} ${MONEY.join(" ")} ${TOKEN} ${clients[2]}`;

/** A browser event as the SDK builds it: the page's address, headers, cookies, a breadcrumb trail and frames with source and vars. */
function browserEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: "7d3c1f0a2b8e4d6f9a1b3c5d7e9f0a2b",
    timestamp: 1_791_000_000.5,
    level: "error",
    platform: "javascript",
    environment: "production",
    release: "bf61be0e4c1d2a3b4c5d6e7f8091a2b3c4d5e6f7",
    sdk: { name: "sentry.javascript.nextjs", version: "10.76.1" },
    transaction: "/w/[slug]/p/[processId]",
    message: poison,
    logentry: { message: poison, params: [people[0], MONEY[0]] },
    exception: {
      values: [
        {
          type: "TypeError",
          value: `Cannot read properties of undefined (reading '${people[1]}') ${SQL} ${poison} 23514`,
          mechanism: { type: "auto.browser.global_handlers.onerror", handled: false, data: { who: people[0], url: `/s/${TOKEN}` } },
          stacktrace: {
            frames: [
              {
                filename: `app:///_next/static/chunks/app/w/%5Bslug%5D/page.js`,
                abs_path: `https://app.example.com/s/${TOKEN}?email=eq.maya@northbeam.example`,
                function: "onClick",
                module: "page",
                lineno: 42,
                colno: 7,
                in_app: true,
                context_line: `throw new Error("${people[3]} earns £4,100");`,
                pre_context: [`const who = "${people[4]}";`],
                post_context: ["}"],
                vars: { name: people[5], pay: MONEY[1] },
              } as never,
            ],
          },
        },
      ],
    },
    request: {
      method: "GET",
      url: `https://app.example.com/s/${TOKEN}?email=eq.maya@northbeam.example#${people[0]}`,
      query_string: `email=eq.${EMAILS[0]}`,
      headers: { cookie: `sb-abc-auth-token=${SESSION_COOKIE}`, authorization: BEARER, "user-agent": "Mozilla/5.0" },
      cookies: { "sb-abc-auth-token": SESSION_COOKIE, tf_after_sign_in: `/w/${clients[0]}` },
      data: { name: people[0], rate: MONEY[1] },
      env: { REMOTE_ADDR: "203.0.113.9" },
    },
    user: { id: UUID, email: EMAILS[0], username: people[0], ip_address: "203.0.113.9" },
    extra: { workspace: clients[0], snapshot: poison },
    tags: { runtime: "browser", handled: "no", who: people[0], url: `/s/${TOKEN}?x=${EMAILS[1]}`, area: poison },
    contexts: {
      browser: { name: "Chrome", version: "141.0.0" },
      os: { name: "Windows", version: "11" },
      device: { family: "Desktop", name: `${people[0]}'s laptop`, type: "desktop" },
      app: { app_name: clients[0], app_start_time: "2026-10-07T00:00:00Z" },
      trace: { trace_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", span_id: "1a2b3c4d5e6f7081", data: { who: people[0] } },
      custom: { who: people[0], pay: MONEY[0] },
    },
    breadcrumbs: [
      { category: "console", level: "log", message: `${people[0]} ${MONEY[0]}`, timestamp: 1 },
      { category: "ui.click", message: `button[aria-label="Delete ${people[1]}"]`, timestamp: 2 },
      { category: "navigation", data: { from: `/w/${encodeURIComponent(clients[0]!)}/people`, to: `/s/${TOKEN}?x=1` }, timestamp: 3 },
      { type: "http", category: "fetch", data: { method: "GET", url: `https://abc.supabase.co/rest/v1/people?email=eq.${EMAILS[0]}`, status_code: 200, body: poison }, message: poison, timestamp: 4 },
    ],
    modules: { "secret-lib": "1.0.0" },
    debug_meta: { images: [{ type: "sourcemap", code_file: `https://app.example.com/_next/static/chunks/0abc.js?dpl=${TOKEN}`, debug_id: "6f3a1e2b-1c2d-4e5f-8a9b-0c1d2e3f4a5b" }] },
  } as unknown as ErrorEvent;
}

/** A server event as `captureRequestError` builds it: the request's headers, a `nextjs` context, a Postgres error message. */
function serverEvent(): ErrorEvent {
  return {
    event_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    timestamp: 1_791_000_001,
    level: "error",
    platform: "node",
    environment: "preview",
    server_name: "ip-10-0-0-1",
    transaction: `GET /w/[slug]/p/[processId]`,
    exception: {
      values: [
        {
          type: "Error",
          value: `${SQL} (23514) Key (email)=(${EMAILS[0]}) already exists. ${UUID}`,
          mechanism: { type: "auto.function.nextjs.on_request_error", handled: false },
          stacktrace: {
            frames: [
              { filename: "/var/task/apps/web/.next/server/chunks/ssr/[root-of-the-server]__0b1c2d3e._.js", function: "loadWorkspace", lineno: 120, colno: 15, in_app: true, vars: { name: people[0] } } as never,
            ],
          },
        },
      ],
    },
    request: {
      method: "POST",
      url: `https://app.example.com/w/northbeam/p/${UUID}?code=abc`,
      headers: { cookie: `sb-abc-auth-token=${SESSION_COOKIE}; tf_after_sign_in=/w/northbeam`, authorization: BEARER, host: "app.example.com" },
      data: { name: people[0], rate: MONEY[1] },
    },
    user: { email: EMAILS[1] },
    tags: { runtime: "node", "next.route": `/w/${clients[0]}` },
    contexts: {
      runtime: { name: "node", version: "v22.11.0" },
      nextjs: { request_path: `/w/northbeam/p/${UUID}?x=${EMAILS[0]}`, router_kind: "App Router", router_path: "/w/[slug]/p/[processId]", route_type: "render", extra: people[0] },
    },
    extra: { arguments: [people[0], MONEY[2]] },
    breadcrumbs: [{ category: "http", data: { "http.method": "GET", url: `https://abc.supabase.co/rest/v1/people?name=eq.${people[0]}`, status_code: 200 }, timestamp: 5 }],
  } as unknown as ErrorEvent;
}

describe("scrubEvent: nothing personal survives", () => {
  for (const [label, make] of [["browser", browserEvent], ["server", serverEvent]] as const) {
    it(`removes every seeded name, email, amount, token, cookie and query from a ${label} event`, () => {
      const out = scrubEvent(make());
      expect(out).not.toBeNull();
      const json = JSON.stringify(out).toLowerCase();
      for (const secret of secrets) expect(json, secret).not.toContain(secret.toLowerCase());
      expect(json).not.toContain("203.0.113.9");
      expect(json).not.toContain("authorization");
      expect(json).not.toContain("cookie");
      expect(json).not.toContain("query_string");
      expect(json).not.toContain("secret-lib");
      for (const word of nameWords(people)) expect(json, word).not.toMatch(new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u"));
    });

    it(`keeps no user, extra, modules, request headers, cookies or data on a ${label} event`, () => {
      const out = scrubEvent(make()) as unknown as Record<string, unknown>;
      for (const key of ["user", "extra", "modules"]) expect(out[key], key).toBeUndefined();
      const request = out.request as Record<string, unknown>;
      expect(Object.keys(request).sort()).toEqual(["method", "url"]);
    });
  }

  it("keeps what is needed to read the report", () => {
    const out = scrubEvent(browserEvent())!;
    const json = JSON.stringify(out);
    const [first] = out.exception!.values!;
    expect(first!.type).toBe("TypeError");
    expect(first!.value).toContain("Cannot read properties of undefined");
    expect(first!.value).toContain("23514");
    const [frame] = first!.stacktrace!.frames!;
    expect(frame).toMatchObject({ function: "onClick", lineno: 42, colno: 7, in_app: true });
    expect(frame!.filename).toBe("app:///_next/static/chunks/app/w/%5Bslug%5D/page.js");
    expect(frame!.abs_path).toBe("https://app.example.com/s/[token]");
    expect(frame).not.toHaveProperty("vars");
    expect(out.transaction).toBe("/w/[slug]/p/[processId]");
    expect(out.environment).toBe("production");
    expect(out.release).toBe("bf61be0e4c1d2a3b4c5d6e7f8091a2b3c4d5e6f7");
    expect(out.request).toEqual({ method: "GET", url: "https://app.example.com/s/[token]" });
    expect(out.contexts).toMatchObject({ browser: { name: "Chrome" }, os: { name: "Windows" }, device: { family: "Desktop", type: "desktop" } });
    expect(out.contexts!.device).not.toHaveProperty("name");
    expect(out.contexts!.app).not.toHaveProperty("app_name");
    expect(out.contexts).not.toHaveProperty("custom");
    expect(out.contexts!.trace).toEqual({ trace_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", span_id: "1a2b3c4d5e6f7081" });
    expect(out.tags).toEqual({ runtime: "browser", handled: "no", url: "/s/[token]", area: expect.any(String) });
    expect(out.debug_meta).toEqual({ images: [{ type: "sourcemap", code_file: "https://app.example.com/_next/static/chunks/0abc.js", debug_id: "6f3a1e2b-1c2d-4e5f-8a9b-0c1d2e3f4a5b" }] });
    expect(out.breadcrumbs).toHaveLength(2);
    expect(json).not.toContain("params");
    expect(first!.mechanism).toEqual({ type: "auto.browser.global_handlers.onerror", handled: false });
  });

  it("keeps a server event's route pattern, uuid and SQLSTATE, and cuts its request path", () => {
    const out = scrubEvent(serverEvent())!;
    expect(out.transaction).toBe("GET /w/[slug]/p/[processId]");
    expect(out.environment).toBe("preview");
    expect(out.server_name).toBe("ip-10-0-0-1");
    expect(out.contexts).toEqual({
      runtime: { name: "node", version: "v22.11.0" },
      nextjs: { request_path: `/w/[slug]/p/${UUID}`, router_kind: "App Router", router_path: "/w/[slug]/p/[processId]", route_type: "render" },
    });
    expect(out.request).toEqual({ method: "POST", url: `https://app.example.com/w/[slug]/p/${UUID}` });
    const [first] = out.exception!.values!;
    expect(first!.value).toContain(UUID);
    expect(first!.value).toContain("23514");
    expect(first!.value).toContain("Key ([column])=([value])");
    expect(first!.stacktrace!.frames![0]).toMatchObject({ filename: "/var/task/apps/web/.next/server/chunks/ssr/[root-of-the-server]__0b1c2d3e._.js", function: "loadWorkspace", lineno: 120 });
  });

  it("drops Next's control flow, a cancelled fetch and a cancelled simulation", () => {
    const withException = (type: string, value: string): ErrorEvent => ({ exception: { values: [{ type, value }] } }) as unknown as ErrorEvent;
    expect(scrubEvent(withException("Error", "NEXT_REDIRECT"))).toBeNull();
    expect(scrubEvent(withException("Error", "NEXT_NOT_FOUND"))).toBeNull();
    expect(scrubEvent(withException("Error", "NEXT_HTTP_ERROR_FALLBACK;404"))).toBeNull();
    expect(scrubEvent(withException("AbortError", "The operation was aborted."))).toBeNull();
    expect(scrubEvent(withException("SimulationCancelled", ""))).toBeNull();
    expect(scrubEvent(withException("TypeError", "x is not a function"))).not.toBeNull();
  });

  it("does not change its input", () => {
    for (const make of [browserEvent, serverEvent]) {
      const event = make();
      const before = JSON.stringify(event);
      scrubEvent(event);
      expect(JSON.stringify(event)).toBe(before);
    }
  });

  it("is idempotent: scrubbing a scrubbed event changes nothing", () => {
    const once = scrubEvent(browserEvent())!;
    expect(scrubEvent(once)).toEqual(once);
  });
});

describe("shapeMessage", () => {
  it.each([
    ["Acme Onboarding is client work for Retainers. Unlink it from that in Settings, Services, then archive it.", "… is client work for …. Unlink it from that in Settings, Services, then archive it."],
    ["Failed to fetch", "Failed to fetch"],
    ["Unexpected token '<'", "Unexpected token [text]"],
    ["NEXT_REDIRECT", "NEXT_REDIRECT"],
    ["import_workspace_bundle: Maya Collins could not be restored: P0001", "import_workspace_bundle: … could not be restored: P0001"],
    ["Maya Collins", "…"],
    ["Cannot read properties of undefined (reading 'name')", "Cannot read properties of undefined (reading [text])"],
    ["PGRST116 The result contains 0 rows", "PGRST116 The result … 0 rows"],
    ["José Ñuñez 山田太郎", "…"],
    ["ChunkLoadError: Loading chunk 42 failed.", "ChunkLoadError: Loading chunk 42 failed."],
    [`${EMAILS[0]} paid £4,100 on ${UUID}`, `[email] … [amount] on ${UUID}`],
  ])("%s", (input, expected) => {
    expect(shapeMessage(input)).toBe(expected);
  });

  it("caps the result at 500 characters", () => {
    expect(shapeMessage("failed ".repeat(200)).length).toBeLessThanOrEqual(500);
  });

  it("never lets a fixture name through, spelled out in a database message", () => {
    for (const name of [...people, ...clients]) {
      const out = shapeMessage(`${name} is archived. Restore it from Processes (Archived) before changing it.`).toLowerCase();
      for (const word of nameWords([name])) if (!ALLOWED_WORDS.has(word)) expect(out, name).not.toMatch(new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u"));
    }
  });
});

describe("scrubText", () => {
  it("replaces emails, money, quoted text, long tokens and URLs", () => {
    const out = scrubText(`${EMAILS[0]} ${MONEY.join(" ")} "quoted" ${TOKEN} https://abc.supabase.co/rest/v1/p?email=eq.x and /s/${TOKEN}?a=1.`);
    expect(out).toBe("[email] [amount] [amount]/h [amount] [amount] [text] [token] https://abc.supabase.co/rest/v1/p and /s/[token].");
  });

  it("leaves an apostrophe inside a word alone", () => {
    expect(scrubText("can't find it's own")).toBe("can't find it's own");
  });

  it("keeps uuids and snake_case names", () => {
    expect(scrubText(`${UUID} import_workspace_bundle_for_everyone_now`)).toBe(`${UUID} import_workspace_bundle_for_everyone_now`);
  });
});

describe("scrubUrl", () => {
  it.each([
    [`/s/${TOKEN}?x=1#y`, "/s/[token]"],
    [`/w/northbeam/p/${UUID}`, `/w/[slug]/p/${UUID}`],
    ["/auth/callback?code=abc", "/auth/callback"],
    ["https://abc.supabase.co/rest/v1/people?email=eq.maya@northbeam.example&select=*", "https://abc.supabase.co/rest/v1/people"],
    ["https://user:pass@app.example.com/w/acme/people#top", "https://app.example.com/w/[slug]/people"],
    ["app:///_next/static/chunks/a.js?v=1", "app:///_next/static/chunks/a.js"],
    ["/w/[slug]/issues/12", "/w/[slug]/issues/12"],
    ["http://", "[url]"],
    ["not a url at all", "[url]"],
    ["", "[url]"],
  ])("%s", (input, expected) => {
    expect(scrubUrl(input)).toBe(expected);
  });
});

describe("scrubBreadcrumb", () => {
  it.each(["console", "ui.click", "ui.input", "sentry.event", "custom", "xhr-like"])("drops %s", (category) => {
    expect(scrubBreadcrumb({ category, message: poison, data: { who: people[0] }, timestamp: 1 })).toBeNull();
  });

  it("drops a breadcrumb with no category", () => {
    expect(scrubBreadcrumb({ message: "x" })).toBeNull();
  });

  it("keeps a navigation breadcrumb's scrubbed from and to, and nothing else", () => {
    const out = scrubBreadcrumb({ category: "navigation", message: poison, level: "info", timestamp: 3, data: { from: `/w/${encodeURIComponent(clients[0]!)}/people?x=1`, to: `/s/${TOKEN}`, extra: people[0] } });
    expect(out).toEqual({ category: "navigation", level: "info", timestamp: 3, data: { from: "/w/[slug]/people", to: "/s/[token]" } });
  });

  it.each(["fetch", "xhr", "http"])("keeps a %s breadcrumb's method, scrubbed url and status", (category) => {
    const input: Breadcrumb = { type: "http", category, level: "info", timestamp: 4, message: poison, data: { method: "POST", url: `https://abc.supabase.co/rest/v1/people?name=eq.${people[0]}`, status_code: 400, body: poison, request_body_size: 10 } };
    expect(scrubBreadcrumb(input)).toEqual({ type: "http", category, level: "info", timestamp: 4, data: { method: "POST", url: "https://abc.supabase.co/rest/v1/people", status_code: 400 } });
  });
});

// First names that are also English words. None may be in the vocabulary: a name that passes as a word would reach Sentry.
const COMMON_FIRST_NAMES_THAT_ARE_WORDS = `will mark grace rose june april may faith hope joy bill pat sue don ray rich frank art guy jack
  jim bob dick peg penny holly ivy daisy lily violet hazel olive ruby pearl amber crystal jade ginger sky skye summer autumn winter
  dawn eve eden heather iris jasmine laurel lavender willow sage sandy shelley candy cherry misty rusty tawny honey patience prudence
  charity constance destiny felicity harmony chastity mercy verity bliss precious unity serenity trinity victoria
  chase chance clay cliff clint dale dean drew duke earl flint forrest gene glen grant hunter jay lance lee miles mason mitch
  nick pierce reed rex rod rock roy sterling stone trey wade wayne wyatt colt cash jasper rocky buck bud buddy tag blake brook
  case cole cooper dash dirk dusty ford grey gus hank hart jet kit lane lark lou max mick mike moss ned noble pace park
  parker pip rob robin rudy sam scott seth shane shep skip slate spencer tab tad tanner ted tom toby tory tuck vance vern
  wes wilder winston wolf york zane zeke abbey bay beau bell bonnie brandy bree buffy cass charm clover cookie dee dixie
  dolly dot ebony ember fawn fern flo flora gail gem gemma goldie gwen hallie honor jewel joan jo kay kelly lacey lark lea
  leigh lilac lotus mabel maggie marigold marina maven melody mimi mint missy opal pansy petal poppy posy queen rain raven
  reese rue ruth sable sasha star stella storm sunny tessa tiffany topaz uma velvet vi wendy wren xena zoe`.split(/\s+/);

describe("the vocabulary", () => {
  it("has 200 or more common first names that are also words to guard against", () => {
    expect(new Set(COMMON_FIRST_NAMES_THAT_ARE_WORDS).size).toBeGreaterThanOrEqual(200);
  });

  it("holds no fixture person's first name or surname, no fixture client's name, and none of the common first names", () => {
    for (const word of nameWords(people)) expect(ALLOWED_WORDS.has(word), word).toBe(false);
    for (const client of clients) expect(ALLOWED_WORDS.has(client.toLowerCase()), client).toBe(false);
    // A client's name may use a business word ("Group") that the product also uses; every other word of it stays out.
    const generic = new Set(["group", "co"]);
    for (const word of nameWords(clients)) if (!generic.has(word)) expect(ALLOWED_WORDS.has(word), word).toBe(false);
    for (const name of COMMON_FIRST_NAMES_THAT_ARE_WORDS) expect(ALLOWED_WORDS.has(name), name).toBe(false);
  });

  it("is lower case throughout, and has no empty entry", () => {
    for (const word of ALLOWED_WORDS) {
      expect(word, word).toBe(word.toLowerCase());
      expect(word.trim(), word).not.toBe("");
    }
  });

  it("has the words the check page and the SQL messages need", () => {
    for (const word of ["sentry", "workspace", "archive", "unlink", "settings", "services", "client", "failed", "fetch"]) expect(ALLOWED_WORDS.has(word), word).toBe(true);
  });
});
