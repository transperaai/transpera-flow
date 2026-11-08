import pg from "pg";
import type { Queryable } from "./shared.ts";

// How import.ts and verify.ts reach the target: plain `pg` over TCP (the default), or `@neondatabase/serverless`'s Pool over
// a WebSocket (`--driver neon-ws`), for a machine that can reach Neon only over HTTPS, such as the cloud container, where
// port 5432 is closed (docs/supabase-notes.md, "Checked on Neon"). Through HTTPS_PROXY when it is set. Either way the
// scripts get one connection, so the import's single transaction works the same.

export type Driver = "pg" | "neon-ws";
export const DRIVERS: Driver[] = ["pg", "neon-ws"];

export interface Connection {
  client: Queryable;
  close(): Promise<void>;
}

export interface NeonWsOptions {
  /** Where the WebSocket goes, as neonConfig.wsProxy takes it. Default: Neon's own proxy on the database host (`<host>/v2`). */
  wsProxy?: (host: string, port: number | string) => string;
  /** wss:// (default) or ws://. Only a local test proxy is plain. */
  secure?: boolean;
}

export async function connectTarget(url: string, driver: Driver = "pg", neon: NeonWsOptions = {}): Promise<Connection> {
  if (driver === "pg") {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return { client, close: () => client.end() };
  }
  const { Pool, neonConfig } = await import("@neondatabase/serverless");
  const { default: WebSocket } = await import("ws");
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const secure = neon.secure ?? true;
  if (proxy && secure) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    const agent = new HttpsProxyAgent(proxy);
    neonConfig.webSocketConstructor = class extends WebSocket {
      constructor(address: string | URL, protocols?: string | string[]) {
        super(address, protocols, { agent });
      }
    };
  } else {
    neonConfig.webSocketConstructor = WebSocket;
  }
  if (neon.wsProxy) neonConfig.wsProxy = neon.wsProxy;
  neonConfig.useSecureWebSocket = secure;
  if (!secure) {
    neonConfig.pipelineConnect = false;
    neonConfig.pipelineTLS = false;
    neonConfig.forceDisablePgSSL = true;
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  // A pool emits "error" when an idle connection drops; without a listener that would crash the process mid-report.
  pool.on("error", () => {});
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
  return {
    client: client as unknown as Queryable,
    async close() {
      client.release();
      await pool.end();
    },
  };
}
