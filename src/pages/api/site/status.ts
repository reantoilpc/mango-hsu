import type { APIRoute } from "astro";
import { asc } from "drizzle-orm";
import { makeDb } from "../../../db/client";
import { products } from "../../../db/schema";
import { env } from "../../../lib/env";

interface SiteSettings {
  accepting_dry: boolean;
  products: Array<{
    sku: string;
    name: string;
    variant: string;
    price: number;
    available: boolean;
  }>;
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
  eta_days_after_payment: number;
  bank_account_display: string;
  support_line_id: string;
}

const json = (b: SiteSettings | { ok: false; error_code: string }, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

export const GET: APIRoute = async ({ locals }) => {


  const db = makeDb(env);
  const productRows = await db
    .select()
    .from(products)
    .orderBy(asc(products.display_order));

  return json({
    accepting_dry: env.ACCEPTING_DRY === "true",
    products: productRows.map((p) => ({
      sku: p.sku,
      name: p.name,
      variant: p.variant,
      price: p.price,
      available: p.available,
    })),
    shipping_fee_twd: parseInt(env.SHIPPING_FEE_TWD, 10) || 80,
    free_shipping_min_packages: parseInt(env.FREE_SHIPPING_MIN_PACKAGES, 10) || 10,
    eta_days_after_payment: parseInt(env.ETA_DAYS_AFTER_PAYMENT, 10) || 5,
    bank_account_display: env.BANK_ACCOUNT_DISPLAY,
    support_line_id: "", // no longer in schema; legacy field kept null for V1 client compat
  });
};
