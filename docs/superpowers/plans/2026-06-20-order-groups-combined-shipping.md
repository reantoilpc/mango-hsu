# 併單 / Order Groups (Combined Shipping) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin starts a 併單 group (5-digit code + deadline ≤14 days, host name/phone/address, host's items); customers join at checkout with the code; the whole group ships to the host's one address with one tracking number and one shipping fee (combined weight, finalised at close), while each person's order stays separate so "whose goods" is clear.

**Architecture:** A new `order_groups` table; `orders` gains nullable `order_group_id` + `group_role`. Pure logic (code/deadline/group-shipping) lives in `src/lib/order-groups.ts` (unit-tested). Admin endpoints under `/api/admin/groups/**` reuse the existing order-create / gate-first-batch / bulk-ship patterns. A public `/api/groups/[code]` lookup powers the order-form UX. `/api/orders.ts` gains an optional `group_code` path that forces `shipping=0`, `address=host_address`, and stamps `order_group_id`+`group_role='member'`.

**Tech Stack:** Astro 6 SSR on Cloudflare Workers · D1 + Drizzle (`env.DB.batch`, `db.all<T>(sql\`...\`)`) · Tailwind v4 · `bun test` (pure units + stage HTTP integration).

## Global Constraints

- **Money/weight units:** integer TWD; `1 斤 = 100 fen`; weight via `totalFenOf(items)`; reuse `computeShipping(totalFen, config)` and `parseShippingConfig`.
- **Timestamps:** UTC ISO-8601 + `Z`, except `order_id` (`M-YYYYMMDD-NNN`, Asia/Taipei day via `nextOrderId(db)`).
- **Code:** 5-digit string `10000`–`99999` (`/^[1-9]\d{4}$/`); unique only among `status='open'` groups (partial unique index); reusable after close.
- **Deadline:** required, `deadline ≤ created_at + 14 days`, must be in the future (validated client + server).
- **Members ship `$0` (final); host bears one group fee computed at close** = `computeShipping(Σ non-cancelled group orders' fen, season config)`.
- **Admin-only:** all `/api/admin/groups/**` require `authorizeAdmin` AND `auth.session.role === "admin"` (operators get 403). `requireSameOrigin` on every mutation (the existing admin endpoints already call it inside `authorizeAdmin`'s usage; mirror the neighbours).
- **Orders column name:** `order_group_id` (NOT `group_id` — `products.group_id` already means product-group). FK → `order_groups.id`, nullable. `group_role` enum `'host' | 'member'`, nullable. Both set together or both NULL.
- **Migration:** hand-authored `drizzle/0009_order_groups.sql` (drizzle snapshot frozen at 0002; never run `db:generate`). Apply with `bunx wrangler d1 migrations apply <db> --remote`.
- **Test data prefixes:** SKUs `TEST-` (uppercase), names `test-`, season/group slugs `test-`. `cleanupTestData()` only deletes those.

---

### Task 1: Schema + migration (`order_groups` table, `orders` columns)

**Files:**
- Create: `drizzle/0009_order_groups.sql`
- Modify: `src/db/schema.ts` (add `order_groups` table; add 2 columns to `orders`; add type export)

**Interfaces:**
- Produces: Drizzle table `order_groups`; `orders.order_group_id` (int, nullable, FK), `orders.group_role` (text enum); `export type OrderGroup`.

- [ ] **Step 1: Write the migration file** — `drizzle/0009_order_groups.sql`:

```sql
-- Migration 0009: 併單 / order groups (combined shipping).
-- Additive only: new table + two nullable columns on orders + indexes. No table rebuild,
-- no data movement. Hand-authored (drizzle snapshot frozen at 0002, like 0003..0008).
-- Apply via: bunx wrangler d1 migrations apply <db> --remote
CREATE TABLE `order_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`code` text NOT NULL,
	`host_name` text NOT NULL,
	`host_address` text NOT NULL,
	`deadline` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`tracking_no` text,
	`shipped_at` text,
	`shipped_by` text,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_groups_open_code_unique` ON `order_groups` (`code`) WHERE `status` = 'open';
--> statement-breakpoint
CREATE INDEX `order_groups_by_status` ON `order_groups` (`status`);
--> statement-breakpoint
ALTER TABLE `orders` ADD `order_group_id` integer REFERENCES order_groups(id);
--> statement-breakpoint
ALTER TABLE `orders` ADD `group_role` text;
```

- [ ] **Step 2: Add the table + columns to `src/db/schema.ts`**

Add the two columns inside the `orders` table definition, immediately after the `cancelled_at` column (around line 132, before the closing `},` of the columns object):

```ts
    cancelled_at: text("cancelled_at"),
    // V7 併單: links a member/host order to its group. NULL = standalone order.
    // Named order_group_id (not group_id) to avoid clashing with products.group_id.
    order_group_id: integer("order_group_id").references((): any => order_groups.id),
    group_role: text("group_role", { enum: ["host", "member"] }),
```

Add the new table after the `order_items` table definition (after its closing `);`):

```ts
// V7 併單 / combined shipping. A group binds several orders (one host + members)
// for one shipment. code is unique only among status='open' groups (partial index).
export const order_groups = sqliteTable(
  "order_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season_id: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    code: text("code").notNull(), // 5-digit string, 10000–99999
    host_name: text("host_name").notNull(),
    host_address: text("host_address").notNull(),
    deadline: text("deadline").notNull(), // UTC ISO + Z
    status: text("status", { enum: ["open", "closed", "shipped", "cancelled"] })
      .notNull()
      .default("open"),
    created_by: text("created_by").notNull(), // admin email; NOT a FK (mirrors audit_log)
    created_at: text("created_at").notNull(),
    tracking_no: text("tracking_no"),
    shipped_at: text("shipped_at"),
    shipped_by: text("shipped_by"),
  },
  (t) => ({
    uqOpenCode: uniqueIndex("order_groups_open_code_unique")
      .on(t.code)
      .where(sql`${t.status} = 'open'`),
    byStatus: index("order_groups_by_status").on(t.status),
  }),
);
```

Add the type export near the other `$inferSelect` exports at the bottom:

```ts
export type OrderGroup = typeof order_groups.$inferSelect;
```

- [ ] **Step 3: Verify build/typecheck**

Run: `bun run build`
Expected: PASS — no TS errors. (Drizzle forward-reference `order_group_id → order_groups.id` resolves via the thunk; `order_groups` is defined after `orders` but the `(): any =>` thunk defers evaluation.)

- [ ] **Step 4: Commit**

```bash
git add drizzle/0009_order_groups.sql src/db/schema.ts
git commit -m "feat(groups): schema + migration for 併單 order_groups"
```

---

### Task 2: Pure helpers `order-groups.ts` + unit tests (TDD)

**Files:**
- Create: `src/lib/order-groups.ts`
- Test: `tests/order-groups.test.ts`

**Interfaces:**
- Consumes: `computeShipping`, `totalFenOf`, `ShippingConfig` from `./shipping`.
- Produces:
  - `MAX_GROUP_DAYS = 14`
  - `generateGroupCode(rand?: () => number): string`
  - `isValidGroupCode(s: string): boolean`
  - `validateDeadline(deadlineIso: string, createdIso: string): { ok: true } | { ok: false; reason: string }`
  - `type GroupOrderWeights = { items: Array<{ package_fen: number; qty: number }>; cancelled?: boolean }`
  - `computeGroupShipping(orders: GroupOrderWeights[], config: ShippingConfig): number`

- [ ] **Step 1: Write the failing test** — `tests/order-groups.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  generateGroupCode,
  isValidGroupCode,
  validateDeadline,
  computeGroupShipping,
} from "../src/lib/order-groups";
import type { ShippingConfig } from "../src/lib/shipping";

describe("group code", () => {
  it("generates a 5-digit code in 10000–99999", () => {
    expect(generateGroupCode(() => 0)).toBe("10000");
    expect(generateGroupCode(() => 0.999999)).toBe("99999");
    const c = generateGroupCode();
    expect(c).toMatch(/^[1-9]\d{4}$/);
  });
  it("validates code format", () => {
    expect(isValidGroupCode("10000")).toBe(true);
    expect(isValidGroupCode("99999")).toBe(true);
    expect(isValidGroupCode("01234")).toBe(false); // leading zero
    expect(isValidGroupCode("1234")).toBe(false); // 4 digits
    expect(isValidGroupCode("123456")).toBe(false);
    expect(isValidGroupCode("1a234")).toBe(false);
  });
});

describe("validateDeadline", () => {
  const created = "2026-06-20T00:00:00.000Z";
  it("accepts a future deadline within 14 days", () => {
    expect(validateDeadline("2026-06-27T00:00:00.000Z", created).ok).toBe(true);
    expect(validateDeadline("2026-07-04T00:00:00.000Z", created).ok).toBe(true); // exactly +14d
  });
  it("rejects past / non-future", () => {
    expect(validateDeadline("2026-06-19T00:00:00.000Z", created).ok).toBe(false);
    expect(validateDeadline(created, created).ok).toBe(false);
  });
  it("rejects > 14 days", () => {
    expect(validateDeadline("2026-07-04T00:00:01.000Z", created).ok).toBe(false);
  });
  it("rejects unparseable", () => {
    expect(validateDeadline("not-a-date", created).ok).toBe(false);
  });
});

describe("computeGroupShipping", () => {
  const flat: ShippingConfig = { type: "flat", fee_twd: 150 };
  const threshold: ShippingConfig = { type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 };
  const orders = [
    { items: [{ package_fen: 100, qty: 2 }] }, // 200 fen
    { items: [{ package_fen: 100, qty: 1 }] }, // 100 fen
  ];
  it("flat: one fee regardless of weight", () => {
    expect(computeGroupShipping(orders, flat)).toBe(150);
  });
  it("threshold: under → fee, over → 0", () => {
    expect(computeGroupShipping(orders, threshold)).toBe(150); // 300 < 1000
    const big = [{ items: [{ package_fen: 100, qty: 12 }] }]; // 1200 ≥ 1000
    expect(computeGroupShipping(big, threshold)).toBe(0);
  });
  it("excludes cancelled orders from the combined weight", () => {
    const withCancel = [
      { items: [{ package_fen: 100, qty: 12 }], cancelled: true }, // ignored
      { items: [{ package_fen: 100, qty: 1 }] }, // 100 fen
    ];
    expect(computeGroupShipping(withCancel, threshold)).toBe(150); // only 100 fen counts
  });
  it("empty → 0", () => {
    expect(computeGroupShipping([], flat)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/order-groups.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/order-groups'`.

- [ ] **Step 3: Write `src/lib/order-groups.ts`**

```ts
// V7 併單 / order-groups pure logic. No env / DB — unit-testable.
// 1 斤 = 100 fen; money is integer TWD. Mirrors the split in admin-dashboard.ts /
// sales-summary.ts: pure helpers here, DB glue in the endpoints.
import { computeShipping, totalFenOf, type ShippingConfig } from "./shipping";

export type GroupStatus = "open" | "closed" | "shipped" | "cancelled";

// Deadline cap: a group can run at most this many days from creation.
export const MAX_GROUP_DAYS = 14;

// 5-digit code in 10000–99999 (always 5 chars, no leading-zero ambiguity).
// rand is injectable for deterministic tests; defaults to Math.random.
export function generateGroupCode(rand: () => number = Math.random): string {
  return String(10000 + Math.floor(rand() * 90000));
}

export function isValidGroupCode(s: string): boolean {
  return /^[1-9]\d{4}$/.test(s);
}

export function validateDeadline(
  deadlineIso: string,
  createdIso: string,
): { ok: true } | { ok: false; reason: string } {
  const d = Date.parse(deadlineIso);
  const c = Date.parse(createdIso);
  if (Number.isNaN(d) || Number.isNaN(c)) return { ok: false, reason: "bad deadline" };
  if (d <= c) return { ok: false, reason: "deadline must be in the future" };
  const maxMs = MAX_GROUP_DAYS * 24 * 3600 * 1000;
  if (d - c > maxMs) return { ok: false, reason: `deadline exceeds ${MAX_GROUP_DAYS} days` };
  return { ok: true };
}

export interface GroupOrderWeights {
  items: Array<{ package_fen: number; qty: number }>;
  cancelled?: boolean;
}

// The single fee the host bears: shipping computed over the COMBINED weight of all
// non-cancelled group orders, using the season's shipping config.
export function computeGroupShipping(
  orders: GroupOrderWeights[],
  config: ShippingConfig,
): number {
  let fen = 0;
  for (const o of orders) {
    if (o.cancelled) continue;
    fen += totalFenOf(o.items);
  }
  return computeShipping(fen, config);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/order-groups.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/order-groups.ts tests/order-groups.test.ts
git commit -m "feat(groups): pure code/deadline/group-shipping helpers + tests"
```

---

### Task 3: Apply migration to stage + admin create-group API

**Files:**
- Create: `src/pages/api/admin/groups/create.ts`
- Test: `tests/order-groups-d1.test.ts` (start it here; extended in Task 9)

**Interfaces:**
- Consumes: `authorizeAdmin`, `json`, `text` (`src/lib/admin-api.ts`); `validateAdminOrder` (`src/lib/order-validate.ts`); `resolveItemsForStock`, `tryDecrementGroupStock`, `restoreGroupStock`, `getGroupStockFen`, `stockAuditStmts` (`src/lib/stock.ts`); `nextOrderId` (`src/lib/order-id.ts`); `expectedMemoFor` (`src/lib/order-response.ts`); `isUniqueOnOrderId`, `isUniqueOnIdempotency` (`src/lib/order-errors.ts`); `generateGroupCode`, `validateDeadline` (`src/lib/order-groups.ts`); `env` (`src/lib/env.ts`).
- Produces: `POST /api/admin/groups/create` → `{ ok: true, group_id, code, host_order_id }` or `{ ok: false, error_code }`.

- [ ] **Step 1: Apply the migration to STAGE (required before the endpoint can be tested)**

Run: `bunx wrangler d1 migrations apply mango-hsu-stage --env stage --remote`
Expected: applies `0009_order_groups.sql`; `order_groups` table + `orders.order_group_id`/`group_role` exist on stage.
Verify: `bunx wrangler d1 execute mango-hsu-stage --env stage --remote --command "SELECT name FROM d1_migrations ORDER BY id;"` includes `0009_order_groups.sql`.

- [ ] **Step 2: Write the create endpoint** — `src/pages/api/admin/groups/create.ts`:

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { orders, order_items, order_groups, seasons } from "../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { validateAdminOrder } from "../../../../lib/order-validate";
import { generateGroupCode, validateDeadline } from "../../../../lib/order-groups";
import {
  resolveItemsForStock,
  tryDecrementGroupStock,
  restoreGroupStock,
  getGroupStockFen,
  stockAuditStmts,
} from "../../../../lib/stock";
import { nextOrderId } from "../../../../lib/order-id";
import { expectedMemoFor } from "../../../../lib/order-response";
import { isUniqueOnOrderId } from "../../../../lib/order-errors";
import { env } from "../../../../lib/env";

interface CreateGroupBody {
  idempotency_key: string;
  host_name: string;
  host_phone: string;
  host_address: string;
  deadline: string; // UTC ISO+Z (client converts the picked Taipei date to end-of-day UTC)
  items: Array<{ sku: string; qty: number }>;
  notes?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);
  if (auth.session.role !== "admin") return text("admin only", 403);

  let body: CreateGroupBody;
  try {
    body = (await request.json()) as CreateGroupBody;
  } catch {
    return text("bad json", 400);
  }
  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return json({ ok: false, error_code: "INVALID_INPUT" }, 400);
  }

  // Reuse the admin-order validator for host name/phone/address/items.
  const invalid = validateAdminOrder({
    name: body.host_name,
    phone: body.host_phone,
    address: body.host_address,
    items: body.items,
  });
  if (invalid) return json(invalid, 400);

  const createdAt = new Date().toISOString();
  const dl = validateDeadline(body.deadline, createdAt);
  if (!dl.ok) return json({ ok: false, error_code: "BAD_DEADLINE", reason: dl.reason }, 400);

  const db = makeDb(env);

  // Idempotency replay: the host order's idempotency_key uniquely identifies this group.
  const prior = await db
    .select()
    .from(orders)
    .where(eq(orders.idempotency_key, body.idempotency_key))
    .limit(1);
  if (prior.length > 0 && prior[0]!.order_group_id) {
    const g = await db
      .select()
      .from(order_groups)
      .where(eq(order_groups.id, prior[0]!.order_group_id))
      .limit(1);
    return json({ ok: true, group_id: prior[0]!.order_group_id, code: g[0]?.code ?? "", host_order_id: prior[0]!.order_id });
  }

  // Resolve items against the active season.
  const resolved = await resolveItemsForStock(env, body.items);
  if (!resolved.ok) {
    return json({ ok: false, error_code: resolved.error_code, sku: resolved.sku }, 400);
  }
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;
  if (!seasonId) return json({ ok: false, error_code: "SEASON_CLOSED" }, 400);

  let subtotal = 0;
  for (const r of resolved.resolved) subtotal += r.price * r.qty;
  // Host shipping is provisional (0) until the group closes; finalised in close.ts.
  const shipping = 0;
  const total = subtotal + shipping;

  // Reserve stock once for the host's items.
  const beforeFenMap = await getGroupStockFen(env, resolved.group_decrements.map((d) => d.group_id));
  const reserve = await tryDecrementGroupStock(env, resolved.group_decrements);
  if (!reserve.ok) return json({ ok: false, error_code: "SOLD_OUT", sold_out_group_id: reserve.sold_out_group_id }, 409);

  // Insert the group row with a non-colliding open code (partial-unique retry, max 5).
  let groupId: number | null = null;
  let code = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateGroupCode();
    try {
      const res = await env.DB.prepare(
        `INSERT INTO order_groups (season_id, code, host_name, host_address, deadline, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
        .bind(seasonId, code, body.host_name, body.host_address, body.deadline, auth.session.email, createdAt)
        .run();
      groupId = res.meta.last_row_id as number;
      break;
    } catch (err) {
      if (/UNIQUE/i.test(String(err)) && attempt < 4) continue; // code collision, retry
      await restoreGroupStock(env, resolved.group_decrements);
      return json({ ok: false, error_code: "INTERNAL" }, 500);
    }
  }
  if (groupId === null) {
    await restoreGroupStock(env, resolved.group_decrements);
    return json({ ok: false, error_code: "INTERNAL" }, 500);
  }

  // Insert the host order (group_role='host') with order_id retry. Compensate on hard failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderId = await nextOrderId(db);
    const expectedMemo = expectedMemoFor(orderId, body.host_name);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO orders (order_id, season_id, created_at, name, phone, address, notes, subtotal, shipping, total, expected_memo, pdpa_accepted, paid, shipped, idempotency_key, order_group_id, group_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 'host')`,
        ).bind(
          orderId, seasonId, createdAt, body.host_name, body.host_phone, body.host_address,
          body.notes || null, subtotal, shipping, total, expectedMemo, body.idempotency_key, groupId,
        ),
        ...resolved.resolved.map((r) =>
          env.DB.prepare(
            `INSERT INTO order_items (order_id, product_id, sku, qty, unit_price) VALUES (?, ?, ?, ?, ?)`,
          ).bind(orderId, r.product_id, r.sku, r.qty, r.price),
        ),
        ...stockAuditStmts(
          env,
          resolved.group_decrements.map((d) => {
            const before = beforeFenMap.get(d.group_id) ?? 0;
            return { group_id: d.group_id, delta_fen: -d.fen, before_fen: before, after_fen: before - d.fen, reason: "order_decrement" as const, source_id: orderId, season_id: seasonId ?? undefined, ts: createdAt };
          }),
        ),
        env.DB.prepare(
          `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, 'group_created', ?, ?, ?)`,
        ).bind(createdAt, auth.session.email, orderId, seasonId, JSON.stringify({ group_id: groupId, code, deadline: body.deadline })),
      ]);
      return json({ ok: true, group_id: groupId, code, host_order_id: orderId });
    } catch (err) {
      if (isUniqueOnOrderId(err) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      // Hard failure: restore stock + delete the orphan group row.
      await restoreGroupStock(env, resolved.group_decrements);
      await env.DB.prepare(`DELETE FROM order_groups WHERE id = ?`).bind(groupId).run();
      return json({ ok: false, error_code: "INTERNAL" }, 500);
    }
  }
  await restoreGroupStock(env, resolved.group_decrements);
  await env.DB.prepare(`DELETE FROM order_groups WHERE id = ?`).bind(groupId).run();
  return json({ ok: false, error_code: "LOCKED" }, 409);
};
```

> Note: the host order is inserted with `paid=1` so the group's "collected money" reflects the host having pre-committed (the host pays you directly); members default `paid=0`. If you prefer host `paid=0`, change the literal in the INSERT — but `paid=1` keeps the close/ship `paid=1` gate from blocking the host.

- [ ] **Step 3: Write a smoke integration test** — `tests/order-groups-d1.test.ts` (first case; full lifecycle added in Task 9):

```ts
import { afterAll, describe, expect, it } from "bun:test";
import {
  STAGE_URL, createTestAdminSession, cleanupTestData, cleanupTestAdmin,
  seedActiveSeasonScenario, skipIfNoIntegration, d1Execute, TEST_SKU_PREFIX,
} from "./_setup";

describe("order-groups create (stage)", () => {
  if (skipIfNoIntegration()) { it.skip("needs MANGO_STAGE_URL + TEST_TOKEN", () => {}); return; }
  afterAll(() => { cleanupTestData(); cleanupTestAdmin(); });

  it("admin creates a group + host order with a 5-digit code", async () => {
    const { } = seedActiveSeasonScenario({
      season_code: "test-grp", group_slug: "test-grp-jh", initial_stock_fen: 100000,
      skus: [{ sku: `${TEST_SKU_PREFIX}GRP-1`, package_fen: 100, price: 600 }],
    });
    const cookie = createTestAdminSession();
    const deadline = new Date(Date.now() + 5 * 86400_000).toISOString();
    const res = await fetch(`${STAGE_URL}/api/admin/groups/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: STAGE_URL },
      body: JSON.stringify({
        idempotency_key: `test-grp-${crypto.randomUUID()}`,
        host_name: "test-host", host_phone: "0912345678", host_address: "台北市測試路1號",
        deadline, items: [{ sku: `${TEST_SKU_PREFIX}GRP-1`, qty: 2 }],
      }),
    });
    const data = (await res.json()) as { ok: boolean; code?: string; group_id?: number };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.code).toMatch(/^[1-9]\d{4}$/);
    const rows = d1Execute(`SELECT status, code FROM order_groups WHERE id = ${data.group_id}`) as Array<{ status: string }>;
    expect(rows[0]!.status).toBe("open");
  });
});
```

- [ ] **Step 4: Run the integration test**

Run: `MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev TEST_TOKEN=<stage ORDER_TOKEN> bun test tests/order-groups-d1.test.ts --timeout 90000`
Expected: PASS (1 test). (Per memory: integration tests need `--timeout 90000`. `wrangler login` must be done.)

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/admin/groups/create.ts tests/order-groups-d1.test.ts
git commit -m "feat(groups): admin create-group API (host order + 5-digit code)"
```

---

### Task 4: Admin create-group page + nav entry

**Files:**
- Create: `src/pages/admin/groups/new.astro`
- Modify: `src/lib/admin-nav.ts` (add 併單 entry)
- Test: `tests/admin-nav.test.ts` (extend)

**Interfaces:**
- Consumes: `POST /api/admin/groups/create` (Task 3); active-season products (same query as `src/pages/admin/orders/new.astro`).

- [ ] **Step 1: Add the nav entry test (failing)** — in `tests/admin-nav.test.ts`, update the two key-order assertions to include `"order-groups"` right after `"orders"`, and add:

```ts
  it("includes a 併單 entry pointing at /admin/groups", () => {
    const g = ADMIN_NAV_ITEMS.find((i) => i.key === "order-groups");
    expect(g?.href).toBe("/admin/groups");
    expect(g?.label).toBe("併單");
    expect(g?.operatorVisible).toBe(false);
  });
```
(Update `exposes the nav items in declared order…`, `admin role sees every item`, and `operator role…` arrays: insert `"order-groups"` after `"orders"` in the admin/full lists; it is NOT in the operator list.)

- [ ] **Step 2: Run → fails**

Run: `bun test tests/admin-nav.test.ts`
Expected: FAIL (no `order-groups` item yet).

- [ ] **Step 3: Add the nav item** — in `src/lib/admin-nav.ts`, insert after the `orders` item:

```ts
  { key: "order-groups", label: "併單", href: "/admin/groups", operatorVisible: false },
```

- [ ] **Step 4: Run → passes**

Run: `bun test tests/admin-nav.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `src/pages/admin/groups/new.astro`**

Frontmatter: gate to admin, load active-season products (copy the product-loading query from `src/pages/admin/orders/new.astro`). Template: a form modeled on `orders/new.astro` with these fields — host name (`id="host_name"`), host phone (`id="host_phone"`, pattern `0[0-9 -]{7,13}`), host address (`id="host_address"` textarea), deadline (`id="deadline"` `<input type="date">`, with `min`=tomorrow and `max`=+14 days computed in frontmatter), the same item-qty grid (`.item-qty` with `data-sku`), notes, and `id="submit-btn"`. Client JS (module script) mirrors `orders/new.astro`'s submit, with these differences:

```ts
// compute max/min deadline (Taipei date) and set on the input — done in frontmatter:
//   const todayTaipei = ...; max = +14 days. Set min/max attributes server-side.
const form = document.getElementById("group-form") as HTMLFormElement;
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submit-btn") as HTMLButtonElement;
  btn.disabled = true;
  const items = Array.from(document.querySelectorAll<HTMLInputElement>(".item-qty"))
    .map((el) => ({ sku: el.dataset.sku!, qty: Number(el.value) || 0 }))
    .filter((i) => i.qty > 0);
  const dateStr = (document.getElementById("deadline") as HTMLInputElement).value; // "YYYY-MM-DD" (Taipei)
  // End-of-day Taipei → UTC ISO. Taipei is UTC+8, so 23:59:59.999+08:00.
  const deadline = new Date(`${dateStr}T23:59:59.999+08:00`).toISOString();
  const body = {
    idempotency_key: crypto.randomUUID(),
    host_name: (document.getElementById("host_name") as HTMLInputElement).value.trim(),
    host_phone: (document.getElementById("host_phone") as HTMLInputElement).value.trim(),
    host_address: (document.getElementById("host_address") as HTMLTextAreaElement).value.trim(),
    deadline,
    items,
    notes: (document.getElementById("notes") as HTMLTextAreaElement).value.trim() || undefined,
  };
  const res = await fetch("/api/admin/groups/create", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  const errEl = document.getElementById("form-error")!;
  if (res.ok && data.ok) {
    location.href = `/admin/groups/${data.group_id}`;
  } else {
    errEl.textContent = data.reason ? `${data.error_code}: ${data.reason}` : (data.error_code ?? "建立失敗");
    errEl.classList.remove("hidden");
    btn.disabled = false;
  }
});
```

- [ ] **Step 6: Build**

Run: `bun run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/admin/groups/new.astro src/lib/admin-nav.ts tests/admin-nav.test.ts
git commit -m "feat(groups): admin create-group page + 併單 nav entry"
```

---

### Task 5: Public lookup API + customer join in `/api/orders`

**Files:**
- Create: `src/pages/api/groups/[code].ts`
- Modify: `src/pages/api/orders.ts` (optional `group_code` path)
- Test: `tests/order-groups-d1.test.ts` (add member-join cases)

**Interfaces:**
- Consumes: `isValidGroupCode` (Task 2); `checkPublicStatusRate` (`src/lib/rate-limit.ts`); existing `/api/orders` pipeline.
- Produces: `GET /api/groups/[code]` → `{ ok: true, host_name, deadline } | { ok: false }`; `/api/orders` honours `group_code`.

- [ ] **Step 1: Write the lookup endpoint** — `src/pages/api/groups/[code].ts`:

```ts
import type { APIRoute } from "astro";
import { makeDb } from "../../../db/client";
import { order_groups } from "../../../db/schema";
import { and, eq, gt } from "drizzle-orm";
import { isValidGroupCode } from "../../../lib/order-groups";
import { checkPublicStatusRate } from "../../../lib/rate-limit";
import { env } from "../../../lib/env";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkPublicStatusRate(env, ip))) return json({ ok: false }, 429);
  const code = params.code ?? "";
  if (!isValidGroupCode(code)) return json({ ok: false });
  const db = makeDb(env);
  const now = new Date().toISOString();
  const rows = await db
    .select({ host_name: order_groups.host_name, deadline: order_groups.deadline })
    .from(order_groups)
    .where(and(eq(order_groups.code, code), eq(order_groups.status, "open"), gt(order_groups.deadline, now)))
    .limit(1);
  if (rows.length === 0) return json({ ok: false });
  return json({ ok: true, host_name: rows[0]!.host_name, deadline: rows[0]!.deadline });
};
```

- [ ] **Step 2: Extend `/api/orders.ts` for `group_code`**

In `src/pages/api/orders.ts`: add `group_code?: string` to the `OrderRequest` interface. Then, after the idempotency replay block and BEFORE `validateCustomerOrder(body)` (the validator must see the host address), insert group resolution. Concretely, move `const db = makeDb(env);` up to just after the idempotency-key presence check, then add:

```ts
// 併單: if a group_code is supplied, resolve the open group and force member fields.
let groupCtx: { group_id: number; host_address: string } | null = null;
if (typeof body.group_code === "string" && body.group_code.trim() !== "") {
  const code = body.group_code.trim();
  if (!isValidGroupCode(code)) return json({ ok: false, error_code: "GROUP_INVALID" });
  const nowIso = new Date().toISOString();
  const g = await db
    .select({ id: order_groups.id, host_address: order_groups.host_address })
    .from(order_groups)
    .where(and(eq(order_groups.code, code), eq(order_groups.status, "open"), gt(order_groups.deadline, nowIso)))
    .limit(1);
  if (g.length === 0) return json({ ok: false, error_code: "GROUP_INVALID" });
  groupCtx = { group_id: g[0]!.id, host_address: g[0]!.host_address };
  body.address = g[0]!.host_address; // server-authoritative; client's address is ignored
}
```

Add imports at the top: `import { order_groups } from "../../db/schema";` (extend the existing schema import line) and `import { and, gt } from "drizzle-orm";` (extend the existing drizzle import), `import { isValidGroupCode } from "../../lib/order-groups";`.

Then change the shipping computation so members are free, and stamp the order. Replace the shipping line:

```ts
const shipping = groupCtx ? 0 : shippingFor(resolved.resolved, shippingConfig);
```

In the `INSERT INTO orders (...)` statement, add the two new columns + binds. Change the column list to end with `..., idempotency_key, order_group_id, group_role)` and `VALUES (..., ?, ?, ?)`, and add to the `.bind(...)` after `body.idempotency_key`:

```ts
        body.idempotency_key,
        groupCtx ? groupCtx.group_id : null,
        groupCtx ? "member" : null,
```

(The `paid=0, shipped=0` literals stay. Members keep their own `name`/`phone`; `address` is the host's.)

- [ ] **Step 3: Add member-join cases to `tests/order-groups-d1.test.ts`**

```ts
  it("a customer joins via code: shipping 0, address = host", async () => {
    // (reuse the group created above, or create a fresh one in this test)
    // 1. create group → get code (as in the first test)
    // 2. POST /api/orders with { group_code: code, items, name: 'test-member', ... }
    //    headers: X-Test-Mode: 1 to bypass rate limit; token = TEST_TOKEN
    // 3. assert response ok, and D1 row has order_group_id set, group_role='member',
    //    shipping=0, address = host address.
    // 4. POST /api/orders with an invalid code '99999' (no open group) → error_code GROUP_INVALID.
  });
```
Fill this in concretely following the `stageFetch` + `clearOrderRateLimit` helpers (see `tests/stock-d1.test.ts` for the order-post pattern). Assert via `d1Execute(\`SELECT shipping, group_role, address FROM orders WHERE name='test-member...'\`)`.

- [ ] **Step 4: Run integration tests**

Run: `MANGO_STAGE_URL=... TEST_TOKEN=... bun test tests/order-groups-d1.test.ts --timeout 90000`
Expected: PASS (create + member-join + invalid-code).

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/groups/[code].ts src/pages/api/orders.ts tests/order-groups-d1.test.ts
git commit -m "feat(groups): public code lookup + customer join (member shipping \$0)"
```

---

### Task 6: Customer order-form UI (併單代碼 input)

**Files:**
- Modify: `src/pages/order.astro`

**Interfaces:**
- Consumes: `GET /api/groups/[code]` (Task 5); existing `submitOrder` (`src/lib/api.ts`).

- [ ] **Step 1: Add the code input to the form**

In `src/pages/order.astro`, insert immediately after the address block (after line ~111, the `id="address"` field's container):

```astro
  <div class="space-y-1">
    <label for="group-code" class="block text-sm font-medium">併單代碼（選填，5 位數字）</label>
    <input id="group-code" name="group_code" inputmode="numeric" maxlength="5"
           autocomplete="off" placeholder="例如 48217"
           class="w-full rounded border border-gray-300 px-3 py-2" />
    <p id="group-status" class="hidden text-sm"></p>
  </div>
```

- [ ] **Step 2: Add the lookup + address-hide JS**

In the order-form module script (where the other DOM logic lives, near the submit handler), add:

```ts
const groupCodeEl = document.getElementById("group-code") as HTMLInputElement;
const groupStatusEl = document.getElementById("group-status")!;
const addressWrap = (document.getElementById("address") as HTMLElement).closest("div")!;
let groupOk = false;

async function refreshGroup() {
  const code = groupCodeEl.value.trim();
  groupOk = false;
  if (!/^[1-9]\d{4}$/.test(code)) {
    groupStatusEl.classList.add("hidden");
    addressWrap.classList.remove("hidden");
    return;
  }
  try {
    const res = await fetch(`/api/groups/${code}`);
    const data = await res.json();
    if (data.ok) {
      groupOk = true;
      const dl = new Date(data.deadline);
      const d = `${dl.getMonth() + 1}/${dl.getDate()}`;
      groupStatusEl.textContent = `✓ 併單：${data.host_name}（截止 ${d}）· 運費 $0，寄送至團主`;
      groupStatusEl.className = "text-sm text-emerald-700";
      addressWrap.classList.add("hidden"); // ships to host; address not needed
    } else {
      groupStatusEl.textContent = "併單代碼無效或已截止";
      groupStatusEl.className = "text-sm text-red-600";
      addressWrap.classList.remove("hidden");
    }
  } catch {
    groupStatusEl.className = "text-sm text-red-600";
    groupStatusEl.textContent = "查詢失敗，請重試";
  }
}
groupCodeEl.addEventListener("input", () => { /* debounce */ clearTimeout((window as any)._gt); (window as any)._gt = setTimeout(refreshGroup, 350); });
```

- [ ] **Step 3: Include `group_code` in the submit body + skip address requirement when grouped**

In the existing submit handler, where `submitOrder({...})` is called (line ~475), add `group_code` to the body and, when `groupOk`, send a placeholder address so the client-side required check passes (server overrides it with the host address anyway):

```ts
const code = groupCodeEl.value.trim();
const grouped = groupOk && /^[1-9]\d{4}$/.test(code);
const res = await submitOrder({
  /* ...existing fields... */
  address: grouped ? "（併單寄送至團主）" : addressValue,
  group_code: grouped ? code : undefined,
});
```
Also relax the client-side address-required guard: skip the "address ≥ 5 chars" check when `grouped` is true. (The server sets the real address from the group.)

- [ ] **Step 4: Build + manual smoke**

Run: `bun run build`
Expected: PASS. (Visual verification happens on stage in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add src/pages/order.astro
git commit -m "feat(groups): 併單代碼 input on the order form (lookup, hide address, \$0)"
```

---

### Task 7: Admin close / ship / cancel APIs

**Files:**
- Create: `src/pages/api/admin/groups/[id]/close.ts`
- Create: `src/pages/api/admin/groups/[id]/ship.ts`
- Create: `src/pages/api/admin/groups/[id]/cancel.ts`

**Interfaces:**
- Consumes: `authorizeAdmin`, `json`, `text`; `parseShippingConfig`, `computeGroupShipping`; `restoreGroupStock`, `getGroupStockFen`, `stockAuditStmts`; `env`.
- Produces: three `POST` endpoints transitioning a group through its lifecycle.

- [ ] **Step 1: Write `close.ts`** (finalise host shipping on combined weight; open → closed)

```ts
import type { APIRoute } from "astro";
import { and, eq, isNull } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_items, order_groups, products, seasons } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { parseShippingConfig } from "../../../../../lib/shipping";
import { computeGroupShipping } from "../../../../../lib/order-groups";
import { env } from "../../../../../lib/env";

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);
  if (auth.session.role !== "admin") return text("admin only", 403);
  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) return text("bad id", 400);

  const db = makeDb(env);
  const g = (await db.select().from(order_groups).where(eq(order_groups.id, groupId)).limit(1))[0];
  if (!g) return text("not found", 404);
  if (g.status !== "open") return json({ ok: false, error_code: "BAD_STATE", status: g.status }, 409);

  // Combined weight of all non-cancelled group orders.
  const groupOrders = await db
    .select({ order_id: orders.order_id, group_role: orders.group_role })
    .from(orders)
    .where(and(eq(orders.order_group_id, groupId), isNull(orders.cancelled_at)));
  const orderIds = groupOrders.map((o) => o.order_id);
  const items = orderIds.length
    ? await db.select({ order_id: order_items.order_id, qty: order_items.qty, package_fen: products.package_fen })
        .from(order_items).innerJoin(products, eq(order_items.product_id, products.id))
        .where(/* in(order_items.order_id, orderIds) */ eq(order_items.order_id, orderIds[0]!)) // see note
    : [];
  // NOTE: use drizzle inArray(order_items.order_id, orderIds) — single statement; the eq above
  // is only a placeholder to keep this snippet compilable for a 1-order group. Import inArray.
  const weights = groupOrders.map((o) => ({
    items: items.filter((it) => it.order_id === o.order_id).map((it) => ({ package_fen: it.package_fen, qty: it.qty })),
  }));

  const seasonCfg = (await db.select({ shipping_config: seasons.shipping_config }).from(seasons).where(eq(seasons.id, g.season_id)).limit(1))[0];
  const config = parseShippingConfig(seasonCfg?.shipping_config ?? null);
  const groupShipping = computeGroupShipping(weights, config);

  const host = groupOrders.find((o) => o.group_role === "host");
  const now = new Date().toISOString();
  await env.DB.batch([
    ...(host
      ? [env.DB.prepare(`UPDATE orders SET shipping = ?, total = subtotal + ? WHERE order_id = ?`).bind(groupShipping, groupShipping, host.order_id)]
      : []),
    env.DB.prepare(`UPDATE order_groups SET status = 'closed' WHERE id = ? AND status = 'open'`).bind(groupId),
    env.DB.prepare(`INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'group_closed', ?, ?)`)
      .bind(now, auth.session.email, g.season_id, JSON.stringify({ group_id: groupId, group_shipping: groupShipping })),
  ]);
  return json({ ok: true, group_shipping: groupShipping });
};
```
> Implementation note for the engineer: replace the placeholder `eq(order_items.order_id, orderIds[0]!)` with `inArray(order_items.order_id, orderIds)` (import `inArray` from `drizzle-orm`) and guard the empty-array case. The note exists only because a snippet can't express the array cleanly; the real code uses `inArray`.

- [ ] **Step 2: Write `ship.ts`** (closed → shipped; one tracking_no; mark every group order shipped)

```ts
import type { APIRoute } from "astro";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_groups } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { env } from "../../../../../lib/env";

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);
  if (auth.session.role !== "admin") return text("admin only", 403);
  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) return text("bad id", 400);
  let body: { tracking_no?: string };
  try { body = (await request.json()) as { tracking_no?: string }; } catch { return text("bad json", 400); }
  const tracking = (body.tracking_no ?? "").trim();
  if (!tracking) return json({ ok: false, error_code: "NO_TRACKING" }, 400);

  const db = makeDb(env);
  const g = (await db.select().from(order_groups).where(eq(order_groups.id, groupId)).limit(1))[0];
  if (!g) return text("not found", 404);
  if (g.status !== "closed") return json({ ok: false, error_code: "BAD_STATE", status: g.status }, 409);

  const grp = await db.select({ order_id: orders.order_id }).from(orders)
    .where(and(eq(orders.order_group_id, groupId), isNull(orders.cancelled_at)));
  const ids = grp.map((o) => o.order_id);
  const now = new Date().toISOString();
  await env.DB.batch([
    // Reuse the bulk-ship invariant: only paid & not-yet-shipped & not-cancelled rows flip.
    env.DB.prepare(
      `UPDATE orders SET shipped = 1, shipped_at = ?, shipped_by = ?, tracking_no = ? WHERE shipped = 0 AND paid = 1 AND cancelled_at IS NULL AND order_group_id = ?`,
    ).bind(now, auth.session.email, tracking, groupId),
    env.DB.prepare(`UPDATE order_groups SET status = 'shipped', tracking_no = ?, shipped_at = ?, shipped_by = ? WHERE id = ? AND status = 'closed'`)
      .bind(tracking, now, auth.session.email, groupId),
    env.DB.prepare(`INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'group_shipped', ?, ?)`)
      .bind(now, auth.session.email, g.season_id, JSON.stringify({ group_id: groupId, tracking_no: tracking, order_ids: ids })),
  ]);
  return json({ ok: true, shipped: ids.length });
};
```
> Members with `paid=0` won't flip to shipped (the `paid=1` gate). That's intended — the admin should collect member payment before shipping, OR change the gate to ship regardless of payment by removing `AND paid = 1`. Document the choice with the shop owner; default keeps the existing invariant.

- [ ] **Step 3: Write `cancel.ts`** (any non-shipped state → cancelled; soft-cancel every member, restore stock)

```ts
import type { APIRoute } from "astro";
import { and, eq, isNull } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_items, order_groups, products } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { restoreGroupStock, getGroupStockFen, stockAuditStmts } from "../../../../../lib/stock";
import { env } from "../../../../../lib/env";

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);
  if (auth.session.role !== "admin") return text("admin only", 403);
  const groupId = Number(params.id);
  if (!Number.isInteger(groupId)) return text("bad id", 400);

  const db = makeDb(env);
  const g = (await db.select().from(order_groups).where(eq(order_groups.id, groupId)).limit(1))[0];
  if (!g) return text("not found", 404);
  if (g.status === "shipped" || g.status === "cancelled")
    return json({ ok: false, error_code: "BAD_STATE", status: g.status }, 409);

  // Only orders not yet shipped/cancelled are cancellable; restore their group stock.
  const live = await db
    .select({ order_id: orders.order_id, group_id: products.group_id, fen: order_items.qty /* ×package_fen below */, package_fen: products.package_fen, qty: order_items.qty })
    .from(orders)
    .innerJoin(order_items, eq(order_items.order_id, orders.order_id))
    .innerJoin(products, eq(order_items.product_id, products.id))
    .where(and(eq(orders.order_group_id, groupId), isNull(orders.cancelled_at), eq(orders.shipped, false)));
  // Aggregate fen to restore per product-group.
  const restoreMap = new Map<number, number>();
  for (const r of live) restoreMap.set(r.group_id, (restoreMap.get(r.group_id) ?? 0) + r.package_fen * r.qty);
  const increments = [...restoreMap.entries()].map(([group_id, fen]) => ({ group_id, fen }));
  const before = await getGroupStockFen(env, increments.map((i) => i.group_id));
  const now = new Date().toISOString();

  await restoreGroupStock(env, increments);
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET cancelled_at = ? WHERE order_group_id = ? AND cancelled_at IS NULL AND shipped = 0`).bind(now, groupId),
    env.DB.prepare(`UPDATE order_groups SET status = 'cancelled' WHERE id = ?`).bind(groupId),
    ...stockAuditStmts(env, increments.map((i) => {
      const b = before.get(i.group_id) ?? 0;
      return { group_id: i.group_id, delta_fen: i.fen, before_fen: b, after_fen: b + i.fen, reason: "order_restore" as const, source_id: `group-${groupId}`, season_id: g.season_id, ts: now };
    })),
    env.DB.prepare(`INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'group_cancelled', ?, ?)`)
      .bind(now, auth.session.email, g.season_id, JSON.stringify({ group_id: groupId })),
  ]);
  return json({ ok: true });
};
```

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/admin/groups/[id]/close.ts src/pages/api/admin/groups/[id]/ship.ts src/pages/api/admin/groups/[id]/cancel.ts
git commit -m "feat(groups): admin close / ship / cancel group APIs"
```

---

### Task 8: Admin list + detail pages (per-person picking list)

**Files:**
- Create: `src/pages/admin/groups/index.astro`
- Create: `src/pages/admin/groups/[id].astro`

**Interfaces:**
- Consumes: the close/ship/cancel endpoints (Task 7); group + member-order data.

- [ ] **Step 1: Create `src/pages/admin/groups/index.astro`** (list)

Frontmatter: gate to admin; query groups + per-group order counts:
```ts
const groups = await db.select().from(order_groups).orderBy(desc(order_groups.created_at)).limit(200);
const counts = await db.all<{ order_group_id: number; n: number }>(
  sql`SELECT order_group_id, COUNT(*) AS n FROM orders WHERE order_group_id IS NOT NULL AND cancelled_at IS NULL GROUP BY order_group_id`,
);
```
Template: a table/list (model on `orders/index.astro`) — each row links to `/admin/groups/${g.id}`, showing code, host_name, deadline, status badge, member count. A 「+ 發起併單」 button → `/admin/groups/new`.

- [ ] **Step 2: Create `src/pages/admin/groups/[id].astro`** (detail + actions + picking list)

Frontmatter: gate to admin; load the group, all its orders (host first), each order's items (join products for name/variant/package_fen), and the season shipping config. Compute combined 斤 and (for display) what the host fee would be.

Template:
- Header: code, deadline, status, host name/phone/address, tracking_no (if shipped).
- **Per-person list** (區分誰的貨): one block per order — name, paid/shipped badge, that order's items (`{name}{variant} ×{qty}`), subtotal. This is the picking/packing list. Mark the host block 「團主」.
- Combined: total 斤, host 運費 (post-close), grand total to collect.
- Action buttons by status: `open` → 「關團結算」(POST close); `closed` → tracking input + 「整團出貨」(POST ship); `open`|`closed` → 「取消整團」(POST cancel). Reuse the confirm + `location.reload()` pattern from `orders/[id].astro`.

Client JS (model on `orders/[id].astro`'s button handlers):
```ts
async function act(path: string, body?: unknown) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (res.ok && data.ok) { location.reload(); }
  else { alert(data.error_code === "BAD_STATE" ? "狀態已變更，請重新整理" : (data.error_code ?? "操作失敗")); }
}
document.getElementById("close-btn")?.addEventListener("click", () => { if (confirm("關團後不能再加入，確定結算運費？")) act(`/api/admin/groups/${GROUP_ID}/close`); });
document.getElementById("ship-btn")?.addEventListener("click", () => {
  const t = (document.getElementById("tracking") as HTMLInputElement).value.trim();
  if (!t) return alert("請填物流單號");
  act(`/api/admin/groups/${GROUP_ID}/ship`, { tracking_no: t });
});
document.getElementById("cancel-btn")?.addEventListener("click", () => { if (confirm("取消整團會還原所有人的庫存，確定？")) act(`/api/admin/groups/${GROUP_ID}/cancel`); });
```
(`GROUP_ID` is injected via a JSON island from the frontmatter, the same way `orders/[id].astro` passes `expected_state`.)

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/admin/groups/index.astro src/pages/admin/groups/[id].astro
git commit -m "feat(groups): admin group list + detail with per-person picking list"
```

---

### Task 9: End-to-end integration test + cleanup helper

**Files:**
- Modify: `tests/_setup.ts` (extend `cleanupTestData`)
- Modify: `tests/order-groups-d1.test.ts` (full lifecycle)

- [ ] **Step 1: Extend `cleanupTestData()`** — in `tests/_setup.ts`, after the orders delete (line ~286) add:

```ts
  // V7 併單: remove test groups (orders already deleted above; this clears the group rows).
  d1Execute(
    `DELETE FROM order_groups WHERE created_by LIKE '%@local' OR season_id IN (SELECT id FROM seasons WHERE code LIKE '${TEST_SEASON_PREFIX}%')`,
  );
```

- [ ] **Step 2: Write the lifecycle test** in `tests/order-groups-d1.test.ts`:

```ts
  it("full lifecycle: create → join → close finalises host fee → ship marks all", async () => {
    // 1. seedActiveSeasonScenario (threshold config season OR flat — assert accordingly).
    // 2. create group (host 2斤) → code.
    // 3. member joins (1斤) via /api/orders with group_code → shipping 0.
    // 4. POST /api/admin/groups/{id}/close → host order shipping == computeShipping(combined fen, config).
    // 5. mark host + member paid (d1Execute UPDATE orders SET paid=1 ...) so the ship gate passes.
    // 6. POST /api/admin/groups/{id}/ship { tracking_no:'TEST123' } → all group orders shipped=1,
    //    order_groups.status='shipped', tracking_no set.
    // Assertions via d1Execute SELECTs.
  });
```
Fill in concretely using the helpers (`createTestAdminSession`, `stageFetch`, `clearOrderRateLimit`, `d1Execute`). Use a flat-$150 test season so the expected host fee is deterministic (150).

- [ ] **Step 3: Run the full integration suite**

Run: `MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev TEST_TOKEN=<stage ORDER_TOKEN> bun test tests/order-groups-d1.test.ts --timeout 90000`
Expected: PASS (all cases). Then `bun test tests/order-groups.test.ts tests/admin-nav.test.ts` → PASS (pure units unaffected).

- [ ] **Step 4: Commit**

```bash
git add tests/_setup.ts tests/order-groups-d1.test.ts
git commit -m "test(groups): end-to-end lifecycle integration + cleanup helper"
```

---

## Self-Review

**Spec coverage:**
- Separate orders linked by group → Task 1 (`order_group_id`/`group_role`) + Task 3/5 stamping. ✓
- 5-digit code, unique among open → Task 1 (partial index) + Task 2 (`generateGroupCode`/`isValidGroupCode`) + Task 3 (collision retry). ✓
- Deadline ≤ +14d, future → Task 2 (`validateDeadline`) + Task 3 (server) + Task 4 (client min/max). ✓
- Admin-only create → Task 3 (`role==='admin'` 403). ✓
- Host = admin-designated, also a buyer → Task 3 (host order) + Task 4 (form). ✓
- Members ship $0, address = host → Task 5 (orders.ts). ✓
- One address, one tracking, one fee on host at close → Task 7 (close finalises host fee; ship one tracking). ✓
- Combined-weight shipping (flat/threshold) → Task 2 (`computeGroupShipping`) + Task 7 (close). ✓
- Whose-goods picking list → Task 8 (`[id].astro` per-person blocks). ✓
- Cancel restores stock → Task 7 (`cancel.ts`). ✓
- Customer join UX (code input, hide address, lookup) → Task 6 + Task 5 lookup. ✓
- Tests (pure + integration) → Task 2, Task 3/5/9. ✓
- Nav discoverability (lesson from PR #35) → Task 4 (併單 nav entry). ✓

**Placeholder scan:** Two snippets carry an explicit engineer note (the `inArray` substitution in `close.ts` Step 1, and the fill-in test bodies in Task 5/9). These are flagged inline with the exact replacement, not silent TODOs. The `<stage ORDER_TOKEN>` in run commands is a real secret the runner supplies. No "TBD"/"add error handling"-style gaps remain.

**Type consistency:** `order_group_id` (not `group_id`) used consistently across schema, orders.ts, and all endpoints. `generateGroupCode`/`isValidGroupCode`/`validateDeadline`/`computeGroupShipping` signatures match Task 2 across consumers. Group status strings `open|closed|shipped|cancelled` consistent. Response shapes (`{ ok, group_id, code, host_order_id }`, `{ ok, host_name, deadline }`, `{ ok, group_shipping }`) consistent between producer and test consumers.
