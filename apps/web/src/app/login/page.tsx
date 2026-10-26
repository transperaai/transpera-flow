import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { ACCESS_DENIED_CODE, ACCESS_DENIED_MESSAGE } from "@/lib/auth/access";
import { authEnv } from "@/lib/auth/env";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // Render per request: sign-in settings are read at runtime, not build time.
  await connection();
  const env = authEnv();
  if (!env) redirect("/demo");
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2.5 font-display text-base font-bold tracking-tight">
          <span aria-hidden className="size-[22px] rounded-md bg-[conic-gradient(from_200deg,var(--accent),var(--chart-1),var(--chart-5),var(--accent))]" />
          Transpera Flow
        </p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Sign in</h1>
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {error === ACCESS_DENIED_CODE
              ? `${ACCESS_DENIED_MESSAGE}. Ask the person who runs it to add you, then try again.`
              : `Sign-in failed: ${error} Please try again.`}
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent>
          <LoginForm providers={env.providers} />
        </CardContent>
      </Card>
      <a href="/privacy" className="text-xs text-muted-foreground underline underline-offset-2">
        Privacy policy
      </a>
    </main>
  );
}
