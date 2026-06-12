import type { OrderResponse } from "./order-response";

interface OrderItemInput {
  sku: string;
  qty: number;
}

interface CommonOrderInput {
  name: string;
  phone: string;
  address: string;
  items: OrderItemInput[];
}

interface CustomerOrderInput extends CommonOrderInput {
  pdpa_accepted: boolean;
}

function validateCommon(body: CommonOrderInput): OrderResponse | null {
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 50) {
    return { ok: false, error_code: "INVALID_INPUT", message: "姓名格式錯誤" };
  }
  // Accept TW mobile (09xxxxxxxx) AND landline (area code + number, e.g. 06-6902222).
  // Normalize spaces/hyphens, then require 0 + 8–9 digits (9–10 total). Stored as-entered.
  if (!/^0\d{8,9}$/.test((body.phone || "").replace(/[\s-]/g, ""))) {
    return {
      ok: false,
      error_code: "INVALID_INPUT",
      message: "電話格式錯誤（手機或室內電話，例 0912345678 或 06-6902222）",
    };
  }
  if (
    typeof body.address !== "string" ||
    body.address.trim().length < 5 ||
    body.address.length > 200
  ) {
    return { ok: false, error_code: "INVALID_INPUT", message: "地址格式錯誤" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, error_code: "INVALID_INPUT", message: "請至少選購一項" };
  }
  for (const it of body.items) {
    if (
      !it ||
      typeof it.sku !== "string" ||
      !Number.isInteger(it.qty) ||
      it.qty < 1 ||
      it.qty > 99
    ) {
      return { ok: false, error_code: "INVALID_INPUT", message: "品項格式錯誤" };
    }
  }
  return null;
}

export function validateCustomerOrder(body: CustomerOrderInput): OrderResponse | null {
  const common = validateCommon(body);
  if (common) return common;
  if (body.pdpa_accepted !== true) {
    return { ok: false, error_code: "INVALID_INPUT", message: "未同意個資告知" };
  }
  return null;
}

export function validateAdminOrder(body: CommonOrderInput): OrderResponse | null {
  return validateCommon(body);
}
