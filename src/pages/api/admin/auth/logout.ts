import type { APIRoute } from "astro";
import { makeDb } from "../../../../db/client";
import { env } from "../../../../lib/env";
import {
  destroySession,
  clearSessionCookie,
  SESSION_COOKIE,
} from "../../../../lib/auth";
import { requireSameOrigin } from "../../../../lib/csrf";

// FIX #5: sign out. There was previously no logout route or UI, so a session on a
// shared family device stayed valid for its full 7-day TTL with no way to end it.
// This deletes the server-side sessions row (so a copied/lost cookie is actually
// REVOKED, not merely cleared client-side) and clears the cookie, then redirects
// to the login page.
export const POST: APIRoute = async ({ request }) => {
  if (!requireSameOrigin(request)) {
    return new Response("csrf", { status: 403 });
  }
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  if (match) {
    const db = makeDb(env);
    await destroySession(db, match[1]!);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin/login",
      "Set-Cookie": clearSessionCookie(),
    },
  });
};
