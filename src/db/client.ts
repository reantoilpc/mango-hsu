import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type AppEnv = {
  DB: D1Database;
  RATELIMIT: KVNamespace;
  // Vars
  PUBLIC_ORDER_TOKEN: string;
  BANK_ACCOUNT_DISPLAY: string;
  SHIPPING_FEE_TWD: string;
  FREE_SHIPPING_MIN_PACKAGES: string;
  ETA_DAYS_AFTER_PAYMENT: string;
  ACCEPTING_DRY: string;
  // Secrets (set via `wrangler secret put`)
  ORDER_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  LINE_OA_TOKEN: string;
  LINE_LIFF_ID: string;
  LINE_OA_ADD_FRIEND_URL: string;
  LIFF_BIND_HMAC_SECRET: string;
  // Static assets binding (Astro Cloudflare adapter)
  ASSETS: Fetcher;
};

export function makeDb(env: AppEnv) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof makeDb>;
