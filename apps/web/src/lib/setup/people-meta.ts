// The People & roles page's meta line ("27 people · 10 roles"). It lives outside the page's "use client" module because the
// server page calls it: a function exported from a client module can't be called on the server (that threw on every load).
import type { CapacitySetup } from "@transpera-flow/db";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const peopleMeta = (setup: Pick<CapacitySetup, "people" | "roles">): string[] => [plural(setup.people.length, "person", "people"), plural(setup.roles.length, "role")];
