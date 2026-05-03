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
