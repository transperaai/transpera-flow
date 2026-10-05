import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROCESS_FILE_EXAMPLE, processTextFrom } from "@transpera-flow/db";
import { checkLink, fetchPublicPage, isPublicAddress, LinkError, NOT_PUBLIC_ADVICE, PUBLIC_POLICY, type FetchPolicy } from "../src";

// Fetching a page by link, with the SSRF guard (issue #166, B13 slice 2): which addresses count as public, what is refused
// before and after DNS and redirects, and the size and time limits, against a local server. The local server stands in for
// a public one through the policy's test-only switches; the default policy is shown refusing it.

const block = `<script type="application/vnd.transpera-process+json">${JSON.stringify(PROCESS_FILE_EXAMPLE)}</script>`;
const PAGE = `<!doctype html><title>Flow</title><body>${block}</body>`;

let server: Server;
let port: number;
const seen: { host: string | undefined; url: string | undefined; agent: string | undefined }[] = [];

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  "/page": (_req, res) => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE),
  "/json": (_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(PROCESS_FILE_EXAMPLE)),
  "/hop1": (_req, res) => void res.writeHead(302, { location: "/hop2" }).end(),
  "/hop2": (_req, res) => void res.writeHead(301, { location: "/page" }).end(),
  "/loop": (_req, res) => void res.writeHead(302, { location: "/loop" }).end(),
  "/to-private": (_req, res) => void res.writeHead(302, { location: `http://evil.test:${port}/page` }).end(),
  "/to-https-downgrade": (_req, res) => void res.writeHead(302, { location: "ftp://example.com/x" }).end(),
  "/to-metadata": (_req, res) => void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end(),
  "/signin": (_req, res) => void res.writeHead(403).end("nope"),
  "/auth": (_req, res) => void res.writeHead(401).end("nope"),
  "/missing": (_req, res) => void res.writeHead(404).end("nope"),
  "/boom": (_req, res) => void res.writeHead(500).end("nope"),
  "/image": (_req, res) => void res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([1, 2, 3])),
  "/big-declared": (_req, res) => void res.writeHead(200, { "content-type": "text/html", "content-length": "5000000" }).end("x"),
  "/big-streamed": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const chunk = Buffer.alloc(8_000, 120);
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(chunk);
    }, 1);
    res.on("close", () => clearInterval(timer));
  },
  "/slow-start": () => {
    // Never answers.
  },
  "/slow-body": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<p>start");
    // Never ends.
  },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url, agent: req.headers["user-agent"] });
    (routes[req.url ?? ""] ?? ((_q, r) => void r.writeHead(404).end()))(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

/** The local server as a "public" site: http and its port allowed; only 127.0.0.2 (where evil.test points) counts as private. */
const local = (over: Partial<FetchPolicy> = {}): FetchPolicy => ({
  ...PUBLIC_POLICY,
  allowHttp: true,
  anyPort: true,
  isPublic: (ip) => ip !== "127.0.0.2" && !ip.startsWith("169.254."),
  timeoutMs: 3_000,
  ...over,
});
const dns = (map: Record<string, string[]>) => async (host: string) => {
  if (isIP(host)) return [host];
  const found = map[host];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};
const resolver = dns({ "ok.test": ["127.0.0.1"], "evil.test": ["127.0.0.2"] });
const refusedWith = async (run: () => Promise<unknown>, code: string, text?: RegExp) => {
  const e = await run().then(
    () => null,
    (err) => err,
  );
  expect(e).toBeInstanceOf(LinkError);
  expect(e.code).toBe(code);
  if (text) expect(e.message).toMatch(text);
  return e as LinkError;
};

describe("which addresses are public", () => {
  it("accepts ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4009:81a::200e"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("refuses loopback, private, link-local, shared, reserved and multicast addresses, and IPv6 forms that wrap them", () => {
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
      "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "240.0.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1",
      "::7f00:1", "::a00:5", "::127.0.0.1", "::ffff:0:7f00:1", "64:ff9b:1::7f00:1", "64:ff9b:1:ffff::1", "fec0::1", "feff::1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("refuses anything that isn't an address", () => {
    for (const x of ["", "localhost", "example.com", "999.1.1.1", "1.2.3"]) expect(isPublicAddress(x), x).toBe(false);
  });
});

describe("checking a link before fetching it", () => {
  it("wants https, no credentials, no port, and a real address", () => {
    expect(() => checkLink("https://example.com/page")).not.toThrow();
    expect(() => checkLink("http://example.com/page")).toThrow(/Only https/);
    expect(() => checkLink("ftp://example.com/page")).toThrow(/Only https/);
    expect(() => checkLink("file:///etc/passwd")).toThrow(/Only https/);
    expect(() => checkLink("not a link")).toThrow(/isn't a web address/);
    expect(() => checkLink("https://user:pw@example.com/")).toThrow(/user name or password/);
    expect(() => checkLink("https://example.com:8443/")).toThrow(/port number/);
  });
});

describe("the SSRF guard (default policy)", () => {
  it("refuses a local server by IP, by name, and in the awkward spellings of 127.0.0.1", async () => {
    const before = seen.length;
    for (const link of ["https://127.0.0.1/page", "https://localhost/page", "https://[::1]/page", "https://2130706433/page", "https://0x7f.1/page", "https://127.1/page", "https://[::ffff:127.0.0.1]/page", "https://0.0.0.0/"]) {
      const e = await refusedWith(() => fetchPublicPage(link), "not_public", /private or internal address/);
      expect(e.message, link).toContain(NOT_PUBLIC_ADVICE);
    }
    expect(seen.length).toBe(before);
  });

  it("refuses names that resolve to a private address, including when only one of several does", async () => {
    for (const ips of [["10.0.0.5"], ["169.254.169.254"], ["::1"], ["93.184.216.34", "192.168.0.1"], ["::ffff:10.0.0.1"]]) {
      const e = await refusedWith(() => fetchPublicPage("https://rebind.test/x", PUBLIC_POLICY, dns({ "rebind.test": ips })), "not_public", /private or internal/);
      expect(e.message).toContain("Make the page viewable by anyone with the link, or download the HTML and upload that.");
    }
  });

  it("says a name that doesn't exist doesn't exist", async () => {
    await refusedWith(() => fetchPublicPage("https://nowhere.test/x", PUBLIC_POLICY, dns({})), "not_found", /Couldn't find that web address/);
  });
});

describe("fetching from a local server standing in for a public one", () => {
  it("gets an HTML page, and the process block in it is found", async () => {
    const text = await fetchPublicPage(`http://ok.test:${port}/page`, local(), resolver);
    expect(processTextFrom(text).text).toBe(JSON.stringify(PROCESS_FILE_EXAMPLE));
    const last = seen.at(-1)!;
    expect(last.host).toBe(`ok.test:${port}`);
    expect(last.agent).toMatch(/^TransperaFlow/);
  });

  it("gets a JSON page too", async () => {
    expect(JSON.parse(await fetchPublicPage(`http://ok.test:${port}/json`, local(), resolver))).toEqual(PROCESS_FILE_EXAMPLE);
  });

  it("follows redirects (up to three) to the page", async () => {
    expect(await fetchPublicPage(`http://ok.test:${port}/hop1`, local(), resolver)).toBe(PAGE);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/loop`, local(), resolver), "failed", /too many times/);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/hop1`, local({ maxRedirects: 1 }), resolver), "failed", /too many times/);
  });

  it("refuses a redirect to a private address, to a metadata address, and to another protocol, without connecting", async () => {
    const before = seen.length;
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/to-private`, local(), resolver), "not_public", /private or internal/);
    expect(seen.length).toBe(before + 1);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/to-metadata`, local(), resolver), "not_public", /private or internal/);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/to-https-downgrade`, local(), resolver), "not_https");
  });

  it("explains a page that asks for sign-in, one that isn't there, an error, and something that isn't a page", async () => {
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/signin`, local(), resolver), "not_public", /asks for a sign-in.*Make the page viewable by anyone with the link, or download the HTML and upload that/);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/auth`, local(), resolver), "not_public", /asks for a sign-in/);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/missing`, local(), resolver), "not_found", /not found/);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/boom`, local(), resolver), "failed", /error \(500\)/);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/image`, local(), resolver), "not_a_page", /isn't a web page/);
  });

  it("caps the size: by the declared length, and by what actually arrives", async () => {
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/big-declared`, local(), resolver), "too_big", /too big/);
    await refusedWith(() => fetchPublicPage(`http://ok.test:${port}/big-streamed`, local({ maxBytes: 50_000 }), resolver), "too_big", /too big/);
    expect((await fetchPublicPage(`http://ok.test:${port}/page`, local({ maxBytes: 10_000 }), resolver)).length).toBeLessThan(10_000);
  });

  it("caps the time: a server that never answers, and one that never finishes", async () => {
    for (const path of ["/slow-start", "/slow-body"]) {
      const started = Date.now();
      await refusedWith(() => fetchPublicPage(`http://ok.test:${port}${path}`, local({ timeoutMs: 400 }), resolver), "timeout", /took too long/);
      expect(Date.now() - started).toBeLessThan(2_500);
    }
  });

  it("connects to the address it checked, not to a second lookup of the name", async () => {
    let lookups = 0;
    const flip = async (host: string) => (host === "ok.test" ? (lookups++ === 0 ? ["127.0.0.1"] : ["127.0.0.2"]) : []);
    // The name would resolve to the private address the second time; one lookup is made and its answer is used.
    expect(await fetchPublicPage(`http://ok.test:${port}/page`, local(), flip)).toBe(PAGE);
    expect(lookups).toBe(1);
  });

  it("a link is limited to 2,048 characters", async () => {
    expect(() => checkLink(`https://example.com/${"a".repeat(2_100)}`)).toThrow(/too long/);
    expect(() => checkLink(`https://example.com/${"a".repeat(1_900)}`)).not.toThrow();
  });

  it("counts the name lookup against the time limit (a resolver that hangs ends the fetch)", async () => {
    const hangs = () => new Promise<string[]>(() => undefined);
    const started = Date.now();
    await refusedWith(() => fetchPublicPage("https://slow.test/x", local({ timeoutMs: 300 }), hangs), "timeout", /took too long/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("connects to the checked address even when an environment proxy is configured", async () => {
    const saved = { use: process.env.NODE_USE_ENV_PROXY, http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY };
    process.env.NODE_USE_ENV_PROXY = "1";
    // A proxy that is not there: if the request went through it, it would fail.
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    const before = seen.length;
    try {
      expect(await fetchPublicPage(`http://ok.test:${port}/page`, local(), resolver)).toBe(PAGE);
      expect(seen.length).toBe(before + 1);
    } finally {
      for (const [k, v] of [["NODE_USE_ENV_PROXY", saved.use], ["HTTP_PROXY", saved.http], ["HTTPS_PROXY", saved.https]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
