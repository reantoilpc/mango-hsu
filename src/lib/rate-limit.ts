import type { AppEnv } from "../db/client";

// KV-based throttle. 3 req per 60 seconds per IP for /api/orders POST.
// Eventual consistency leak is acceptable at this threshold.
const LIMIT = 3;
const WINDOW_SECONDS = 60;

export async function checkOrderRate(env: AppEnv, ip: string): Promise<boolean> {
  const key = `rl:order:${ip}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS });
  return true;
}

const LIFF_BIND_LIMIT = 10;
const LIFF_BIND_WINDOW_SECONDS = 60;

export async function checkLiffBindRate(env: AppEnv, ip: string): Promise<boolean> {
  const key = `rl:liff_bind:${ip}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= LIFF_BIND_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: LIFF_BIND_WINDOW_SECONDS,
  });
  return true;
}

// /admin/login throttle. Two-layer: per-IP catches single-source brute force;
// per-email catches cross-IP attempts on a specific account. 15-min window so
// a DoS-by-lockout against a known admin email recovers fast.
const LOGIN_IP_LIMIT = 5;
const LOGIN_IP_WINDOW_SECONDS = 15 * 60;

export async function checkLoginIpRate(env: AppEnv, ip: string): Promise<boolean> {
  const key = `rl:login_ip:${ip}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= LOGIN_IP_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: LOGIN_IP_WINDOW_SECONDS,
  });
  return true;
}

const LOGIN_EMAIL_LIMIT = 10;
const LOGIN_EMAIL_WINDOW_SECONDS = 15 * 60;

export async function checkLoginEmailRate(env: AppEnv, email: string): Promise<boolean> {
  const key = `rl:login_email:${email.toLowerCase()}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= LOGIN_EMAIL_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: LOGIN_EMAIL_WINDOW_SECONDS,
  });
  return true;
}

// /admin/forgot-password → request-reset throttle. 3 requests per hour per email.
// Per-email (not per-IP): the abuse vector is spamming a specific admin's Telegram with
// reset links; the email layer is the on-target control (spec §5.6). Limit-hit still returns
// the same generic 200 to the client (never 429 — that would leak email existence); the
// endpoint just skips sending and audits password_reset_failed{reason:rate_limited}.
const RESET_REQUEST_LIMIT = 3;
const RESET_REQUEST_WINDOW_SECONDS = 60 * 60;

export async function checkResetRequestRate(env: AppEnv, email: string): Promise<boolean> {
  const key = `rl:reset:${email.toLowerCase()}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= RESET_REQUEST_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: RESET_REQUEST_WINDOW_SECONDS,
  });
  return true;
}

const PUBLIC_STATUS_LIMIT = 30;
const PUBLIC_STATUS_WINDOW_SECONDS = 60 * 60;

export async function checkPublicStatusRate(env: AppEnv, ip: string): Promise<boolean> {
  const key = `rl:public_status:${ip}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= PUBLIC_STATUS_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: PUBLIC_STATUS_WINDOW_SECONDS,
  });
  return true;
}

// /api/admin/auth/reset-password (the verify step) throttle. 10 attempts per 15 min per IP.
// Secondary defense behind the per-code 5-attempt cap (reset_attempts): stops one IP from
// hammering the verify endpoint across accounts. On limit-hit the endpoint returns the SAME
// generic 400 as a bad code (never 429 — a distinct status would itself be a signal).
const RESET_VERIFY_LIMIT = 10;
const RESET_VERIFY_WINDOW_SECONDS = 15 * 60;

export async function checkResetVerifyRate(env: AppEnv, ip: string): Promise<boolean> {
  const key = `rl:reset_verify:${ip}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= RESET_VERIFY_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: RESET_VERIFY_WINDOW_SECONDS,
  });
  return true;
}
