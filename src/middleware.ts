import { defineMiddleware } from "astro:middleware";
import { makeDb, type AppEnv } from "./db/client";
import { verifySession, SESSION_COOKIE } from "./lib/auth";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const isAdmin = url.pathname.startsWith("/admin");
  const isLogin = url.pathname === "/admin/login";

  if (!isAdmin || isLogin) return next();

  const env = ctx.locals.runtime?.env as AppEnv | undefined;
  if (!env) return ctx.redirect("/admin/login?error=no_runtime");

  const token = ctx.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return ctx.redirect("/admin/login");

  const db = makeDb(env);
  const session = await verifySession(db, token);
  if (!session) return ctx.redirect("/admin/login?error=expired");

  // attach to locals for pages
  (ctx.locals as { session?: typeof session }).session = session;
  return next();
});
