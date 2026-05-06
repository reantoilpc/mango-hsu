// SSR helper for landing/products/order/api routes. Avoids the V1-era
// `getStatus()` HTTP call (relative-URL fetch from inside the Worker doesn't
// resolve and falls through to FALLBACK_SETTINGS, hiding any product the
// admin added in /admin/products).
import { asc } from "drizzle-orm";
import { makeDb, type AppEnv } from "../db/client";
import { products } from "../db/schema";

export interface SiteSettings {
  accepting_dry: boolean;
  products: Array<{
    sku: string;
    name: string;
    variant: string;
    price: number;
    available: boolean;
    stock: number;
  }>;
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
  eta_days_after_payment: number;
  bank_account_display: string;
  support_line_id: string;
}

export async function loadSiteSettings(env: AppEnv): Promise<SiteSettings> {
  const db = makeDb(env);
  const productRows = await db
    .select()
    .from(products)
    .orderBy(asc(products.display_order));

  return {
    accepting_dry: env.ACCEPTING_DRY === "true",
    products: productRows.map((p) => ({
      sku: p.sku,
      name: p.name,
      variant: p.variant,
      price: p.price,
      available: p.available,
      stock: p.stock,
    })),
    shipping_fee_twd: parseInt(env.SHIPPING_FEE_TWD, 10) || 80,
    free_shipping_min_packages: parseInt(env.FREE_SHIPPING_MIN_PACKAGES, 10) || 10,
    eta_days_after_payment: parseInt(env.ETA_DAYS_AFTER_PAYMENT, 10) || 5,
    bank_account_display: env.BANK_ACCOUNT_DISPLAY,
    support_line_id: "", // legacy field, kept for V1 client compat
  };
}
