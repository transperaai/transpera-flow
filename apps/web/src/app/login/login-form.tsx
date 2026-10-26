import { Button } from "@/components/ui/button";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/auth/env";
import { signInWith } from "./actions";

export function LoginForm({ providers }: { providers: ProviderId[] }) {
  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => (
        <form key={provider} action={signInWith.bind(null, provider)}>
          <Button type="submit" size="lg" className="w-full">
            Continue with {PROVIDER_LABELS[provider]}
          </Button>
        </form>
      ))}
      <p className="text-sm text-muted-foreground">Use your work account.</p>
    </div>
  );
}
