import type {
  OrderRequest,
  OrderResponse,
  OrderStatusResponse,
  SiteSettings,
} from "./types";

const APPS_SCRIPT_URL = import.meta.env.PUBLIC_APPS_SCRIPT_URL ?? "";
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
  if (!APPS_SCRIPT_URL) return null;
  const ctrl = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${APPS_SCRIPT_URL}?action=status`, {
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
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
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
    const res = await fetch(
      `${APPS_SCRIPT_URL}?action=order&id=${encodeURIComponent(orderId)}`,
      { method: "GET", signal: ctrl.signal },
    );
    return (await res.json()) as OrderStatusResponse;
  } catch {
    return { ok: false, error_code: "INTERNAL" };
  }
}
