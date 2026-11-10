import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function that keeps its identity across renders and always calls the latest `fn`. For handlers handed to React Flow:
 * a new handler on every render makes it wake every handle and edge on each drag move (issue #249). Call it from events,
 * never while rendering.
 */
export function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
