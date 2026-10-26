// A restricted share link asks the visitor to sign in (issue #32, B3). The sign-in passes the link's own path, `/s/<token>`, as
// Better Auth's `callbackURL`, so the visitor lands back on it. The path is built from a token checked against this pattern, never
// from anything the visitor sends, so there is no open redirect.

/** A share token: 32 random bytes, base64url. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
