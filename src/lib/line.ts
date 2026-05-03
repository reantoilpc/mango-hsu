import { eq } from "drizzle-orm";
import type { AppEnv, Db } from "../db/client";
import { audit_log, orders } from "../db/schema";
import type { Order } from "../db/schema";

const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const LINE_PUSH_TIMEOUT_MS = 8000;
const SIG_TTL_SECONDS = 30 * 60; // 30 min
const MONTHLY_PUSH_CAP = 200;
const MONTHLY_PUSH_ALERT_THRESHOLD = 160;

const ENCODER = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(payload));
  return base64UrlEncode(new Uint8Array(sig));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface LiffBindUrlParts {
  url: string;
  exp: number;
  sig: string;
}

// HMAC payload includes phone-last-4 (cso 2026-05-03 finding #10): the prior
// design protected the bind URL only via expiry + abuse rule. Anyone who
// intercepted the URL inside its 30-min window (qrserver leak, screenshot
// shared in LINE chat, etc.) could bind their own LINE user before the
// customer. Phone last-4 in the payload means the URL alone is insufficient
// — server re-derives sig from `${order}:${p}:${exp}` and only the customer
// (who has their own phone) can produce a matching value via /liff-url regen.
export async function buildLiffBindUrl(
  orderId: string,
  phoneLast4: string,
  env: AppEnv,
): Promise<LiffBindUrlParts> {
  const exp = Math.floor(Date.now() / 1000) + SIG_TTL_SECONDS;
  const sig = await hmacSha256(
    env.LIFF_BIND_HMAC_SECRET,
    `${orderId}:${phoneLast4}:${exp}`,
  );
  const liffId = env.LINE_LIFF_ID;
  const url = `https://liff.line.me/${liffId}?order=${encodeURIComponent(orderId)}&p=${phoneLast4}&exp=${exp}&sig=${sig}`;
  return { url, exp, sig };
}

export type SigVerifyResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyLiffBindSig(
  orderId: string,
  phoneLast4: string,
  exp: number,
  sig: string,
  env: AppEnv,
): Promise<SigVerifyResult> {
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: "invalid" };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };
  if (!/^\d{4}$/.test(phoneLast4)) return { ok: false, reason: "invalid" };
  const expected = await hmacSha256(
    env.LIFF_BIND_HMAC_SECRET,
    `${orderId}:${phoneLast4}:${exp}`,
  );
  return constantTimeEqual(sig, expected) ? { ok: true } : { ok: false, reason: "invalid" };
}

function monthBucketKey(now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `line_push_count:${yyyy}${mm}`;
}

function monthBucketTtlSeconds(now = new Date()): number {
  // Expire shortly after the next month begins (UTC). 35 days is generous.
  return 35 * 86400;
}

export async function getMonthlyPushCount(env: AppEnv): Promise<number> {
  const v = await env.RATELIMIT.get(monthBucketKey());
  return v ? parseInt(v, 10) || 0 : 0;
}

async function incrementMonthlyPushCount(env: AppEnv): Promise<number> {
  const key = monthBucketKey();
  const cur = await getMonthlyPushCount(env);
  const next = cur + 1;
  await env.RATELIMIT.put(key, String(next), {
    expirationTtl: monthBucketTtlSeconds(),
  });
  return next;
}

interface PushResult {
  ok: boolean;
  status?: number;
  error?: string;
  capped?: boolean;
}

export async function pushShippedNotification(
  env: AppEnv,
  db: Db,
  order: Order,
  origin: string,
): Promise<PushResult> {
  if (!order.line_user_id) return { ok: false, error: "no_line_user_id" };
  if (!env.LINE_OA_TOKEN) {
    await db.insert(audit_log).values({
      ts: new Date().toISOString(),
      user_email: "<system>",
      action: "line_push_misconfigured",
      order_id: order.order_id,
      details: JSON.stringify({ has_token: false }),
    });
    return { ok: false, error: "no_token" };
  }

  const monthCount = await getMonthlyPushCount(env);
  if (monthCount >= MONTHLY_PUSH_CAP) {
    await db.insert(audit_log).values({
      ts: new Date().toISOString(),
      user_email: "<system>",
      action: "line_push_capped",
      order_id: order.order_id,
      details: JSON.stringify({ count: monthCount, cap: MONTHLY_PUSH_CAP }),
    });
    return { ok: false, capped: true, error: "monthly_cap" };
  }

  const trackingLine = order.tracking_no
    ? `物流單號：${order.tracking_no}`
    : "物流單號：將在出貨後補登";
  const statusUrl = `${origin.replace(/\/$/, "")}/status?id=${order.order_id}`;
  const text = [
    `📦 您的訂單 ${order.order_id} 已出貨`,
    trackingLine,
    `查詢進度：${statusUrl}`,
    "",
    "感謝您支持小農，期待芒果收到時的笑容 🥭",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINE_PUSH_TIMEOUT_MS);
  let status = 0;
  let errMsg = "";
  try {
    const res = await fetch(LINE_PUSH_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LINE_OA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: order.line_user_id,
        messages: [{ type: "text", text }],
      }),
      signal: controller.signal,
    });
    status = res.status;
    if (!res.ok) {
      errMsg = await res.text().catch(() => "");
      throw new Error(`LINE push ${res.status}: ${errMsg}`);
    }
  } catch (err) {
    clearTimeout(timer);
    const action = status === 401 ? "line_token_invalid" : "line_push_failed";
    await db.insert(audit_log).values({
      ts: new Date().toISOString(),
      user_email: "<system>",
      action,
      order_id: order.order_id,
      details: JSON.stringify({
        status,
        error: err instanceof Error ? err.message : String(err),
        line_user_id: order.line_user_id,
      }),
    });
    return { ok: false, status, error: errMsg || (err instanceof Error ? err.message : String(err)) };
  }
  clearTimeout(timer);

  const newCount = await incrementMonthlyPushCount(env);
  const sentAt = new Date().toISOString();
  await db
    .update(orders)
    .set({ line_push_sent_at: sentAt })
    .where(eq(orders.order_id, order.order_id));
  await db.insert(audit_log).values({
    ts: sentAt,
    user_email: "<system>",
    action: "line_push_sent",
    order_id: order.order_id,
    details: JSON.stringify({
      monthly_count: newCount,
      threshold_alert: newCount >= MONTHLY_PUSH_ALERT_THRESHOLD,
    }),
  });

  return { ok: true, status };
}

export const LINE_CONSTANTS = {
  MONTHLY_PUSH_CAP,
  MONTHLY_PUSH_ALERT_THRESHOLD,
  SIG_TTL_SECONDS,
};
