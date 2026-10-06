// Stand-in for next/navigation in the browser-test harnesses that need the URL (B7's Forecast keeps the plan and the compare
// view in `?plan=` and `?compare=`): `router.replace` writes the URL here, `useSearchParams` and `usePathname` read it, and
// the latest is on `window.__harnessUrl` for a test to read. There is no history and nothing navigates.
import { useSyncExternalStore } from "react";

let url = "/";
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function setHarnessUrl(next: string): void {
  url = next;
  (globalThis as { __harnessUrl?: string }).__harnessUrl = next;
  for (const l of listeners) l();
}

const useUrl = () => useSyncExternalStore(subscribe, () => url, () => url);

export const useRouter = () => ({ push: setHarnessUrl, replace: setHarnessUrl, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} });
export const usePathname = () => useUrl().split("?")[0]!;
export const useSearchParams = () => new URLSearchParams(useUrl().split("?")[1] ?? "");
export const redirect = () => {
  throw new Error("redirect");
};
export const notFound = () => {
  throw new Error("notFound");
};
