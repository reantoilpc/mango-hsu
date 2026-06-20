import type { APIRoute } from "astro";
import { makeDb } from "../../../db/client";
import { order_groups } from "../../../db/schema";
import { and, eq, gt } from "drizzle-orm";
import { isValidGroupCode } from "../../../lib/order-groups";
import { checkPublicStatusRate } from "../../../lib/rate-limit";
import { env } from "../../../lib/env";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkPublicStatusRate(env, ip))) return json({ ok: false }, 429);
  const code = params.code ?? "";
  if (!isValidGroupCode(code)) return json({ ok: false });
  const db = makeDb(env);
  const now = new Date().toISOString();
  const rows = await db
    .select({ host_name: order_groups.host_name, deadline: order_groups.deadline })
    .from(order_groups)
    .where(and(eq(order_groups.code, code), eq(order_groups.status, "open"), gt(order_groups.deadline, now)))
    .limit(1);
  if (rows.length === 0) return json({ ok: false });
  return json({ ok: true, host_name: rows[0]!.host_name, deadline: rows[0]!.deadline });
};
