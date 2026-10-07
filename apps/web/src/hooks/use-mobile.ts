import { useSyncExternalStore } from "react"

// Below this width the sidebar is an off-canvas sheet. 1024 (not 768) keeps the map usable on tablets.
const QUERY = "(max-width: 1023px)"
/** A phone (issue #44): under Tailwind's `sm` (640px). The app is read-only here; tablets and phones turned sideways keep everything. */
export const PHONE_QUERY = "(max-width: 639px)"

function subscribeTo(query: string) {
  return (onChange: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }
}

const subscribe = subscribeTo(QUERY)
const subscribePhone = subscribeTo(PHONE_QUERY)

export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}

/** True under 640px. The server can't know the width, so it renders `false` and a phone switches right after hydration. */
export function useIsPhone() {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  )
}
