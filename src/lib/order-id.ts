import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

// Returns YYYYMMDD in Asia/Taipei calendar day (UTC+8, no DST).
function taipeiDateStamp(now = new Date()): string {
  const taipei = new Date(now.getTime() + 8 * 3600_000);
  return taipei.toISOString().slice(0, 10).replace(/-/g, "");
}

// Computes next M-YYYYMMDD-NNN by counting same-day rows + 1.
// Race-prone: two concurrent inserts at the same Taipei second can compute the
// same N. The orders.order_id PRIMARY KEY UNIQUE catches it; caller should
// retry once on collision.
export async function nextOrderId(db: Db): Promise<string> {
  const yyyymmdd = taipeiDateStamp();
  const result = await db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM orders WHERE order_id LIKE ${`M-${yyyymmdd}-%`}`,
  );
  const n = (result[0]?.n ?? 0) + 1;
  return `M-${yyyymmdd}-${String(n).padStart(3, "0")}`;
}
