// Where sign-in returns a visitor who came from a share link (issue #32, B3). A restricted link asks the visitor to sign in with
// Google; the sign-in goes out and comes back through /auth/callback, which would send everyone to "/". A short-lived cookie
// carries the link's path across. Anything that isn't exactly `/s/<43 characters>` is ignored: no open redirect, and no `next`
// query parameter (Supabase's redirect allow-list would need changing in the dashboard).

export const AFTER_SIGN_IN_COOKIE = "tf_after_sign_in";

/** A share token: 32 random bytes, base64url. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHARE_PATH = /^\/s\/[A-Za-z0-9_-]{43}$/;

/** The path to go back to, from the cookie's value; null for anything else. */
export function afterSignInPath(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  let value = cookie;
  try {
    value = decodeURIComponent(cookie);
  } catch {
    return null;
  }
  return SHARE_PATH.test(value) ? value : null;
}

/** How long the cookie lives: long enough for the Google round trip. */
export const AFTER_SIGN_IN_MAX_AGE_SECONDS = 600;
