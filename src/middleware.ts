import { defineMiddleware } from "astro:middleware";
import { makeDb } from "./db/client";
import { env } from "./lib/env";
import { verifySession, SESSION_COOKIE } from "./lib/auth";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const isAdmin = url.pathname.startsWith("/admin");
  const isLogin = url.pathname === "/admin/login";

  if (!isAdmin || isLogin) return next();

  const token = ctx.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return ctx.redirect("/admin/login");

  const db = makeDb(env);
  const session = await verifySession(db, token);
  if (!session) return ctx.redirect("/admin/login?error=expired");

  (ctx.locals as { session?: typeof session }).session = session;
  return next();
});
