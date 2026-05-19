import type { APIRoute } from "astro";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";

// V5.2: per-SKU stock editing is deprecated. Stock now lives on product_groups
// as a fen pool — admin uses POST /api/admin/product-groups/:id/intake (PR2)
// to adjust pool weight. This endpoint returns 410 Gone with a hint.
export const PATCH: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  return json(
    {
      ok: false,
      error_code: "DEPRECATED",
      message:
        "V5.2: 庫存改為以重量池 (fen) 管理。請改用「進貨」功能（PR2 上線）— POST /api/admin/product-groups/:id/intake",
    },
    410,
  );
};
