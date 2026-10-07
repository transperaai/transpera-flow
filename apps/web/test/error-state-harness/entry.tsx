// The real ErrorState (issue #44) on a bare page, for ../error-state-browser.test.ts. Nothing here ships.

import { createRoot } from "react-dom/client";
import { ErrorState } from "@/components/shell/error-state";

declare global {
  interface Window {
    retries: number;
    mountErrorState: (props?: { digest?: string; homeHref?: string; withRetry?: boolean }) => void;
  }
}

window.retries = 0;
window.mountErrorState = ({ digest, homeHref, withRetry = true } = {}) => {
  createRoot(document.getElementById("root")!).render(<ErrorState digest={digest} homeHref={homeHref} onRetry={withRetry ? () => (window.retries += 1) : undefined} />);
};
