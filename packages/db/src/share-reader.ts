import type { Db } from "./queries";

/** What a share link's People toggle says (see `shareReaderDb` in ./share.ts). */
export interface ShareToggles {
  people: boolean;
}

/**
 * The `Db`s made by `shareReaderDb`, with their toggles. The earlier PostgREST client let a Proxy swap two `.rpc()` calls; the Kysely
 * helpers run plain SQL, so the two loaders that make those calls (`loadTeam`, `readerSeesPeople`) look here instead.
 */
export const shareToggles = new WeakMap<Db, ShareToggles>();
