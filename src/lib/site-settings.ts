// SSR helper for landing/products/order/api routes. Avoids the V1-era `getStatus()` HTTP
// call (relative-URL fetch from inside the Worker doesn't resolve and falls through to
// FALLBACK_SETTINGS, hiding any product the admin added in /admin/products).
//
// V5.2: products are scoped to the active season. Per-SKU available count is DERIVED at
// the UI layer from the group's stock_fen pool (floor(stock_fen / package_fen)). The pool
// stock_fen value is exposed on each product so the UI can compute it without an extra
// query.
//
// Customer-facing UI does NOT show the actual jin remainder (per design Constraints) —
// it only uses derived count to decide between rendering "可購買" / "售完". Admin UI
// does render the jin number directly via /admin/products.

import { and, asc, eq } from "drizzle-orm";
import { makeDb, type AppEnv } from "../db/client";
import { products, product_groups, seasons } from "../db/schema";
import { parseShippingConfig, type ShippingConfig } from "./shipping";

export interface SiteSettings {
  accepting_dry: boolean;
  // V5.2: each product carries its group's current stock_fen + package_fen so UI can
  // derive available count without another round-trip. The actual stock_fen value is
  // intentionally exposed only in the SSR payload (admin UI tolerated; we do NOT render
  // jin remainder client-side per Constraints).
  products: Array<{
    sku: string;
    name: string;
    variant: string;
    price: number;
    available: boolean;
    package_fen: number;
    group_id: number;
    group_stock_fen: number;
    group_name: string;
    // Computed at SSR time so the client doesn't have to do floor() math.
    derived_available_count: number;
  }>;
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
  // V6 §5.5: active season's parsed shipping policy. Frontend uses this to render
  // the fee line / FAQ and to bake a JSON island for client-side shipping preview.
  // shipping_fee_twd above is kept (legacy field) and now derives from shipping_config.
  shipping_config: ShippingConfig;
  eta_days_after_payment: number;
  bank_account_display: string;
  support_line_id: string;
}

export async function loadSiteSettings(env: AppEnv): Promise<SiteSettings> {
  const db = makeDb(env);

  // V6 §5.5: active season shipping policy. Queried separately so it resolves even when
  // the season has zero products yet (productRows would be empty in that case).
  const activeSeasonRows = await db
    .select({ shipping_config: seasons.shipping_config })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const shippingConfig = parseShippingConfig(activeSeasonRows[0]?.shipping_config ?? null);

  // Pull active-season products + their group's pool weight in one JOIN.
  // (Tiny scale — ~5 SKUs in active season — so no caching layer needed.)
  const productRows = await db
    .select({
      sku: products.sku,
      name: products.name,
      variant: products.variant,
      price: products.price,
      available: products.available,
      package_fen: products.package_fen,
      group_id: products.group_id,
      display_order: products.display_order,
      group_stock_fen: product_groups.stock_fen,
      group_name: product_groups.name,
      group_available: product_groups.available,
      group_display_order: product_groups.display_order,
    })
    .from(products)
    .innerJoin(product_groups, eq(product_groups.id, products.group_id))
    .innerJoin(seasons, eq(seasons.id, products.season_id))
    .where(eq(seasons.status, "active"))
    .orderBy(asc(product_groups.display_order), asc(products.display_order));

  return {
    accepting_dry: env.ACCEPTING_DRY === "true",
    products: productRows.map((p) => ({
      sku: p.sku,
      name: p.name,
      variant: p.variant,
      price: p.price,
      // Customer can buy iff:
      //   - product.available = true (admin hasn't hidden it)
      //   - group.available = true (admin hasn't paused the whole flavour)
      //   - derived count > 0 (pool has enough fen for at least one of this package size)
      available: p.available && p.group_available,
      package_fen: p.package_fen,
      group_id: p.group_id,
      group_stock_fen: p.group_stock_fen,
      group_name: p.group_name,
      derived_available_count: Math.floor(p.group_stock_fen / p.package_fen),
    })),
    // V6: legacy field now derives from shipping_config (the "base" fee charged below
    // threshold / always for flat). Kept so any V1-era client reading it still works.
    shipping_fee_twd: shippingConfig.fee_twd,
    // Legacy field — V6 threshold uses fen (free_over_fen), not package count. For a
    // threshold_jin config we surface the 斤 figure (free_over_fen/100) as a best-effort
    // back-compat value; flat configs report 0 (no threshold). Not used by V6 UI.
    free_shipping_min_packages:
      shippingConfig.type === "threshold_jin"
        ? Math.floor(shippingConfig.free_over_fen / 100)
        : 0,
    shipping_config: shippingConfig,
    eta_days_after_payment: parseInt(env.ETA_DAYS_AFTER_PAYMENT, 10) || 5,
    bank_account_display: env.BANK_ACCOUNT_DISPLAY,
    support_line_id: "", // legacy field, kept for V1 client compat
  };
}
