"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";
import { ErrorState } from "@/components/shell/error-state";
import { cn } from "@/lib/utils";

// The root layout is gone when this shows, so it sets up its own document, tokens and fonts (the same as layout.tsx).
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

/** The last resort: an error in the root layout itself (issue #44). Reports every error it gets; a no-op without a DSN. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className={cn("h-full font-sans antialiased", inter.variable, plexMono.variable)}>
      <body className="flex min-h-full flex-col font-sans text-sm">
        <title>Something went wrong · Transpera Flow</title>
        <main className="p-4">
          <ErrorState digest={error.digest} onRetry={retry} />
        </main>
      </body>
    </html>
  );
}
