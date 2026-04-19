export type Sku = "DRY-JH-1" | "DRY-JH-05" | "DRY-AW-1" | "DRY-AW-05";

export interface Product {
  sku: Sku;
  name: string;
  variant: string;
  price: number;
  available: boolean;
}

export interface SiteSettings {
  accepting_dry: boolean;
  products: Product[];
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
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
}

export type OrderErrorCode =
  | "LOCKED"
  | "INVALID_TOKEN"
  | "SOLD_OUT"
  | "SEASON_CLOSED"
  | "INVALID_INPUT"
  | "INTERNAL";

export interface OrderError {
  ok: false;
  error_code: OrderErrorCode;
  sold_out_sku?: Sku;
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
  error_code: "NOT_FOUND" | "INVALID_INPUT" | "INTERNAL";
}

export type OrderStatusResponse = OrderStatusSuccess | OrderStatusError;
