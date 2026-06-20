# Admin Sales Summary (銷售概況) — Design

**Date:** 2026-06-20
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with shop owner

## Problem

The admin home page (`src/pages/admin/index.astro`) shows order *counts* (總訂單／待付款／待出貨) and remaining *stock* per flavour, but never shows **what has sold or how much money is owed**. The owner currently has to ask for an ad-hoc D1 query to learn "金煌/愛文 各賣了多少斤，總共要收多少錢". This feature makes that a permanent, always-visible view.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Placement | A new **section on the admin home page** (most discoverable — owner values "好找"). Not a separate page. |
| Time range | **Active-season cumulative only.** No today/week filters, no switcher. |
| Visibility | **admin role only.** Operators do not see revenue/amount figures. |
| Granularity | **Per flavour (product_group)** — 金煌 / 愛文. No per-SKU (1斤/半斤) split. |
| Order scope | **Active orders only** (`cancelled_at IS NULL`). Includes unpaid orders (an order reserves stock = a sale-in-progress); the paid/unpaid split is shown via collection figures. |

## Correctness notes

- **斤 sold is exact.** `package_fen` is immutable after a SKU is created (the products `update`/`batch` endpoints explicitly disallow editing it — would need a migration-style rewrite). So `Σ(order_items.qty × products.package_fen)` reconstructs the historical weight with no snapshot drift. 1 斤 = 100 fen.
- **Amount hierarchy.** Per-flavour `品項金額 = Σ(qty × unit_price)` (item revenue, snapshotted at order time, excludes shipping). The per-flavour amounts sum to `商品小計` (= Σ `orders.subtotal`). `訂單總額 = 商品小計 + 運費` (= Σ `orders.total`). This hierarchy is shown explicitly so shipping isn't double-counted or confused.
- **Collection.** 已收 = Σ `total` where `paid=1`; 未收 = Σ `total` where `paid=0`; 收款進度 = 已收 / 訂單總額 (guard: 0% when 訂單總額 = 0).

## Architecture

Mirror the existing `admin-dashboard.ts` pattern: keep DB access thin and the math pure + unit-testable. New module `src/lib/sales-summary.ts`:

### 1. Query layer — `querySalesSummary(db, seasonId)`

Runs two aggregation queries (active season, `cancelled_at IS NULL`) and returns the raw rows:

- **Per flavour** — `order_items oi JOIN products p ON p.id = oi.product_id JOIN product_groups pg ON pg.id = p.group_id JOIN orders o ON o.order_id = oi.order_id`, `WHERE o.season_id = ?seasonId AND o.cancelled_at IS NULL`, `GROUP BY pg.id`, `ORDER BY pg.display_order, pg.slug`. Selects `pg.id, pg.name, SUM(oi.qty) AS qty, SUM(oi.qty * p.package_fen) AS fen, SUM(oi.qty * oi.unit_price) AS amount`.
- **Order totals** — over `orders WHERE season_id = ?seasonId AND cancelled_at IS NULL`: `COUNT(*) AS orders_n, SUM(subtotal), SUM(shipping), SUM(total), SUM(CASE WHEN paid=1 THEN total ELSE 0 END) AS paid_total, SUM(CASE WHEN paid=0 THEN total ELSE 0 END) AS unpaid_total`. (NULL-safe: empty season yields NULLs → coerce to 0.)

### 2. Pure shaper — `shapeSalesSummary(perFlavourRows, orderTotalsRow)`

No `env`, no `Date`, no DB. Returns a display-ready object:

```ts
interface SalesSummary {
  flavours: Array<{ name: string; jin: string; qty: number; amount: number }>;
  totals: { jin: string; qty: number; subtotal: number; shipping: number; total: number };
  collection: { paid: number; unpaid: number; paidPct: number }; // paidPct rounded int 0..100
  ordersN: number;
  hasSales: boolean; // ordersN > 0
}
```

Reuses `fenToJinLabel()` from `admin-dashboard.ts` for 斤 strings. `paidPct = total === 0 ? 0 : Math.round(paid / total * 100)`.

### 3. Render — `src/pages/admin/index.astro`

- Only when `activeSeason` exists AND `session.role === "admin"`. Load via `querySalesSummary(db, activeSeason.id)` → `shapeSalesSummary(...)`.
- New `<section>` placed **below "各品種剩餘庫存"**, using the same border/card styling already on the page.
- Layout: one row per flavour (name · 斤 · 件 · $amount), a totals block (合計斤/件, 商品小計, 運費, 訂單總額 with order count), and a collection line (已收 / 未收 / 收款 %).
- Money rendered with thousands separators (`$38,480`). No new money helper required beyond `toLocaleString()`.
- `hasSales === false` → render the frame with zeros and a muted「尚無銷售」note.

## UI sketch

```
★ 銷售概況（2026 芒果季 · 當季累計）
┌────────────────────────────────────────┐
│ 金煌芒果乾   81.00 斤  122 件   $38,480 │
│ 愛文芒果乾   61.50 斤   92 件   $31,670 │
├────────────────────────────────────────┤
│ 合計        142.50 斤  214 件   $70,150 │  商品小計
│ 運費                            +  $880 │
│ 訂單總額（15 筆）                $71,030 │
├────────────────────────────────────────┤
│ 已收 $25,310   未收 $45,720   收款 36% │
└────────────────────────────────────────┘
```

## Edge cases

- **No active season** → section hidden entirely (same behaviour as the stock section).
- **Active season, zero orders** → `hasSales=false`; show the frame with all-zero figures and「尚無銷售」.
- **訂單總額 = 0** → 收款進度 guarded to 0% (no division by zero).
- **Operator role** → section not rendered at all (no revenue leakage).
- **NULL SUMs** (empty aggregates) → coerced to 0 in the query layer.

## Testing

`tests/sales-summary.test.ts` — pure unit (no env, no network), testing `shapeSalesSummary`:
- Normal two-flavour mix → correct jin labels, per-flavour amounts, totals, collection split, paidPct.
- Empty (zero orders) → `hasSales=false`, all zeros, paidPct 0.
- Fully paid → paidPct 100.
- Fully unpaid → paidPct 0, 未收 = 訂單總額.
- Rounding: fen→jin (`fenToJinLabel`) and paidPct `Math.round` boundaries.

The query layer (`querySalesSummary`) is exercised by the existing manual D1 verification; an optional integration test against the stage worker can follow the `tests/stock-d1.test.ts` pattern but is not required for v1 (the math — the risk — is covered by the pure unit test).

## Out of scope (YAGNI)

Per-SKU breakdown, today/this-week/date-range filters, charts/graphs, CSV export, a dedicated `/admin/sales` page, cross-season comparison.
