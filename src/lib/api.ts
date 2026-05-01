import type {
  OrderRequest,
  OrderResponse,
  OrderStatusResponse,
  SiteSettings,
} from "./types";

// V2: customer site posts to same-origin /api/* endpoints (no more Apps Script).
// PUBLIC_APPS_SCRIPT_URL kept readable from import.meta.env only as a temporary
// fallback during the cutover window — drop after Phase 5.
const FALLBACK_APPS_SCRIPT_URL = import.meta.env.PUBLIC_APPS_SCRIPT_URL ?? "";
const ORDER_TOKEN = import.meta.env.PUBLIC_ORDER_TOKEN ?? "";

const FETCH_TIMEOUT_MS = 15_000;

function withTimeout(ms: number): AbortController {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c;
}

export function newIdempotencyKey(): string {
  const g = globalThis as unknown as {
    crypto?: { randomUUID?: () => string };
  };
  if (typeof g.crypto?.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  const r = () => Math.random().toString(16).slice(2, 10);
  return `${Date.now().toString(16)}-${r()}-${r()}-${r()}`;
}

export async function getStatus(): Promise<SiteSettings | null> {
  const ctrl = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("/api/site/status", {
      method: "GET",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as SiteSettings;
  } catch {
    return null;
  }
}

export function orderToken(): string {
  return ORDER_TOKEN;
}

export async function submitOrder(
  body: Omit<OrderRequest, "token">,
): Promise<OrderResponse> {
  const ctrl = withTimeout(FETCH_TIMEOUT_MS);
  const payload: OrderRequest = { ...body, token: ORDER_TOKEN };
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return (await res.json()) as OrderResponse;
  } catch (e) {
    return {
      ok: false,
      error_code: "INTERNAL",
      message:
        e instanceof DOMException && e.name === "AbortError"
          ? "網路逾時"
          : "網路錯誤",
    };
  }
}

export async function getOrderStatus(
  orderId: string,
): Promise<OrderStatusResponse> {
  const ctrl = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/public`, {
      method: "GET",
      signal: ctrl.signal,
    });
    return (await res.json()) as OrderStatusResponse;
  } catch {
    return { ok: false, error_code: "INTERNAL" };
  }
}

// Kept exported (unused) so code searching for the old URL constant still finds
// the new file. Remove after Phase 5 cutover.
export const _LEGACY_APPS_SCRIPT_URL = FALLBACK_APPS_SCRIPT_URL;
