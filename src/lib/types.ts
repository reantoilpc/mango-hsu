// V2: SKUs are user-defined via the admin product CRUD (D1 `text("sku")`),
// so the literal union no longer matches reality. Kept as a named alias for
// readability rather than spreading bare `string` through the public API.
export type Sku = string;

// V5.2: client-side product shape now carries group context + derived count.
// available=false hides regardless; available=true && derived_available_count=0 shows
// as 售完 灰化. Underlying group_stock_fen is exposed for SSR derivation; client UI does
// NOT render it directly per design Constraints (don't expose actual jin remainder to
// customers).
export interface Product {
  sku: Sku;
  name: string;
  variant: string;
  price: number;
  available: boolean;
  package_fen: number;
  group_id: number;
  group_stock_fen: number;
  group_name: string;
  derived_available_count: number;
}

export interface SiteSettings {
  accepting_dry: boolean;
  products: Product[];
  shipping_fee_twd: number;
  eta_days_after_payment: number;
  bank_account_display: string;
  support_line_id: string;
}

export interface OrderItem {
  sku: Sku;
  qty: number;
}

export interface OrderRequest {
  idempotency_key: string;
  token: string;
  honeypot: string;
  name: string;
  phone: string;
  address: string;
  items: OrderItem[];
  notes: string;
  pdpa_accepted: boolean;
}

export interface OrderSuccess {
  ok: true;
  order_id: string;
  subtotal: number;
  shipping: number;
  total: number;
  expected_memo: string;
  bank_account_display: string;
  eta_days_after_payment: number;
  status_url: string;
  liff_bind_url: string | null;
  phone_last4: string;
}

export type OrderErrorCode =
  | "LOCKED"
  | "INVALID_TOKEN"
  | "SOLD_OUT"
  | "SEASON_CLOSED"
  | "INVALID_INPUT"
  | "INTERNAL"
  | "unknown_product";

export interface OrderError {
  ok: false;
  error_code: OrderErrorCode;
  // V5.2: SOLD_OUT now reports group_id (the group pool that ran dry). For SOLD_OUT
  // due to product.available=false (hidden product) and unknown_product, sku is set.
  sold_out_group_id?: number;
  sku?: Sku;
  message?: string;
}

export type OrderResponse = OrderSuccess | OrderError;

export interface OrderStatusSuccess {
  ok: true;
  order_id: string;
  paid: boolean;
  shipped: boolean;
  tracking_no: string | null;
  created_at: string;
}

export interface OrderStatusError {
  ok: false;
  error_code: "NOT_FOUND" | "INVALID_INPUT" | "INTERNAL" | "LOCKED";
}

export type OrderStatusResponse = OrderStatusSuccess | OrderStatusError;
