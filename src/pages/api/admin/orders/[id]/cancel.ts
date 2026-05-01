import type { APIRoute } from "astro";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";

// Cancel = hard delete the order (FK cascade clears order_items and audit_log).
// Reason for hard delete: keeps the row count and SKU aggregates honest;
// soft delete adds a column users will inevitably forget to filter on.
// Audit trail of the cancellation itself is intentionally lost — by design,
// PDPA-friendly. If you need a history of cancellations, switch to soft delete
// in V3.
export const POST: APIRoute = async ({ request, params, locals }) => {


  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  await env.DB.prepare("PRAGMA foreign_keys = ON").run();
  const result = await env.DB.prepare("DELETE FROM orders WHERE order_id = ?")
    .bind(id)
    .run();

  if ((result.meta?.changes ?? 0) === 0) return text("not found", 404);
  return json({ ok: true });
};
