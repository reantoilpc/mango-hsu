import type { APIRoute } from "astro";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";

// V5.2: PATCH /items is deprecated. The V5 sticky-save endpoint (POST /save) handles
// items + address + notes in one gate-first batch with expected_state + items_hash.
// This endpoint is kept as a 410 stub in case any old client (curl scripts, etc.) still
// calls it.
export const PATCH: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  return json(
    {
      ok: false,
      error_code: "DEPRECATED",
      message:
        "V5: items 編輯改用 sticky-save (POST /api/admin/orders/:id/save)，含 expected_state + items_hash gate。",
    },
    410,
  );
};
