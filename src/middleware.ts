import { defineMiddleware } from "astro:middleware";
import { makeDb } from "./db/client";
import { env } from "./lib/env";
import { verifySession, SESSION_COOKIE } from "./lib/auth";
import { CSP } from "./lib/csp";

// cso 2026-05-03 finding #4: defense-in-depth headers. CSP (HTML responses only)
// lives in ./lib/csp so it can be unit-tested without the astro:middleware import.
// 'unsafe-inline' on script-src is needed for the LIFF bind page's
// `<script define:vars is:inline>` SDK bridge and Astro's hydration bootstrap;
// all inline content is server-controlled.

function applySecurityHeaders(response: Response): Response {
  // Headers may be immutable on redirect-helper results, so reassemble.
  const headers = new Headers(response.headers);
  const ct = headers.get("Content-Type") ?? "";
  if (ct.includes("text/html")) {
    headers.set("Content-Security-Policy", CSP);
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const isAdmin = url.pathname.startsWith("/admin");
  // Logged-out-reachable admin pages: login + the forgot/reset-password flow (V6 §5.6).
  // A user who forgot their password has no session, so these must bypass the auth gate.
  // Exact-match only (no startsWith) so nothing else under /admin/ is accidentally exposed.
  const PUBLIC_ADMIN_PATHS = new Set([
    "/admin/login",
    "/admin/forgot-password",
  ]);

  if (!isAdmin || PUBLIC_ADMIN_PATHS.has(url.pathname)) {
    return applySecurityHeaders(await next());
  }

  const token = ctx.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return applySecurityHeaders(ctx.redirect("/admin/login"));

  const db = makeDb(env);
  const session = await verifySession(db, token);
  if (!session) {
    return applySecurityHeaders(ctx.redirect("/admin/login?error=expired"));
  }

  (ctx.locals as { session?: typeof session }).session = session;
  // FIX #4: enforce the first-login password change server-side. A session with
  // must_change_password set may ONLY reach /admin/change-password; every other
  // /admin/** page redirects there (previously this was a single login-time
  // redirect, bypassable by navigating directly to any other /admin URL). The
  // change-password + logout APIs live under /api/** so they are not gated here.
  if (session.must_change_password && url.pathname !== "/admin/change-password") {
    return applySecurityHeaders(ctx.redirect("/admin/change-password"));
  }
  return applySecurityHeaders(await next());
});
