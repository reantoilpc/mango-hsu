import { defineMiddleware } from "astro:middleware";
import { makeDb } from "./db/client";
import { env } from "./lib/env";
import { verifySession, SESSION_COOKIE } from "./lib/auth";

// cso 2026-05-03 finding #4: defense-in-depth headers. CSP only on HTML
// responses; the rest apply broadly. 'unsafe-inline' on script-src is needed
// for the LIFF bind page (`<script define:vars is:inline>` for the LIFF SDK
// bridge) and Astro's hydration bootstrap. All inline content is
// server-controlled. Migrate to nonce or hash-based CSP if user-generated
// HTML is ever introduced.
const CSP =
  "default-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; " +
  "script-src 'self' 'unsafe-inline' https://static.line-scdn.net; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self';";

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
  const isLogin = url.pathname === "/admin/login";

  if (!isAdmin || isLogin) return applySecurityHeaders(await next());

  const token = ctx.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return applySecurityHeaders(ctx.redirect("/admin/login"));

  const db = makeDb(env);
  const session = await verifySession(db, token);
  if (!session) {
    return applySecurityHeaders(ctx.redirect("/admin/login?error=expired"));
  }

  (ctx.locals as { session?: typeof session }).session = session;
  return applySecurityHeaders(await next());
});
