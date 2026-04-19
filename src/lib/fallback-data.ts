import type { Product, SiteSettings } from "./types";

export const FALLBACK_PRODUCTS: Product[] = [
  { sku: "DRY-JH-1", name: "金煌芒果乾", variant: "1 斤", price: 450, available: true },
  { sku: "DRY-JH-05", name: "金煌芒果乾", variant: "半斤", price: 230, available: true },
  { sku: "DRY-AW-1", name: "愛文芒果乾", variant: "1 斤", price: 480, available: true },
  { sku: "DRY-AW-05", name: "愛文芒果乾", variant: "半斤", price: 250, available: true },
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
