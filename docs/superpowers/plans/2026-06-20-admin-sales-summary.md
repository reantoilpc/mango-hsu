# Admin Sales Summary (銷售概況) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible, admin-only "銷售概況" section to the admin home page showing per-flavour 斤 sold, item revenue, the 商品小計→運費→訂單總額 hierarchy, and 已收/未收/收款% — for the active season, cumulative.

**Architecture:** A new pure-leaning module `src/lib/sales-summary.ts` holds two D1 aggregation queries (`querySalesSummary`) plus a pure, unit-tested shaper (`shapeSalesSummary`) and a Workers-safe money formatter (`formatTwd`). `src/pages/admin/index.astro` renders the result in a new section, gated to `session.role === "admin"`. Mirrors the existing `admin-dashboard.ts` (pure helpers) + inline-`sql` (DB access) patterns already on that page.

**Tech Stack:** Astro 6 SSR · Cloudflare D1 + Drizzle (`db.all<T>(sql\`...\`)`) · Tailwind v4 · `bun test`.

## Global Constraints

- Stock unit: **1 斤 = 100 fen**; 斤 strings via existing `fenToJinLabel(fen)` from `src/lib/admin-dashboard.ts` (`(fen/100).toFixed(2)`).
- All money is integer **TWD**.
- "Active" orders only: `orders.cancelled_at IS NULL` (matches `activeOrdersFilter`). Includes unpaid orders.
- Scope every query to the active season: `orders.season_id = <activeSeason.id>`.
- `package_fen` is immutable post-creation → `Σ(qty × package_fen)` is historically exact.
- Money rendering uses thousands separators via `formatTwd` (no `Intl`/ICU — Workers has no full ICU).
- Test imports: `import { describe, expect, it } from "bun:test";` (match `tests/stock-helper.test.ts`).
- Tailwind brand token `text-mango-700` exists (used elsewhere in `index.astro`).

---

### Task 1: Pure money formatter + summary shaper (fully unit-tested)

**Files:**
- Create: `src/lib/sales-summary.ts` (types + `formatTwd` + `shapeSalesSummary` only — the query fn is added in Task 2)
- Test: `tests/sales-summary.test.ts`

**Interfaces:**
- Consumes: `fenToJinLabel` from `src/lib/admin-dashboard.ts`.
- Produces (relied on by Tasks 2 & 3):
  - `interface PerFlavourRow { id: number; name: string; qty: number; fen: number; amount: number }`
  - `interface OrderTotalsRow { orders_n: number; subtotal: number; shipping: number; total: number; paid_total: number; unpaid_total: number }`
  - `interface SalesFlavour { name: string; jin: string; qty: number; amount: number }`
  - `interface SalesSummary { flavours: SalesFlavour[]; totals: { jin: string; qty: number; subtotal: number; shipping: number; total: number }; collection: { paid: number; unpaid: number; paidPct: number }; ordersN: number; hasSales: boolean }`
  - `function formatTwd(n: number): string`
  - `function shapeSalesSummary(perFlavour: PerFlavourRow[], totals: OrderTotalsRow): SalesSummary`

- [ ] **Step 1: Write the failing test**

Create `tests/sales-summary.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { formatTwd, shapeSalesSummary, type OrderTotalsRow } from "../src/lib/sales-summary";

describe("formatTwd", () => {
  it("formats TWD with thousands separators", () => {
    expect(formatTwd(0)).toBe("$0");
    expect(formatTwd(880)).toBe("$880");
    expect(formatTwd(38480)).toBe("$38,480");
    expect(formatTwd(71030)).toBe("$71,030");
    expect(formatTwd(1000000)).toBe("$1,000,000");
  });
});

describe("shapeSalesSummary", () => {
  const perFlavour = [
    { id: 5, name: "金煌芒果乾", qty: 122, fen: 8100, amount: 38480 },
    { id: 6, name: "愛文芒果乾", qty: 92, fen: 6150, amount: 31670 },
  ];
  const totals: OrderTotalsRow = {
    orders_n: 15, subtotal: 70150, shipping: 880, total: 71030,
    paid_total: 25310, unpaid_total: 45720,
  };

  it("shapes a normal two-flavour mix", () => {
    const s = shapeSalesSummary(perFlavour, totals);
    expect(s.flavours).toEqual([
      { name: "金煌芒果乾", jin: "81.00", qty: 122, amount: 38480 },
      { name: "愛文芒果乾", jin: "61.50", qty: 92, amount: 31670 },
    ]);
    expect(s.totals).toEqual({ jin: "142.50", qty: 214, subtotal: 70150, shipping: 880, total: 71030 });
    expect(s.collection).toEqual({ paid: 25310, unpaid: 45720, paidPct: 36 }); // 25310/71030 = 35.63% → 36
    expect(s.ordersN).toBe(15);
    expect(s.hasSales).toBe(true);
  });

  it("handles an empty season (no orders)", () => {
    const s = shapeSalesSummary([], {
      orders_n: 0, subtotal: 0, shipping: 0, total: 0, paid_total: 0, unpaid_total: 0,
    });
    expect(s.hasSales).toBe(false);
    expect(s.flavours).toEqual([]);
    expect(s.totals.jin).toBe("0.00");
    expect(s.totals.qty).toBe(0);
    expect(s.collection.paidPct).toBe(0); // guarded: no divide-by-zero
  });

  it("reports 100% when fully paid", () => {
    const s = shapeSalesSummary(perFlavour, { ...totals, paid_total: 71030, unpaid_total: 0 });
    expect(s.collection.paidPct).toBe(100);
  });

  it("reports 0% when fully unpaid", () => {
    const s = shapeSalesSummary(perFlavour, { ...totals, paid_total: 0, unpaid_total: 71030 });
    expect(s.collection.paidPct).toBe(0);
    expect(s.collection.unpaid).toBe(71030);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sales-summary.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/sales-summary'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/sales-summary.ts`:

```ts
// V6 §5.7+ — admin-home sales summary (銷售概況).
// Split like admin-dashboard.ts: pure, unit-testable shaping here; the DB
// aggregation (querySalesSummary) is added alongside but kept thin.
// 1 斤 = 100 fen. All money is integer TWD. package_fen is immutable, so
// Σ(qty × package_fen) reconstructs historical weight exactly.

import { fenToJinLabel } from "./admin-dashboard";

// Raw row from the per-flavour aggregation query (one per product_group).
export interface PerFlavourRow {
  id: number;
  name: string;
  qty: number; // Σ order_items.qty
  fen: number; // Σ(qty × package_fen)
  amount: number; // Σ(qty × unit_price) — item revenue, excludes shipping
}

// Raw single row from the order-totals aggregation query.
export interface OrderTotalsRow {
  orders_n: number;
  subtotal: number; // Σ orders.subtotal (== Σ per-flavour amount)
  shipping: number; // Σ orders.shipping
  total: number; // Σ orders.total (== subtotal + shipping)
  paid_total: number; // Σ total where paid = 1
  unpaid_total: number; // Σ total where paid = 0
}

export interface SalesFlavour {
  name: string;
  jin: string; // e.g. "81.00"
  qty: number;
  amount: number;
}

export interface SalesSummary {
  flavours: SalesFlavour[];
  totals: { jin: string; qty: number; subtotal: number; shipping: number; total: number };
  collection: { paid: number; unpaid: number; paidPct: number }; // paidPct: int 0..100
  ordersN: number;
  hasSales: boolean;
}

// TWD with thousands separators. Workers-safe: regex grouping, no Intl/ICU.
// formatTwd(38480) === "$38,480"; formatTwd(0) === "$0".
export function formatTwd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = Math.abs(Math.round(n)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}`;
}

export function shapeSalesSummary(
  perFlavour: PerFlavourRow[],
  totals: OrderTotalsRow,
): SalesSummary {
  const flavours: SalesFlavour[] = perFlavour.map((r) => ({
    name: r.name,
    jin: fenToJinLabel(r.fen),
    qty: r.qty,
    amount: r.amount,
  }));
  const totalFen = perFlavour.reduce((sum, r) => sum + r.fen, 0);
  const totalQty = perFlavour.reduce((sum, r) => sum + r.qty, 0);
  const grand = totals.total;
  return {
    flavours,
    totals: {
      jin: fenToJinLabel(totalFen),
      qty: totalQty,
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      total: grand,
    },
    collection: {
      paid: totals.paid_total,
      unpaid: totals.unpaid_total,
      paidPct: grand === 0 ? 0 : Math.round((totals.paid_total / grand) * 100),
    },
    ordersN: totals.orders_n,
    hasSales: totals.orders_n > 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sales-summary.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales-summary.ts tests/sales-summary.test.ts
git commit -m "feat(sales): pure shaper + TWD formatter for 銷售概況

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017dgbvZGhxSJjpnq12ufS93"
```

---

### Task 2: D1 aggregation query layer

**Files:**
- Modify: `src/lib/sales-summary.ts` (append the query function + its result type and imports)

**Interfaces:**
- Consumes: `PerFlavourRow`, `OrderTotalsRow` (Task 1); `sql` from `drizzle-orm`; `DrizzleD1Database` from `drizzle-orm/d1`; `schema` from `../db/schema` (to type the db param to match `makeDb`'s return).
- Produces (relied on by Task 3):
  - `interface SalesQueryResult { perFlavour: PerFlavourRow[]; totals: OrderTotalsRow }`
  - `function querySalesSummary(db: DrizzleD1Database<typeof schema>, seasonId: number): Promise<SalesQueryResult>`

- [ ] **Step 1: Add imports at the top of `src/lib/sales-summary.ts`**

Add below the existing `import { fenToJinLabel } ...` line:

```ts
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../db/schema";
```

- [ ] **Step 2: Append the query function to `src/lib/sales-summary.ts`**

```ts
export interface SalesQueryResult {
  perFlavour: PerFlavourRow[];
  totals: OrderTotalsRow;
}

// Two aggregation queries, both scoped to the active season and non-cancelled
// orders. CAST(...AS INTEGER) + COALESCE(...,0) keep D1 from returning REAL or
// NULL on empty aggregates. ORDER BY pg.display_order is functionally dependent
// on the GROUP BY pg.id (SQLite permits this).
export async function querySalesSummary(
  db: DrizzleD1Database<typeof schema>,
  seasonId: number,
): Promise<SalesQueryResult> {
  const perFlavour = await db.all<PerFlavourRow>(sql`
    SELECT pg.id AS id, pg.name AS name,
           CAST(COALESCE(SUM(oi.qty), 0) AS INTEGER) AS qty,
           CAST(COALESCE(SUM(oi.qty * p.package_fen), 0) AS INTEGER) AS fen,
           CAST(COALESCE(SUM(oi.qty * oi.unit_price), 0) AS INTEGER) AS amount
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN product_groups pg ON pg.id = p.group_id
    JOIN orders o ON o.order_id = oi.order_id
    WHERE o.season_id = ${seasonId} AND o.cancelled_at IS NULL
    GROUP BY pg.id, pg.name
    ORDER BY pg.display_order, pg.slug
  `);

  const totalsRows = await db.all<OrderTotalsRow>(sql`
    SELECT COUNT(*) AS orders_n,
           CAST(COALESCE(SUM(subtotal), 0) AS INTEGER) AS subtotal,
           CAST(COALESCE(SUM(shipping), 0) AS INTEGER) AS shipping,
           CAST(COALESCE(SUM(total), 0) AS INTEGER) AS total,
           CAST(COALESCE(SUM(CASE WHEN paid = 1 THEN total ELSE 0 END), 0) AS INTEGER) AS paid_total,
           CAST(COALESCE(SUM(CASE WHEN paid = 0 THEN total ELSE 0 END), 0) AS INTEGER) AS unpaid_total
    FROM orders
    WHERE season_id = ${seasonId} AND cancelled_at IS NULL
  `);

  const totals: OrderTotalsRow = totalsRows[0] ?? {
    orders_n: 0, subtotal: 0, shipping: 0, total: 0, paid_total: 0, unpaid_total: 0,
  };
  return { perFlavour, totals };
}
```

- [ ] **Step 3: Type-check the build**

Run: `bun run build`
Expected: PASS (Astro `check` + build succeed; no TS errors from the new query).

- [ ] **Step 4: Verify the SQL against real data (read-only)**

Run the per-flavour query against prod to confirm columns + known numbers (active season = 2026; group ids 5/6):

```bash
npx wrangler d1 execute mango-hsu-prod --remote --json --command "SELECT pg.id AS id, pg.name AS name, CAST(COALESCE(SUM(oi.qty),0) AS INTEGER) AS qty, CAST(COALESCE(SUM(oi.qty*p.package_fen),0) AS INTEGER) AS fen, CAST(COALESCE(SUM(oi.qty*oi.unit_price),0) AS INTEGER) AS amount FROM order_items oi JOIN products p ON p.id=oi.product_id JOIN product_groups pg ON pg.id=p.group_id JOIN orders o ON o.order_id=oi.order_id WHERE o.cancelled_at IS NULL GROUP BY pg.id, pg.name ORDER BY pg.display_order, pg.slug;"
```

Expected: 金煌 `fen=8100, amount=38480`; 愛文 `fen=6150, amount=31670` (matches the manual baseline). This is a read-only SELECT — no writes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sales-summary.ts
git commit -m "feat(sales): D1 aggregation query for 銷售概況

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017dgbvZGhxSJjpnq12ufS93"
```

---

### Task 3: Render the admin-only section on the home page

**Files:**
- Modify: `src/pages/admin/index.astro` (frontmatter: import + data load; template: new `<section>` after 各品種剩餘庫存, before 最近訂單)

**Interfaces:**
- Consumes: `querySalesSummary`, `shapeSalesSummary`, `formatTwd`, type `SalesSummary` (Tasks 1–2); existing page locals `session`, `db`, `activeSeason`.
- Produces: none (terminal UI).

- [ ] **Step 1: Add the import to the frontmatter**

In `src/pages/admin/index.astro`, add after the `import { groupStockSummary } ...` line:

```ts
import { querySalesSummary, shapeSalesSummary, formatTwd, type SalesSummary } from "../../lib/sales-summary";
```

- [ ] **Step 2: Load the summary (admin-only) in the frontmatter**

Add immediately after the `const stockSummary = groupStockSummary(groupRows);` line:

```ts
// Sales summary is admin-only (operators must not see revenue). Skip the
// queries entirely for operators and when no season is active.
let sales: SalesSummary | null = null;
if (activeSeason && session.role === "admin") {
  const raw = await querySalesSummary(db, activeSeason.id);
  sales = shapeSalesSummary(raw.perFlavour, raw.totals);
}
```

- [ ] **Step 3: Add the section to the template**

In `src/pages/admin/index.astro`, insert this block **between** the closing `)}` of the `{activeSeason && ( ... 各品種剩餘庫存 ... )}` section and the `<h2 class="mb-3 text-lg font-bold">最近訂單</h2>` line:

```astro
    {/* Sales summary — admin only, active-season cumulative */}
    {sales && (
      <section class="mb-8" aria-label="銷售概況">
        <h2 class="mb-2 text-lg font-bold">
          銷售概況
          <span class="ml-2 text-sm font-normal text-gray-500">{activeSeason.name} · 當季累計</span>
        </h2>
        {sales.hasSales ? (
          <div class="rounded border border-gray-200">
            <ul class="divide-y divide-gray-100">
              {sales.flavours.map((f) => (
                <li class="flex items-baseline justify-between px-4 py-3">
                  <span class="font-medium">{f.name}</span>
                  <span class="flex items-baseline gap-4 text-right text-sm">
                    <span class="w-20 text-base font-bold text-mango-700">{f.jin} 斤</span>
                    <span class="w-12 text-gray-500">{f.qty} 件</span>
                    <span class="w-20 font-medium">{formatTwd(f.amount)}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div class="space-y-1 border-t border-gray-200 px-4 py-3 text-sm">
              <div class="flex justify-between">
                <span>合計</span>
                <span>{sales.totals.jin} 斤 · {sales.totals.qty} 件 · {formatTwd(sales.totals.subtotal)}</span>
              </div>
              <div class="flex justify-between text-gray-500">
                <span>運費</span>
                <span>+ {formatTwd(sales.totals.shipping)}</span>
              </div>
              <div class="flex justify-between font-bold">
                <span>訂單總額（{sales.ordersN} 筆）</span>
                <span>{formatTwd(sales.totals.total)}</span>
              </div>
            </div>
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-gray-200 bg-gray-50 px-4 py-3 text-sm">
              <span class="text-emerald-700">已收 <strong>{formatTwd(sales.collection.paid)}</strong></span>
              <span class="text-amber-700">未收 <strong>{formatTwd(sales.collection.unpaid)}</strong></span>
              <span class="text-gray-600">收款進度 {sales.collection.paidPct}%</span>
            </div>
          </div>
        ) : (
          <p class="rounded border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
            當季尚無銷售。
          </p>
        )}
      </section>
    )}
```

- [ ] **Step 4: Type-check + build**

Run: `bun run build`
Expected: PASS — no TS/Astro errors; the new `<section>` compiles.

- [ ] **Step 5: Visual smoke test (dev server)**

Run: `bun run dev`, log in to `/admin` as an **admin**, and confirm the 銷售概況 section renders below 各品種剩餘庫存 with per-flavour 斤/件/$ rows, the 合計/運費/訂單總額 block, and the 已收/未收/收款% line. Then confirm an **operator** login does NOT see the section. (If no operator account is handy, this is verified by code: the section is inside `{sales && ...}` and `sales` is only set when `session.role === "admin"`.)

- [ ] **Step 6: Commit**

```bash
git add src/pages/admin/index.astro
git commit -m "feat(sales): render 銷售概況 on admin home (admin-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017dgbvZGhxSJjpnq12ufS93"
```

---

## Self-Review

**Spec coverage:**
- Placement (home section, below stock) → Task 3 Step 3. ✓
- Active-season cumulative → `WHERE season_id = ?` in Task 2; load keyed on `activeSeason` in Task 3. ✓
- admin-only visibility → Task 3 Step 2 guard (`session.role === "admin"`) + section inside `{sales && ...}`. ✓
- Per-flavour 斤 / 件 / 金額 → Task 1 shaper + Task 2 per-flavour query + Task 3 rows. ✓
- Amount hierarchy (商品小計 → 運費 → 訂單總額) → Task 1 `totals` + Task 3 totals block. ✓
- Collection (已收/未收/%; divide-by-zero guard) → Task 1 `collection` + Task 3 collection line. ✓
- Edge cases: no active season (section skipped), zero orders (`hasSales=false` → 當季尚無銷售), operator hidden, NULL sums coerced → Tasks 2 & 3. ✓
- Tests: normal / empty / fully-paid / fully-unpaid / rounding → Task 1 Step 1. ✓
- 斤 exactness (immutable package_fen) → Global Constraints + Task 2 verification Step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the exact command + expected result. ✓

**Type consistency:** `PerFlavourRow`/`OrderTotalsRow`/`SalesSummary`/`SalesFlavour` defined in Task 1 and consumed unchanged in Tasks 2–3. `querySalesSummary(db, seasonId)` returns `{ perFlavour, totals }`, fed into `shapeSalesSummary(perFlavour, totals)` — names and shapes match. `formatTwd` signature consistent across tasks. ✓
