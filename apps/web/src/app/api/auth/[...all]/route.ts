import { toNextJsHandler } from "better-auth/next-js";
import { authEnv } from "@/lib/auth/env";
import { getAuth } from "@/lib/auth/server";

// Better Auth's endpoints: /api/auth/sign-in/social, /api/auth/callback/<provider>, /api/auth/sign-out, ...
// Built per request so a deployment without sign-in settings (demo mode) builds and answers 404 instead of throwing.

function handlers() {
  return toNextJsHandler(getAuth());
}

const unconfigured = () => new Response("Sign-in is not configured", { status: 404 });

export async function GET(request: Request) {
  return authEnv() ? handlers().GET(request) : unconfigured();
}

export async function POST(request: Request) {
  return authEnv() ? handlers().POST(request) : unconfigured();
}
