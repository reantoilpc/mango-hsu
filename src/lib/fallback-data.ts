import type { Product, SiteSettings } from "./types";

// V4: stock=0 in fallback so D1-down state shows everything as 售完
// instead of accepting orders we can't fulfil. Real stock comes from D1.
export const FALLBACK_PRODUCTS: Product[] = [
  { sku: "DRY-JH-1", name: "金煌芒果乾", variant: "1 斤", price: 450, available: true, stock: 0 },
  { sku: "DRY-JH-05", name: "金煌芒果乾", variant: "半斤", price: 230, available: true, stock: 0 },
  { sku: "DRY-AW-1", name: "愛文芒果乾", variant: "1 斤", price: 480, available: true, stock: 0 },
  { sku: "DRY-AW-05", name: "愛文芒果乾", variant: "半斤", price: 250, available: true, stock: 0 },
];

export const FALLBACK_SETTINGS: SiteSettings = {
  accepting_dry: true,
  products: FALLBACK_PRODUCTS,
  shipping_fee_twd: 80,
  free_shipping_min_packages: 10,
  eta_days_after_payment: 3,
  bank_account_display: "（請洽家人提供帳號）",
  support_line_id: "@mango-hsu",
};
