// Fetch a page by link, for "Upload process" (issue #166, B13 slice 2). The page is fetched by the server, so the link is
// untrusted: it must not be a way to reach the server's own network (SSRF). The rules:
//
// - https only, on the default port, no user name or password in the link;
// - the host is resolved here and every address it resolves to must be public (not loopback, private, link-local,
//   carrier-grade NAT, multicast, reserved, or an IPv6 form that wraps one of those); the connection is then made to the
//   address that was checked, so the name can't resolve differently a second time (DNS rebinding);
// - redirects are followed by hand, at most three, and every hop goes through the same checks, so a public page can't
//   bounce the server to a private address;
// - the whole fetch has a time limit, and the body a size limit, counted as it arrives (a lying Content-Length or a
//   never-ending body is cut off).
//
// `FetchPolicy` exists so tests can point the same code at a local server; production uses PUBLIC_POLICY only.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** The advice that goes with every "can't open that link". */
export const NOT_PUBLIC_ADVICE = "Make the page viewable by anyone with the link, or download the HTML and upload that.";

export type LinkErrorCode = "invalid" | "not_https" | "not_public" | "not_found" | "timeout" | "too_big" | "not_a_page" | "failed";

/** A problem with a link, in words for the person who pasted it. */
export class LinkError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

export interface FetchPolicy {
  /** Allow http:// links (tests only). */
  allowHttp: boolean;
  /** Allow private, loopback and link-local addresses (tests only). */
  allowPrivate: boolean;
  /** Allow ports other than the default (tests only). */
  anyPort: boolean;
  /** What counts as a public address (tests only: lets a local server stand in for a public one). */
  isPublic?: (ip: string) => boolean;
  maxBytes: number;
  /** For the whole fetch, redirects included. */
  timeoutMs: number;
  maxRedirects: number;
}

export const PUBLIC_POLICY: FetchPolicy = { allowHttp: false, allowPrivate: false, anyPort: false, maxBytes: 2_000_000, timeoutMs: 10_000, maxRedirects: 3 };

// Separate lists: Node checks an IPv4 address against IPv6 rules as its IPv4-mapped form, so "::ffff:0:0/96" would match every IPv4 address.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [net4, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked4.addSubnet(net4, bits, "ipv4");
}
for (const [net6, bits] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-compatible (::a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d) forms, the local-use NAT64 prefix, and site-local: refused whole.
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b:1::", 48],
  ["fec0::", 10],
  // IPv4-mapped and NAT64 forms wrap an IPv4 address (possibly a private one): refuse the forms rather than unpick them.
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked6.addSubnet(net6, bits, "ipv6");
}

/** True when `ip` is an address on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  const bare = ip.replace(/%.*$/, "");
  return family === 4 ? !blocked4.check(bare, "ipv4") : !blocked6.check(bare, "ipv6");
}

/** The longest link taken; real page links are a few hundred characters. */
export const MAX_LINK = 2_048;

export type Resolver = (host: string) => Promise<string[]>;

const resolveAll: Resolver = async (host) => {
  if (net.isIP(host)) return [host];
  return (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
};

const TIMEOUT = "That link took too long to answer. Try again, or download the HTML and upload that.";
const refused = (what: string) => new LinkError("not_public", `${what} ${NOT_PUBLIC_ADVICE}`);

/** Parse and check a link before anything is fetched. */
export function checkLink(input: string, policy: FetchPolicy = PUBLIC_POLICY): URL {
  if (input.length > MAX_LINK) throw new LinkError("invalid", `That link is too long (over ${MAX_LINK.toLocaleString("en-GB")} characters). Paste the plain link to the page.`);
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new LinkError("invalid", "That isn't a web address. Paste a link that starts with https://.");
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    throw new LinkError("not_https", "Only https:// links can be opened. Paste a link that starts with https://, or download the HTML and upload that.");
  }
  if (url.username || url.password) throw new LinkError("invalid", "A link with a user name or password in it can't be opened. Make the page viewable by anyone with the link instead.");
  if (!policy.anyPort && url.port !== "") throw refused("Links with a port number can't be opened.");
  return url;
}

/** The address to connect to: the host's, if every address it has is public. */
async function vet(url: URL, policy: FetchPolicy, resolve: Resolver, signal: AbortSignal): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    // The name lookup counts against the time limit too: it is raced against the abort, so a resolver that hangs ends the fetch.
    addresses = await new Promise<string[]>((ok, no) => {
      if (signal.aborted) return no(new LinkError("timeout", TIMEOUT));
      signal.addEventListener("abort", () => no(new LinkError("timeout", TIMEOUT)), { once: true });
      resolve(host).then(ok, no);
    });
  } catch (e) {
    if (e instanceof LinkError) throw e;
    throw new LinkError("not_found", "Couldn't find that web address. Check the link and try again.");
  }
  if (!addresses.length) throw new LinkError("not_found", "Couldn't find that web address. Check the link and try again.");
  const isPublic = policy.isPublic ?? isPublicAddress;
  if (!policy.allowPrivate && addresses.some((a) => !isPublic(a))) {
    throw refused("That link points to a private or internal address, so Transpera can't open it.");
  }
  return addresses[0]!;
}

interface Hop {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
}

function hop(url: URL, address: string, policy: FetchPolicy, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.5", "user-agent": "TransperaFlow-Importer/1", "accept-encoding": "identity" },
        // Connect to the address that was checked, not to whatever the name resolves to now. TLS still checks the host's name.
        lookup: ((_host: string, options: { all?: boolean }, cb: (err: Error | null, address: unknown, family?: number) => void) => {
          const family = net.isIP(address);
          if (options?.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as never,
        signal,
        // Our own agent, not the global one: an environment proxy (NODE_USE_ENV_PROXY, HTTPS_PROXY) would connect to the proxy and
        // let it resolve the name, skipping the checked address above.
        agent: url.protocol === "https:" ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, contentType, body: Buffer.alloc(0) });
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > policy.maxBytes) {
          res.destroy();
          return reject(new LinkError("too_big", `That page is too big to import (over ${Math.round(policy.maxBytes / 1_000_000)} MB). Download the HTML and upload that.`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > policy.maxBytes) {
            res.destroy();
            reject(new LinkError("too_big", `That page is too big to import (over ${Math.round(policy.maxBytes / 1_000_000)} MB). Download the HTML and upload that.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch the page at `link` as text, under the rules at the top of this file. Throws a LinkError whose message is fit to show
 * the person who pasted the link.
 */
export async function fetchPublicPage(link: string, policy: FetchPolicy = PUBLIC_POLICY, resolve: Resolver = resolveAll): Promise<string> {
  let url = checkLink(link, policy);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), policy.timeoutMs);
  try {
    for (let redirects = 0; ; redirects++) {
      const address = await vet(url, policy, resolve, abort.signal);
      let res: Hop;
      try {
        res = await hop(url, address, policy, abort.signal);
      } catch (e) {
        if (e instanceof LinkError) throw e;
        if (abort.signal.aborted) throw new LinkError("timeout", TIMEOUT);
        throw new LinkError("failed", `Couldn't open that link. ${NOT_PUBLIC_ADVICE}`);
      }
      if (res.status >= 300 && res.status < 400 && res.location) {
        if (redirects >= policy.maxRedirects) throw new LinkError("failed", `That link redirects too many times. ${NOT_PUBLIC_ADVICE}`);
        // Every hop is checked as the first was: the next link is parsed, https-only and resolved to public addresses.
        url = checkLink(new URL(res.location, url).toString(), policy);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw refused("That page asks for a sign-in, so Transpera can't open it.");
      if (res.status === 404 || res.status === 410) throw new LinkError("not_found", "That link doesn't lead to a page (it answered \"not found\"). Check the link and try again.");
      if (res.status < 200 || res.status >= 300) throw new LinkError("failed", `That link answered with an error (${res.status}). ${NOT_PUBLIC_ADVICE}`);
      if (res.contentType && !/^(text\/|application\/(json|xhtml\+xml|[\w.+-]*\+json))/.test(res.contentType)) {
        throw new LinkError("not_a_page", "That link isn't a web page or a JSON file. Paste the link to the Claude Design page, or download the HTML and upload that.");
      }
      return res.body.toString("utf8");
    }
  } finally {
    clearTimeout(timer);
  }
}
