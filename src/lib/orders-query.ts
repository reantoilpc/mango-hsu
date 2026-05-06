import { isNull } from "drizzle-orm";
import { orders } from "../db/schema";

// V4: predicate for "active" orders — not soft-deleted via cancel.
// Use this on every read of orders that should hide cancelled rows
// (dashboard, list, picking sheet, mark-shipped paths). Sites that
// MUST also see cancelled orders intentionally don't import this:
//   - admin/orders/[id] detail (cancelled orders still need to be
//     viewable for audit / customer questions)
//   - cron/purge.ts (PDPA cleanup must purge regardless of cancel state)
//   - lib/order-id.ts nextOrderId (cancelled orders still consume the
//     daily counter — no order_id reuse)
//
// Centralized so a future contributor can grep "activeOrdersFilter"
// to see every site that consciously chose to hide cancelled rows.
export const activeOrdersFilter = isNull(orders.cancelled_at);
