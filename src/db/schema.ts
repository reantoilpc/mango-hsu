import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// Time convention:
// - All timestamp columns store UTC ISO-8601 with 'Z' suffix (e.g. "2026-04-26T14:38:27.123Z").
// - `order_id` uses Asia/Taipei calendar day for `M-YYYYMMDD-NNN` (preserves V1 behavior).

export const products = sqliteTable("products", {
  sku: text("sku").primaryKey(),
  name: text("name").notNull(),
  variant: text("variant").notNull(),
  price: integer("price").notNull(), // TWD, integer
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  display_order: integer("display_order").notNull().default(0),
});

export const admin_users = sqliteTable("admin_users", {
  email: text("email").primaryKey(),
  password_hash: text("password_hash").notNull(), // "pbkdf2$<iters>$<base64-salt>$<base64-hash>"
  role: text("role", { enum: ["admin", "operator"] }).notNull(),
  must_change_password: integer("must_change_password", { mode: "boolean" })
    .notNull()
    .default(true),
  created_at: text("created_at").notNull(),
});

export const orders = sqliteTable(
  "orders",
  {
    order_id: text("order_id").primaryKey(), // M-YYYYMMDD-NNN, YYYYMMDD = Asia/Taipei
    created_at: text("created_at").notNull(), // UTC ISO-8601 + Z
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    address: text("address").notNull(),
    notes: text("notes"),
    subtotal: integer("subtotal").notNull(),
    shipping: integer("shipping").notNull(),
    total: integer("total").notNull(),
    expected_memo: text("expected_memo").notNull(), // V1 compat: customer transfer memo
    pdpa_accepted: integer("pdpa_accepted", { mode: "boolean" }).notNull(),
    paid: integer("paid", { mode: "boolean" }).notNull().default(false),
    shipped: integer("shipped", { mode: "boolean" }).notNull().default(false),
    tracking_no: text("tracking_no"),
    paid_at: text("paid_at"), // UTC ISO + Z
    shipped_at: text("shipped_at"),
    paid_by: text("paid_by").references(() => admin_users.email),
    shipped_by: text("shipped_by").references(() => admin_users.email),
    idempotency_key: text("idempotency_key").notNull().unique(),
    line_user_id: text("line_user_id"),
    line_push_sent_at: text("line_push_sent_at"),
  },
  (t) => ({
    byCreated: index("orders_by_created").on(t.created_at),
    byPaidShipped: index("orders_by_paid_shipped").on(t.paid, t.shipped),
    byLineUserId: index("orders_by_line_user_id").on(t.line_user_id),
  }),
);

export const order_items = sqliteTable(
  "order_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    order_id: text("order_id")
      .notNull()
      .references(() => orders.order_id, { onDelete: "cascade" }),
    sku: text("sku")
      .notNull()
      .references(() => products.sku),
    qty: integer("qty").notNull(),
    unit_price: integer("unit_price").notNull(), // price snapshot at order time
  },
  (t) => ({
    byOrder: index("order_items_by_order").on(t.order_id),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    token: text("token").primaryKey(), // 32-byte hex
    user_email: text("user_email")
      .notNull()
      .references(() => admin_users.email, { onDelete: "cascade" }),
    expires_at: text("expires_at").notNull(), // UTC ISO + Z
  },
  (t) => ({
    byExpires: index("sessions_by_expires").on(t.expires_at), // for cron cleanup
  }),
);

// audit_log.user_email is INTENTIONALLY NOT a FK.
// Reason: when an admin retires and is deleted, audit history must remain
// for traceability. Decoupling this column from admin_users is a design choice.
//
// audit_log.order_id IS a FK with cascade delete, so the PDPA 6-month purge
// removes audit rows tied to deleted orders (including PII potentially in details).
export const audit_log = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(), // UTC ISO + Z
    user_email: text("user_email").notNull(), // intentionally NOT a FK
    action: text("action").notNull(), // mark_paid, mark_shipped, update_tracking, telegram_failed, login_success, login_fail, ...
    order_id: text("order_id").references(() => orders.order_id, { onDelete: "cascade" }),
    details: text("details"), // JSON blob, free-form
  },
  (t) => ({
    byOrder: index("audit_log_by_order").on(t.order_id),
    byTs: index("audit_log_by_ts").on(t.ts),
  }),
);

export type Product = typeof products.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof order_items.$inferSelect;
export type AdminUser = typeof admin_users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditLog = typeof audit_log.$inferSelect;
