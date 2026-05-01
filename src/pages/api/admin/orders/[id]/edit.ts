import type { APIRoute } from "astro";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";

export const POST: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env;
  if (!env) return text("no runtime", 500);

  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: { address?: string; notes?: string };
  try {
    body = (await request.json()) as { address?: string; notes?: string };
  } catch {
    return text("bad json", 400);
  }
  const address = (body.address ?? "").trim();
  const notes = (body.notes ?? "").trim();
  if (address.length < 5 || address.length > 200) return text("bad address", 400);
  if (notes.length > 500) return text("notes too long", 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET address = ?, notes = ? WHERE order_id = ?").bind(
      address,
      notes || null,
      id,
    ),
    env.DB.prepare(
      "INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, 'edit', ?, ?)",
    ).bind(
      now,
      auth.session.email,
      id,
      JSON.stringify({ address_len: address.length, notes_len: notes.length }),
    ),
  ]);
  return json({ ok: true });
};
