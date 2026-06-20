# 併單 / 合併出貨 (Order Groups) — Design

**Date:** 2026-06-20
**Status:** Approved (design), pending implementation plan
**Branch:** feat/order-groups

## Problem

The shop wants a 團購-style "併單" (group order): the owner starts a group, shares a short code, and several customers each place their own order using that code. The whole group ships as one parcel to one address (the 團主 / host), with one shipping fee, while the packing slip still distinguishes whose goods are whose. Today every order is fully independent (own name/address/shipping/total) — there is no way to link orders or ship them together.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Order structure | **Separate orders linked by a group.** Each person keeps their own order (name/items/payment); a 5-digit code binds them into one group, shipped together. NOT one merged order. |
| Shipping fee | **Computed once for the whole group, charged to the 團主.** `computeShipping(Σ all group orders' fen, season config)` — same logic as a single order, applied to combined weight. Members always pay **$0**. (Flat $150 config → host pays $150 once. Threshold config → free if combined weight clears the threshold.) |
| When shipping is finalised | **At group close.** Members join over time and change the combined weight, so the host fee can't be final until the group closes. |
| Host (團主) | **Admin designates host name + address at group creation, and the host is also a buyer** — admin creates the host's order in the same step. The host order carries the (close-time) group shipping fee. |
| Destination | **One address (the host's).** Whole group ships there, one tracking number. Members don't enter an address. |
| Who can start a group | **Admin only** (`/admin/**`). Customers can only *join* via the code. |
| Deadline | **Required, max creation + 14 days** (validated client + server). After the deadline, the code can't be joined. |

## Data model

### New table `order_groups`
```
id            INTEGER PK autoincrement
season_id     INTEGER NOT NULL → seasons.id
code          TEXT NOT NULL              -- 5-digit string, e.g. "48217"
host_name     TEXT NOT NULL
host_address  TEXT NOT NULL
deadline      TEXT NOT NULL              -- UTC ISO+Z; end-of-Taipei-day of the picked date
status        TEXT NOT NULL DEFAULT 'open'   -- 'open' | 'closed' | 'shipped' | 'cancelled'
created_by    TEXT NOT NULL              -- admin email (NOT a FK, mirrors audit_log rationale)
created_at    TEXT NOT NULL
tracking_no   TEXT                       -- group-level shipment
shipped_at    TEXT
shipped_by    TEXT
```
- **Partial unique index** on `code WHERE status='open'` — at most one *joinable* group per code at a time (same partial-index pattern as `seasons` active-singleton). Codes are reusable after a group leaves `open`.
- Index on `status` for the admin list.

### `orders` — add two nullable columns
```
group_id    INTEGER → order_groups.id   -- NULL for normal standalone orders
group_role  TEXT                        -- 'host' | 'member' | NULL
```
- App-enforced: `group_id` and `group_role` are both set or both NULL.
- Member orders: `group_role='member'`, `shipping=0` (final), `address = host_address` (denormalised at join so existing shipping/label code works), customer's own `name`+`phone` retained to identify whose goods.
- Host order: `group_role='host'`, `address = host_address`, `shipping` provisional until close.
- Migration is hand-authored DDL (`drizzle/0009_order_groups.sql` — current max is 0008) following the 0003–0008 pattern (drizzle snapshot is frozen at 0002). `CREATE TABLE` + two `ALTER TABLE orders ADD COLUMN` + the partial unique index + the status index. Applied via `wrangler d1 migrations apply <db> --remote` (tracked in `d1_migrations`).

## Flows

### A. Admin starts a group — `/admin/groups/new` + `POST /api/admin/groups/create`
Form: host name, host address, deadline (date picker; default +7 days, max +14), host's items (same picker as 代客建單). On submit, one `env.DB.batch([...])`:
1. Generate a 5-digit code in `10000`–`99999` (no leading-zero ambiguity, always 5 chars) not currently used by any `status='open'` group (retry on the partial-unique collision, max 3, like `nextOrderId`).
2. Insert `order_groups` (status='open').
3. Insert the host order via the existing admin order path (`group_id`, `group_role='host'`, `address=host_address`, `shipping=0`/`total=subtotal` provisional), decrementing stock through the normal `tryDecrementGroupStock` flow.
4. Audit `group_created`.

Server validates: deadline is a valid date, `deadline ≤ created_at + 14 days`, host name/address non-empty, host items non-empty + in stock.

### B. Customer joins — `/order` + `POST /api/orders` (extended)
- The order form gains an optional **「併單代碼（5 位數字）」** input.
- New optional request field `group_code`. When present and non-empty:
  - Look up an `open` group with that code where `now < deadline`. Not found / closed / past deadline → `error_code: "GROUP_INVALID"` (client shows 「併單代碼無效或已截止」).
  - On success: set `group_id`, `group_role='member'`, `shipping=0` (skip `computeShipping` entirely), `address = group.host_address` (server-authoritative; client's address field is hidden and ignored).
  - Client UX: when a valid 5-digit code is entered, hide the address field, show shipping as **$0**, and show 「✓ 併單：{host_name}（截止 {date}）」.
- No `group_code` → unchanged standalone order (own address, normal shipping). The whole existing idempotency / stock / order_id-retry pipeline is reused untouched except for the four stamped fields.

### C. Shipping computation
- `computeGroupShipping(orders, config)` (pure): `computeShipping(Σ totalFenOf(eachOrder), config)`. Returns the single TWD fee borne by the host.
- Members: `shipping=0` always (final at order time).
- Host: created with provisional `shipping=0`; on **close**, recompute `computeGroupShipping(all non-cancelled group orders, season config)` and `UPDATE orders SET shipping=?, total=subtotal+? WHERE order_id=<host>`. While `status='open'`, the host order shows 「運費待截止結算」.

### D. Admin manages / ships — `/admin/groups` (list) + `/admin/groups/[id]` (detail)
- Detail shows: code, deadline, status, host, every member order (name / items / paid / unpaid), combined 斤, and the (post-close) host fee.
- **Close** (`POST .../close`): only from `open`; finalise host shipping (step C), set `status='closed'`. Joining is blocked once closed (or once past deadline).
- **Ship** (`POST .../ship`): from `closed`; record one `tracking_no`, set every group order `shipped=1` + the group `status='shipped'`, in one batch — reuse the existing `bulk_mark_shipped` invariant (`paid=1 AND shipped=0 AND cancelled_at IS NULL`). Per-person **picking/packing list** prints each order's items separately (區分誰的貨).
- **Cancel group** (`POST .../cancel`): soft-cancel every group order (existing per-order cancel: `cancelled_at` + stock restore via `restoreGroupStock`), set `status='cancelled'`.

## Edge cases
- Deadline passed → join blocked (`GROUP_INVALID`); admin can still close/ship.
- Host required, group can't be empty (host order always exists).
- Code reuse: only unique among `open` groups; closed/shipped/cancelled free the code.
- Members may pay their own goods anytime (their `total` is final, shipping $0). Host pays after close (total final then).
- Two customers joining at the same second near the deadline: both read `open` + `now<deadline` then insert — acceptable last-write race for a small shop; no hard lock.
- Cancelling one member mid-group: existing per-order cancel restores that member's stock; close-time host-shipping recompute naturally excludes cancelled orders.
- Flat-config season (current prod): combined weight is irrelevant, host simply pays one `fee_twd`.

## Testing
- **Pure units** (no env): code-format/validity check; deadline ≤+14-days validator; `computeGroupShipping` (flat → one fee; threshold over → $0; threshold under → fee; cancelled orders excluded); member shipping always 0.
- **Integration (stage)**, following `tests/admin-idempotency.test.ts` + `tests/save-endpoint.test.ts`: admin creates a group (code returned) → two customers order with the code (shipping 0, address=host) → invalid/expired code rejected → close finalises host fee on combined weight → ship marks all group orders shipped with one tracking_no → cancel restores stock. Test data uses `test-`/`TEST-` prefixes; `cleanupTestData` extended to delete `order_groups` for test seasons.

## Out of scope (YAGNI)
Customer-initiated groups, host self-service login, online per-member settlement/split payment, cross-season groups, QR codes for the join code, editing a member's items after join (use existing per-order edit).
