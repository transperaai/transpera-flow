// The bundle as AI reads it and as its analyses are hashed (B1 2b, issue #30). Pure.
//
// AI text is shared with every member, so AI must not read pay: it reads the model the way a member's browser builds it
// (the engine's `payHidden`), whoever pressed Analyse. And an analysis's "out of date" check compares what it read with
// what the page has now, so an editor's page and a member's must hash alike: names (which a member sees as labels) and pay
// (which a member doesn't get) are left out of what is hashed.

import type { ProcessBundle } from "@transpera-flow/db";

/** The bundle as AI reads it: no pay (the engine's payHidden), names as stored. */
export const payFreeBundle = <B extends ProcessBundle>(b: B): B => ({ ...b, viewer: { seesEveryone: false, ownPersonId: null } });

/** The same with every person's name replaced by their id: what an analysis's base hash reads, so an editor and a member hash the same. */
export const neutralBundle = <B extends ProcessBundle>(b: B): B => ({ ...payFreeBundle(b), people: b.people.map((p) => ({ ...p, name: p.id })) });
