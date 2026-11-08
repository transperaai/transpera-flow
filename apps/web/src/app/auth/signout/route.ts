import { NextResponse, type NextRequest } from "next/server";
import { authEnv } from "@/lib/auth/env";
import { getAuth } from "@/lib/auth/server";

export async function POST(request: NextRequest) {
  if (authEnv()) {
    try {
      // The nextCookies plugin clears the session cookie on this response.
      await getAuth().api.signOut({ headers: request.headers });
    } catch (error) {
      console.error("sign-out failed", error);
    }
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url, { status: 303 });
}
