import type { AppEnv, Db } from "../db/client";
import { audit_log } from "../db/schema";
import type { Order } from "../db/schema";

// V5.2: items shape is now generic — caller (api/orders.ts) passes the resolved
// product info directly so telegram doesn't need to JOIN. sku/name/variant/qty
// are all the message needs.
export async function notifyOrder(
  env: AppEnv,
  db: Db,
  order: Order,
  items: Array<{ sku: string; name?: string; variant?: string; qty: number }>,
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    await db.insert(audit_log).values({
      ts: new Date().toISOString(),
      user_email: "<system>",
      action: "telegram_misconfigured",
      order_id: order.order_id,
      details: JSON.stringify({ has_token: !!token, has_chat: !!chatId }),
    });
    return;
  }

  const itemsLine = items
    .map((i) => {
      const label = i.name && i.variant ? `${i.name}${i.variant}` : i.sku;
      return `${label} ×${i.qty}`;
    })
    .join("、");

  const msg = [
    `🥭 新訂單 ${order.order_id}`,
    `客人: ${order.name} (${order.phone})`,
    `品項: ${itemsLine}`,
    `合計: $${order.total}（含運 ${order.shipping}）`,
    `備註欄: ${order.expected_memo}`,
    `地址: ${order.address}`,
    order.notes ? `客戶備註: ${order.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    });
    if (!res.ok) {
      throw new Error(`Telegram API ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    await db.insert(audit_log).values({
      ts: new Date().toISOString(),
      user_email: "<system>",
      action: "telegram_failed",
      order_id: order.order_id,
      details: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    });
  }
}

// V6 §5.6: generic Telegram push (forgot-password reset link, future alerts). Reuses the same
// bot token + chat id as order notifications but with an arbitrary message body. Does NOT touch
// notifyOrder (the live order-notification path stays untouched). Fire-and-forget friendly:
// returns true on a 2xx send, false on misconfig/error — the caller decides whether to audit.
// IMPORTANT: callers on a latency-sensitive path (request-reset) must NOT await this inside the
// response path (it would leak email-existence via timing); kick it off and ignore the promise.
export async function sendTelegramMessage(env: AppEnv, text: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
