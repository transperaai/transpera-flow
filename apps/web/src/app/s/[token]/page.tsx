import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { SHARE_KINDS, SHARE_SNAPSHOT_VERSION, type ShareSnapshot } from "@transpera-flow/db";
import { SharedView } from "@/components/share/shared-view";
import { Button } from "@/components/ui/button";
import { SHARE_TOKEN } from "@/lib/share/after-sign-in";
import { supabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { signInToOpen } from "./actions";

// A share link's page (issue #32, B3): a visitor, signed in or not, opens a frozen, redacted copy of a page. The ONLY data this page
// has is what `public.open_share_link` returns for the token; it imports no loader that reads the workspace's tables (a source-text
// test checks it). Expired, turned-off, unknown and malformed links all look the same: not found.

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Shared view", robots: { index: false, follow: false } };
}

interface Opened {
  status?: string;
  kind?: string;
  mode?: string;
  show_people?: boolean;
  show_financials?: boolean;
  snapshot_at?: string;
  expires_at?: string | null;
  snapshot?: { v?: number; kind?: string };
}

export default async function SharedPage(props: PageProps<"/s/[token]">) {
  await connection();
  const { token } = await props.params;
  if (!supabaseEnv() || !SHARE_TOKEN.test(token)) notFound();
  const db = await createClient();
  const { data, error } = await db.rpc("open_share_link", { token });
  const opened = data as Opened | null;
  if (error || !opened || typeof opened !== "object") notFound();

  if (opened.status === "sign_in") {
    return (
      <Gate title="Sign in to open this link">
        <p className="text-fg-2">This link is only for the people it was shared with. Sign in with Google using the email address it was sent to.</p>
        <form action={signInToOpen.bind(null, token)}>
          <Button type="submit" size="lg" className="w-full">
            Continue with Google
          </Button>
        </form>
      </Gate>
    );
  }
  if (opened.status === "not_allowed") {
    // The address comes from the visitor's own session, never from the link.
    const { data: user } = await db.auth.getUser();
    const email = user.user?.email ?? "this account";
    return (
      <Gate title="This link wasn't shared with you">
        <p className="text-fg-2">
          This link wasn&apos;t shared with <b className="font-semibold text-foreground">{email}</b>.
        </p>
        <form action="/auth/signout" method="post" className="flex flex-col gap-2">
          <Button type="submit" variant="outline" size="lg" className="w-full">
            Sign in with a different account
          </Button>
          <p className="text-xs text-muted-foreground">You&apos;ll be signed out. Then open the link again with the right account.</p>
        </form>
      </Gate>
    );
  }
  if (opened.status !== "ok") notFound();

  const snapshot = opened.snapshot;
  if (!snapshot || snapshot.v !== SHARE_SNAPSHOT_VERSION || !SHARE_KINDS.includes(snapshot.kind as never)) {
    return (
      <Gate title="This link needs to be made again">
        <p className="text-fg-2">Ask whoever sent it for a new one.</p>
      </Gate>
    );
  }
  // A play link (B4): the page also needs the token (the Send action takes it) and, for a restricted link, the address the visitor
  // signed in with, from their own session (as the not-allowed gate above). It still calls only `open_share_link`.
  const play = opened.mode === "play";
  let visitorEmail: string | null = null;
  if (play && (opened.show_people || opened.show_financials)) {
    const { data: user } = await db.auth.getUser();
    visitorEmail = user.user?.email ?? null;
  }
  return (
    <SharedView
      data={{
        snapshot: snapshot as unknown as ShareSnapshot,
        snapshotAt: opened.snapshot_at ?? "",
        expiresAt: opened.expires_at ?? null,
        mode: play ? "play" : "view",
        token: play ? token : undefined,
        visitorEmail,
      }}
    />
  );
}

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2.5 font-display text-base font-bold tracking-tight">
          <span aria-hidden className="size-[22px] rounded-md bg-[conic-gradient(from_200deg,var(--accent),var(--chart-1),var(--chart-5),var(--accent))]" />
          Transpera Flow
        </p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="flex flex-col gap-4 text-sm">{children}</div>
    </main>
  );
}
