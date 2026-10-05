// Stand-in for next/dynamic in the browser-test harnesses: React.lazy, with the loading placeholder while it loads.
import { createElement, lazy, Suspense, type ComponentType, type ReactNode } from "react";

export default function dynamic<P extends object>(load: () => Promise<ComponentType<P>>, options: { loading?: () => ReactNode } = {}): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: P) {
    return createElement(Suspense, { fallback: options.loading ? options.loading() : null }, createElement(Lazy as ComponentType<P>, props));
  };
}
