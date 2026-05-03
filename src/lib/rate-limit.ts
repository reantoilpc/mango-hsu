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
