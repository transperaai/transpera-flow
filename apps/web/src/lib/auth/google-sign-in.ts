import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authEnv, type ProviderId } from "./env";
import { incomingRequest } from "./providers";
import { getAuth } from "./server";

/**
 * Hands off to the provider, which returns through /api/auth/callback/<provider> and then to `callbackURL` (a path on this site).
 * Shared by the login page and a share link's sign-in (B3), so both ask for the same scopes. Never returns: it redirects to the
 * provider, or to /login with the reason. A refused sign-in (not on the access list) also lands on /login, from the callback.
 */
export async function redirectToProvider(provider: ProviderId, callbackURL = "/"): Promise<never> {
  const env = authEnv();
  if (!env || !env.providers.includes(provider)) redirect(`/login?error=${encodeURIComponent("That sign-in method is unavailable.")}`);
  let url: string | undefined;
  let message = "Sign-in is unavailable.";
  try {
    const h = new Headers(await headers());
    const result = await getAuth().api.signInSocial({
      body: { provider, callbackURL, errorCallbackURL: "/login" },
      headers: h,
      // Only matters to the oAuthProxy (a deployment with BETTER_AUTH_URL): see incomingRequest.
      ...(env.baseUrl ? { request: incomingRequest(h, "/api/auth/sign-in/social"), asResponse: false } : {}),
    });
    url = result.url;
  } catch (error) {
    console.error("sign-in: could not start", error);
    if (error instanceof Error && error.message) message = error.message;
  }
  if (!url) redirect(`/login?error=${encodeURIComponent(message)}`);
  redirect(url);
}

export const redirectToGoogle = (callbackURL = "/") => redirectToProvider("google", callbackURL);
