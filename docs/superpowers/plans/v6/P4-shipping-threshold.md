# P4 — 門檻運費（斤數）實作計畫

> 模組：門檻運費（spec §5.5，決策摘要 §3、跨切面 §6、測試 §7）。
> 依賴：**P3**（`seasons.shipping_config TEXT` 欄位 + Drizzle schema 欄位 `shipping_config` + 遷移已套到 stage/prod）。
> 本計畫**不碰** intake API、`products/batch.ts`、`orders.shipping` 快照語意、稽核 `group_stock_change` 路徑。

---

## 0. 背景與本模組契約（零 context 工程師必讀）

### 0.1 現況（已 Read 確認）
- `shippingFor(items: Array<{ qty: number }>, env: AppEnv): number` 在 `src/lib/order-response.ts:47-52`。
  目前邏輯：`totalQty = Σ qty`；`fee = parseInt(env.SHIPPING_FEE_TWD,10) || 150`；回 `totalQty > 0 ? fee : 0`。
- **3 個呼叫點**（全部傳 `body.items`，型別含 `{ sku, qty }`，多帶的欄位無害）：
  - `src/pages/api/orders.ts:125` → `const shipping = shippingFor(body.items, env);`
  - `src/pages/api/admin/orders.ts:86` → `const shipping = shippingFor(body.items, env);`
  - `src/pages/api/admin/orders/[id]/save.ts:321` → `newShipping = shippingFor(body.items!, env);`
- 三個呼叫點在呼叫 `shippingFor` **之前**都已經呼叫過 `resolveItemsForStock(env, body.items)`，拿到 `resolved.resolved`（每項含 `package_fen`、`qty`），所以「總斤數 totalFen = Σ(package_fen × qty)」可由 `resolved.resolved` 直接算出，**不需要再查一次 DB**。
- `src/lib/site-settings.ts:88-89` 目前 `shipping_fee_twd: parseInt(env.SHIPPING_FEE_TWD,10)||150`、`free_shipping_min_packages: parseInt(env.FREE_SHIPPING_MIN_PACKAGES,10)||10`。
- 前端：
  - `src/pages/order.astro`：frontmatter `const shipFee = settings.shipping_fee_twd;`（:12）；表單 `data-ship-fee={shipFee}`（:53）；客戶端 script `const shipFee = Number(form.dataset.shipFee ?? 150);`（:309）、`const shipping = totalQty > 0 ? shipFee : 0;`（:338）。每列 qty input 目前帶 `data-sku`、`data-price`，**沒帶 `data-package-fen`**（:116-117）。
  - `src/pages/admin/orders/[id].astro`：客戶端 script 預覽 `const shipping = totalQty > 0 ? shippingFeeTwd : 0;`（:408-410），`shippingFeeTwd` 來自 SSR `is:inline application/json` island `#v5-order-state`（:887-893，欄位 `shippingFeeTwd`）。`productsList`（:354-356，來自 `data-products`，型別 `ProductInfo` :330-336，**目前無 `package_fen`**）。
  - `src/pages/products.astro:46`：FAQ「每筆訂單運費 ${settings.shipping_fee_twd} 元。」
- `AppEnv`（`src/db/client.ts:4-29`）仍有 `SHIPPING_FEE_TWD`、`FREE_SHIPPING_MIN_PACKAGES`（**本計畫不刪 env 欄位**，只是不再讓運費計算依賴它；移除 env 欄位有 deploy.mjs/wrangler.jsonc 連動，超出本模組範圍）。

### 0.2 `shipping_config` JSON 契約（全 V6 模組一致，務必照用）
存在 `seasons.shipping_config`（TEXT，P3 提供，DB 預設 `'{"type":"flat","fee_twd":150}'`）。兩種形狀：
```jsonc
{ "type": "flat", "fee_twd": 150 }
// 任何件數 (totalFen>0) 都收 fee_twd 元；0 件收 0。

{ "type": "threshold_jin", "free_over_fen": 1000, "fee_twd": 150 }
// 訂單總重量 totalFen >= free_over_fen → 免運（0）；否則收 fee_twd 元；0 件收 0。
// free_over_fen 單位 fen（1 斤 = 100 fen）。1000 = 滿 10 斤免運。
```
**單位**：`free_over_fen`、`totalFen` 都是 fen（整數）。`fee_twd` 是台幣整數元。

### 0.3 設計決策：把純計算抽到新檔 `src/lib/shipping.ts`
spec §7 要求「純單元（無 env）：`shippingFor()` 門檻計算」。但現行 `shippingFor` 簽章吃 `env`，不利純單元測試，且新邏輯需要解析/驗證 JSON。故：
- 新檔 `src/lib/shipping.ts` 放兩個**純函式**（不吃 env、不查 DB）：
  - `parseShippingConfig(raw: string | null): ShippingConfig` — 解析 + 容錯（壞 JSON / 缺欄位 → 回退 flat 150）。
  - `computeShipping(totalFen: number, config: ShippingConfig): number` — 依 config 算運費。**這是 spec 要的純單元測試主體**。
  - 另含 `totalFenOf(items: Array<{ package_fen: number; qty: number }>): number`（Σ package_fen×qty，前後端共用語意；後端用 resolved items，前端用 dataset）。
- `shippingFor`（保留在 `order-response.ts`，維持「後端權威入口」語意）改為**薄轉接**：`shippingFor(resolvedItems, config)` → `computeShipping(totalFenOf(resolvedItems), config)`。簽章從 `(items:{qty}[], env)` 改為 `(items:{package_fen,qty}[], config: ShippingConfig)`。
- active season 的 `shipping_config` 由各後端呼叫點查出（已有 active-season 查詢，順手多 select 一欄）並 `parseShippingConfig` 後傳入。

> **為何不在 `shippingFor` 內查 DB**：三個呼叫點都已查過 active season（orders.ts:148-153、admin/orders.ts:103-108、save.ts 用 `order.season_id`），重複查浪費；且純函式才好測。

### 0.4 共用契約對照（本計畫使用）
- 新 audit action：**`shipping_config_change`**（設定畫面儲存運費時寫；details JSON）。
- 授權：設定運費的 mutation API 走 `authorizeAdmin()`（`src/lib/admin-api.ts`）+ `requireSameOrigin()`（`src/lib/csrf.ts`）。
- 時間戳 UTC ISO-8601（Z）。

### 0.5 設定畫面歸屬（重要的範圍切割）
spec §5.5：「設定畫面：運費設定區放在**季節管理頁的當季區塊**」。季節管理頁 `src/pages/admin/seasons/index.astro` 由 **P5（季節管理，spec §5.1）** 建立，本 P4 **不建立該頁**。
本 P4 只負責：
1. 後端 `PATCH /api/admin/seasons/[id]/shipping-config`（改 active/任一季的 `shipping_config` + audit `shipping_config_change`）—— 這支 API 是運費模組的權威寫入點，季節頁只是 UI 呼叫它。
2. 前後端**下單運費計算**全面改用 `shipping_config`。
3. 前端**運費行/FAQ 文案**改為門檻說明。

> open concern（見文末）：若 P5 尚未產出季節頁，P4 的 shipping-config API 已可被 `curl`/測試直接驗證，UI 串接由 P5 完成。本計畫提供 API + 一個最小可用的「當季運費設定」HTML 片段範例供 P5 內嵌，但**不**新增季節頁檔案。

---

## 1. Task 總覽（依 TDD 順序）

| # | Task | 類型 | 主要檔案 |
|---|---|---|---|
| 1 | 純計算核心 `src/lib/shipping.ts` + 純單元測試 | 純單元 TDD | `tests/shipping.test.ts`、`src/lib/shipping.ts` |
| 2 | 改造 `shippingFor()` 簽章 + 純測試 | 純單元 TDD | `tests/order-response-shipping.test.ts`、`src/lib/order-response.ts` |
| 3 | 串接 3 個後端呼叫點讀 `shipping_config` | 實作（型別驗證） | `orders.ts`、`admin/orders.ts`、`save.ts` |
| 4 | `loadSiteSettings` 從 active season 讀 `shipping_config` | 實作 | `site-settings.ts`、`types.ts`、`db/client.ts`(型別) |
| 5 | `PATCH /api/admin/seasons/[id]/shipping-config` + 整合測試 | 整合 TDD | `tests/shipping-config-endpoint.test.ts`、新 API 檔 |
| 6 | 前端 `order.astro` 帶 `data-package-fen` + JSON island + 預覽算斤 | 實作 | `order.astro` |
| 7 | 前端 `admin/orders/[id].astro` 帶 `package_fen` + 預覽算斤 | 實作 | `[id].astro` |
| 8 | 文案：`products.astro` FAQ + `order.astro` 運費行 | 實作 | `products.astro`、`order.astro` |
| 9 | 端到端整合測試（下單後 `orders.shipping` 符合 flat / threshold） | 整合 TDD | `tests/shipping-e2e.test.ts` |
| 10 | 全量驗證 + 收尾 commit | 驗證 | — |

每個 Task 結尾都 commit。純單元測試（Task 1/2）**不需** stage env；Task 5/9 需 stage env（見 §測試慣例）。

---

## Task 1 — 純計算核心 `src/lib/shipping.ts`

**Files**
- Create test: `tests/shipping.test.ts`
- Create: `src/lib/shipping.ts`

### 1a. 先寫失敗測試
- [ ] 建立 `tests/shipping.test.ts`，完整內容：

```ts
// Pure unit tests for src/lib/shipping.ts — no env / no D1 / no network.
// Covers spec §5.5 shipping-config math: flat / threshold_jin / 0 件 / 剛好門檻 / 邊界.
import { describe, expect, it } from "bun:test";
import {
  parseShippingConfig,
  computeShipping,
  totalFenOf,
  DEFAULT_SHIPPING_CONFIG,
  type ShippingConfig,
} from "../src/lib/shipping";

describe("parseShippingConfig", () => {
  it("parses a valid flat config", () => {
    const c = parseShippingConfig('{"type":"flat","fee_twd":150}');
    expect(c).toEqual({ type: "flat", fee_twd: 150 });
  });

  it("parses a valid threshold_jin config", () => {
    const c = parseShippingConfig('{"type":"threshold_jin","free_over_fen":1000,"fee_twd":150}');
    expect(c).toEqual({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });
  });

  it("falls back to DEFAULT for null", () => {
    expect(parseShippingConfig(null)).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT for empty string", () => {
    expect(parseShippingConfig("")).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT for malformed JSON", () => {
    expect(parseShippingConfig("{not json")).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT for unknown type", () => {
    expect(parseShippingConfig('{"type":"tiered","fee_twd":150}')).toEqual(
      DEFAULT_SHIPPING_CONFIG,
    );
  });

  it("falls back to DEFAULT when flat is missing fee_twd", () => {
    expect(parseShippingConfig('{"type":"flat"}')).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT when threshold_jin is missing free_over_fen", () => {
    expect(parseShippingConfig('{"type":"threshold_jin","fee_twd":150}')).toEqual(
      DEFAULT_SHIPPING_CONFIG,
    );
  });

  it("falls back to DEFAULT when fee_twd is negative", () => {
    expect(parseShippingConfig('{"type":"flat","fee_twd":-5}')).toEqual(
      DEFAULT_SHIPPING_CONFIG,
    );
  });

  it("falls back to DEFAULT when free_over_fen is not a positive integer", () => {
    expect(
      parseShippingConfig('{"type":"threshold_jin","free_over_fen":0,"fee_twd":150}'),
    ).toEqual(DEFAULT_SHIPPING_CONFIG);
    expect(
      parseShippingConfig('{"type":"threshold_jin","free_over_fen":12.5,"fee_twd":150}'),
    ).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("coerces fee_twd=0 (free shipping) as a valid flat config", () => {
    expect(parseShippingConfig('{"type":"flat","fee_twd":0}')).toEqual({
      type: "flat",
      fee_twd: 0,
    });
  });
});

describe("totalFenOf", () => {
  it("sums package_fen × qty across items", () => {
    expect(
      totalFenOf([
        { package_fen: 100, qty: 3 }, // 3 斤
        { package_fen: 50, qty: 2 }, // 1 斤
      ]),
    ).toBe(400);
  });

  it("returns 0 for empty items", () => {
    expect(totalFenOf([])).toBe(0);
  });

  it("ignores non-positive qty defensively", () => {
    expect(totalFenOf([{ package_fen: 100, qty: 0 }])).toBe(0);
  });
});

describe("computeShipping — flat", () => {
  const flat: ShippingConfig = { type: "flat", fee_twd: 150 };

  it("charges fee_twd when totalFen > 0", () => {
    expect(computeShipping(100, flat)).toBe(150);
  });

  it("charges 0 when totalFen === 0", () => {
    expect(computeShipping(0, flat)).toBe(0);
  });

  it("flat with fee_twd=0 always 0", () => {
    expect(computeShipping(500, { type: "flat", fee_twd: 0 })).toBe(0);
  });
});

describe("computeShipping — threshold_jin", () => {
  const thr: ShippingConfig = {
    type: "threshold_jin",
    free_over_fen: 1000, // 滿 10 斤免運
    fee_twd: 150,
  };

  it("charges fee_twd below threshold", () => {
    expect(computeShipping(500, thr)).toBe(150); // 5 斤
  });

  it("免運 exactly at threshold (>= 邊界)", () => {
    expect(computeShipping(1000, thr)).toBe(0); // 剛好 10 斤
  });

  it("免運 above threshold", () => {
    expect(computeShipping(1500, thr)).toBe(0); // 15 斤
  });

  it("1 fen below threshold still charges", () => {
    expect(computeShipping(999, thr)).toBe(150);
  });

  it("0 件 (totalFen=0) charges 0 even under threshold", () => {
    expect(computeShipping(0, thr)).toBe(0);
  });
});
```

- [ ] 跑驗證（預期 FAIL：模組不存在）：

```bash
bun test tests/shipping.test.ts
```

預期輸出含（因 `src/lib/shipping.ts` 尚未建立）：
```
error: Cannot find module '.../src/lib/shipping' from '.../tests/shipping.test.ts'
```
（bun 會回 `1 fail` 或載入錯誤；重點是**不是綠燈**。）

### 1b. 最小實作
- [ ] 建立 `src/lib/shipping.ts`，完整內容：

```ts
// Pure shipping-fee computation for V6 threshold shipping (spec §5.5).
// No env, no DB — fed a parsed ShippingConfig + a totalFen (Σ package_fen×qty).
//
// Unit convention: free_over_fen and totalFen are in `fen` (1 斤 = 100 fen),
// matching the stock model. fee_twd is integer New Taiwan Dollars.
//
// shipping_config JSON lives on seasons.shipping_config (added in P3). Two shapes:
//   { "type":"flat", "fee_twd":150 }
//   { "type":"threshold_jin", "free_over_fen":1000, "fee_twd":150 }

export type ShippingConfig =
  | { type: "flat"; fee_twd: number }
  | { type: "threshold_jin"; free_over_fen: number; fee_twd: number };

// Equals the DB-level default on seasons.shipping_config (P3). Used as the
// fallback whenever a season's config is null / malformed so customer orders
// never break on a bad config — they degrade to the legacy NT$150 flat fee.
export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = { type: "flat", fee_twd: 150 };

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// Parse seasons.shipping_config (string | null) into a validated ShippingConfig.
// ANY validation failure returns DEFAULT_SHIPPING_CONFIG (fail-safe, never throws).
export function parseShippingConfig(raw: string | null | undefined): ShippingConfig {
  if (!raw) return DEFAULT_SHIPPING_CONFIG;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return DEFAULT_SHIPPING_CONFIG;
  }
  if (typeof obj !== "object" || obj === null) return DEFAULT_SHIPPING_CONFIG;
  const o = obj as Record<string, unknown>;
  if (o.type === "flat") {
    if (!isNonNegativeInt(o.fee_twd)) return DEFAULT_SHIPPING_CONFIG;
    return { type: "flat", fee_twd: o.fee_twd };
  }
  if (o.type === "threshold_jin") {
    if (!isPositiveInt(o.free_over_fen)) return DEFAULT_SHIPPING_CONFIG;
    if (!isNonNegativeInt(o.fee_twd)) return DEFAULT_SHIPPING_CONFIG;
    return {
      type: "threshold_jin",
      free_over_fen: o.free_over_fen,
      fee_twd: o.fee_twd,
    };
  }
  return DEFAULT_SHIPPING_CONFIG;
}

// Total order weight in fen = Σ(package_fen × qty). Defensive against non-positive qty.
export function totalFenOf(
  items: Array<{ package_fen: number; qty: number }>,
): number {
  let fen = 0;
  for (const it of items) {
    if (it.qty > 0) fen += it.package_fen * it.qty;
  }
  return fen;
}

// Compute shipping fee (TWD) for a given total weight (fen) under a config.
// Empty order (totalFen <= 0) is always 0.
export function computeShipping(totalFen: number, config: ShippingConfig): number {
  if (totalFen <= 0) return 0;
  if (config.type === "flat") return config.fee_twd;
  // threshold_jin
  return totalFen >= config.free_over_fen ? 0 : config.fee_twd;
}
```

- [ ] 跑驗證（預期 PASS）：

```bash
bun test tests/shipping.test.ts
```

預期輸出（綠燈，全數通過；數量以實際為準）：
```
 ✓ parseShippingConfig > parses a valid flat config
 ...
 ✓ computeShipping — threshold_jin > 0 件 (totalFen=0) charges 0 even under threshold

 <N> pass
 0 fail
```

### 1c. commit
- [ ] commit：

```bash
git add src/lib/shipping.ts tests/shipping.test.ts
git commit -m "feat(shipping): pure threshold-shipping core (parse/compute/totalFen) + unit tests

P4 §5.5: computeShipping(totalFen, config) supports flat + threshold_jin.
parseShippingConfig fail-safes to NT\$150 flat on malformed config.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — 改造 `shippingFor()` 簽章

**Files**
- Create test: `tests/order-response-shipping.test.ts`
- Modify: `src/lib/order-response.ts:1-2`（import）、`:47-52`（函式本體）

### 2a. 先寫失敗測試
- [ ] 建立 `tests/order-response-shipping.test.ts`，完整內容：

```ts
// Pure unit test for the new shippingFor() adapter signature.
// shippingFor now takes resolved items (with package_fen) + a parsed ShippingConfig,
// delegating math to src/lib/shipping.ts. No env required.
import { describe, expect, it } from "bun:test";
import { shippingFor } from "../src/lib/order-response";
import type { ShippingConfig } from "../src/lib/shipping";

const flat: ShippingConfig = { type: "flat", fee_twd: 150 };
const thr: ShippingConfig = { type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 };

describe("shippingFor (V6 adapter)", () => {
  it("flat: charges fee for any non-empty order", () => {
    expect(shippingFor([{ package_fen: 50, qty: 1 }], flat)).toBe(150);
  });

  it("flat: 0 for empty items", () => {
    expect(shippingFor([], flat)).toBe(0);
  });

  it("threshold: aggregates package_fen×qty across mixed package sizes", () => {
    // 1斤×9 + 半斤×2 = 900 + 100 = 1000 fen → exactly 10 斤 → 免運
    expect(
      shippingFor(
        [
          { package_fen: 100, qty: 9 },
          { package_fen: 50, qty: 2 },
        ],
        thr,
      ),
    ).toBe(0);
  });

  it("threshold: below threshold charges fee", () => {
    // 1斤×9 = 900 fen < 1000 → 收 150
    expect(shippingFor([{ package_fen: 100, qty: 9 }], thr)).toBe(150);
  });
});
```

- [ ] 跑驗證（預期 FAIL：簽章仍是舊的 `(items, env)`，傳 config 進去型別/行為不符；舊版會把 config 當成 env 讀 `env.SHIPPING_FEE_TWD` → `undefined` → `|| 150`，且少了 package_fen 加總，threshold 案例會錯）：

```bash
bun test tests/order-response-shipping.test.ts
```

預期輸出（紅燈，至少 threshold 案例 fail，例如）：
```
 ✗ shippingFor (V6 adapter) > threshold: aggregates package_fen×qty ...
   expected 0, received 150
 <x> fail
```
（precise 失敗訊息依舊邏輯而定；重點是**非全綠**。）

### 2b. 最小實作
- [ ] 修改 `src/lib/order-response.ts` 的 import 區（第 1-3 行附近），新增 shipping import。把第 1-3 行：

```ts
import type { AppEnv } from "../db/client";
import type { Order, OrderItem, Product } from "../db/schema";
import { buildLiffBindUrl } from "./line";
```

改為：

```ts
import type { AppEnv } from "../db/client";
import type { Order, OrderItem, Product } from "../db/schema";
import { buildLiffBindUrl } from "./line";
import { computeShipping, totalFenOf, type ShippingConfig } from "./shipping";
```

- [ ] 替換 `shippingFor`（目前 `:47-52`）整段：

把：

```ts
export function shippingFor(items: Array<{ qty: number }>, env: AppEnv): number {
  // Flat shipping fee per order — no free-shipping threshold (policy: 運費一律收取).
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const fee = parseInt(env.SHIPPING_FEE_TWD, 10) || 150;
  return totalQty > 0 ? fee : 0;
}
```

改為：

```ts
// V6 (spec §5.5): shipping is computed from total order weight (Σ package_fen×qty)
// against the active season's shipping_config (flat | threshold_jin). Callers resolve
// items via resolveItemsForStock() FIRST (which yields package_fen per item) and parse
// the season's shipping_config via parseShippingConfig() — this stays a pure adapter so
// it's unit-testable and never re-queries the DB.
export function shippingFor(
  items: Array<{ package_fen: number; qty: number }>,
  config: ShippingConfig,
): number {
  return computeShipping(totalFenOf(items), config);
}
```

> 註：`AppEnv` 仍被本檔其他函式（`assembleOrderSuccess`）使用，import 保留。

- [ ] 跑驗證（預期 PASS）：

```bash
bun test tests/order-response-shipping.test.ts
```

預期輸出（綠燈）：
```
 ✓ shippingFor (V6 adapter) > flat: charges fee for any non-empty order
 ✓ shippingFor (V6 adapter) > threshold: aggregates package_fen×qty ...
 4 pass
 0 fail
```

> 此時 3 個呼叫點（orders.ts:125 等）仍用舊簽章 `shippingFor(body.items, env)` → **型別檢查會壞**。下一步（Task 3）修。為避免中途 commit 壞掉的 build，**Task 2 與 Task 3 合併在同一個 commit**（先不 commit，直接做 Task 3）。

### 2c.（暫不 commit）
- [ ] 跳到 Task 3，完成 3 個呼叫點後一起 commit。

---

## Task 3 — 串接 3 個後端呼叫點讀 `shipping_config`

**Files**
- Modify: `src/pages/api/orders.ts:4`(import seasons select 已含)、`:148-153`(active season 查詢加 shipping_config)、`:125`(呼叫)
- Modify: `src/pages/api/admin/orders.ts:103-108`(active season 查詢加 shipping_config)、`:86`(呼叫)
- Modify: `src/pages/api/admin/orders/[id]/save.ts:9`(import seasons)、`:321`(呼叫，並查 order 所屬 season 的 config)

### 3a.（customer）`src/pages/api/orders.ts`
現況：第 110 行 `resolveItemsForStock` 已執行；第 125 行 `const shipping = shippingFor(body.items, env);`；active season 在第 148-153 行才查（在 shipping 計算之後）。需把 active season 查詢**提前**，或在第 125 行前查到 `shipping_config`。最小改法：把 active-season 查詢提前到第 125 行之前並多 select `shipping_config`，第 153 行的 `seasonId` 改用同一筆。

- [ ] 在檔頭 import 區（第 1-23 行），於既有 `import { ... } from "../../lib/order-response";` 之後新增 shipping import。把 orders.ts 第 7-12 行：

```ts
import {
  assembleOrderSuccess,
  expectedMemoFor,
  shippingFor,
  type OrderResponse,
} from "../../lib/order-response";
```

改為：

```ts
import {
  assembleOrderSuccess,
  expectedMemoFor,
  shippingFor,
  type OrderResponse,
} from "../../lib/order-response";
import { parseShippingConfig } from "../../lib/shipping";
```

- [ ] 將第 120-126 行（totals 計算區塊）：

```ts
  // 4) Compute totals from resolved snapshot (price taken at this moment).
  let subtotal = 0;
  for (const r of resolved.resolved) {
    subtotal += r.price * r.qty;
  }
  const shipping = shippingFor(body.items, env);
  const total = subtotal + shipping;
```

改為（先查 active season 拿 id + shipping_config，再算運費）：

```ts
  // 4) Look up active season (id + shipping_config) ONCE — used for both the
  //    season_id stamp on the order and the V6 shipping computation.
  const seasonRow = await db
    .select({ id: seasons.id, shipping_config: seasons.shipping_config })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;
  const shippingConfig = parseShippingConfig(seasonRow[0]?.shipping_config ?? null);

  // 5) Compute totals from resolved snapshot (price taken at this moment).
  //    Shipping uses resolved items' package_fen (Σ package_fen×qty) + the season config.
  let subtotal = 0;
  for (const r of resolved.resolved) {
    subtotal += r.price * r.qty;
  }
  const shipping = shippingFor(resolved.resolved, shippingConfig);
  const total = subtotal + shipping;
```

- [ ] 刪除原本第 146-153 行重複的 active-season 查詢（已被上面取代）。原文：

```ts
  // 7) Look up active season id (orders.season_id is FK; defaulted at DB level for
  // migration safety but we set it explicitly here).
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;
```

→ **整段刪除**（`seasonRow` / `seasonId` 已在上面宣告；保留其後的註解步驟編號可不調整，無功能影響）。

> 注意：刪除後，原第 128-144 行的「5)/6)」步驟註解與新加的「4)/5)」編號會稍有重複，**功能無關**，可不理會；若想整齊可順手把後續 step 註解編號 +1，但非必要。

### 3b.（admin relay）`src/pages/api/admin/orders.ts`
現況：第 73 行 `resolveItemsForStock`；第 86 行 `shippingFor(body.items, env)`；active season 在第 103-108 行查。同樣把查詢提前並多 select config。

- [ ] 檔頭 import：把第 7 行：

```ts
import { expectedMemoFor, shippingFor } from "../../../lib/order-response";
```

改為：

```ts
import { expectedMemoFor, shippingFor } from "../../../lib/order-response";
import { parseShippingConfig } from "../../../lib/shipping";
```

- [ ] 將第 81-87 行：

```ts
  // 3) Compute totals from resolved snapshot.
  let subtotal = 0;
  for (const r of resolved.resolved) {
    subtotal += r.price * r.qty;
  }
  const shipping = shippingFor(body.items, env);
  const total = subtotal + shipping;
```

改為：

```ts
  // 3) Look up active season (id + shipping_config) ONCE.
  const seasonRow = await db
    .select({ id: seasons.id, shipping_config: seasons.shipping_config })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;
  const shippingConfig = parseShippingConfig(seasonRow[0]?.shipping_config ?? null);

  // 4) Compute totals from resolved snapshot.
  let subtotal = 0;
  for (const r of resolved.resolved) {
    subtotal += r.price * r.qty;
  }
  const shipping = shippingFor(resolved.resolved, shippingConfig);
  const total = subtotal + shipping;
```

- [ ] 刪除原本第 102-108 行重複的查詢：

```ts
  // 6) Look up active season id.
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;
```

→ **整段刪除**（已在上面宣告 `seasonRow`/`seasonId`）。

### 3c.（admin save）`src/pages/api/admin/orders/[id]/save.ts`
現況：第 20 行 import `shippingFor`；第 321 行 `newShipping = shippingFor(body.items!, env);`；此處有 `order.season_id`（非「active」season，而是該訂單所屬 season——運費以**訂單所屬季**的 config 為準，符合「編輯既有訂單」語意）。`resolvedNew.resolved` 已有 package_fen。

- [ ] 檔頭：`seasons` 已在 import（第 4-10 行的 schema import 含 `seasons`）。確認後新增 shipping import。把第 20-22 行：

```ts
import { shippingFor } from "../../../../../lib/order-response";
import { compareItemsHash } from "../../../../../lib/items-hash";
import { env } from "../../../../../lib/env";
```

改為：

```ts
import { shippingFor } from "../../../../../lib/order-response";
import { parseShippingConfig } from "../../../../../lib/shipping";
import { compareItemsHash } from "../../../../../lib/items-hash";
import { env } from "../../../../../lib/env";
```

- [ ] 在 Step 5 區塊內、`wantsItemsEdit` 為真且 `itemsChanged` 為真時計算 `newShipping` 之處（第 314-322 行）改用 config。原文：

```ts
    if (itemsChanged) {
      // Recompute money: kept SKUs reuse existing unit_price; new/changed reuse new price.
      newSubtotal = resolvedNew.resolved.reduce((s, r) => {
        const ex = existingBySku.get(r.sku);
        const unit = ex ? ex.unit_price : r.price;
        return s + unit * r.qty;
      }, 0);
      newShipping = shippingFor(body.items!, env);
      newTotal = newSubtotal + newShipping;
```

改為（在計算前查該訂單所屬 season 的 shipping_config）：

```ts
    if (itemsChanged) {
      // Recompute money: kept SKUs reuse existing unit_price; new/changed reuse new price.
      newSubtotal = resolvedNew.resolved.reduce((s, r) => {
        const ex = existingBySku.get(r.sku);
        const unit = ex ? ex.unit_price : r.price;
        return s + unit * r.qty;
      }, 0);
      // V6: shipping recompute uses THIS order's season shipping_config (not "active"),
      // matching edit semantics — an order edited after season rollover keeps its own
      // season's policy. resolvedNew.resolved carries package_fen for the weight sum.
      const seasonRow = order.season_id
        ? await db
            .select({ shipping_config: seasons.shipping_config })
            .from(seasons)
            .where(eq(seasons.id, order.season_id))
            .limit(1)
        : [];
      const shippingConfig = parseShippingConfig(seasonRow[0]?.shipping_config ?? null);
      newShipping = shippingFor(resolvedNew.resolved, shippingConfig);
      newTotal = newSubtotal + newShipping;
```

> `eq` 已在 save.ts 第 2 行 import。`seasons` 已在第 4-10 行 import。

### 3d. 驗證（型別 + 既有測試不退步）
- [ ] 型別檢查（這會編譯整個 repo；預期通過，無 `shippingFor` 簽章不符）：

```bash
bun run build
```

預期：build 成功（`astro check` 無 error）。若出現 `Argument of type ... is not assignable to parameter of type 'ShippingConfig'`，回頭檢查是否有遺漏的 `shippingFor` 呼叫點傳了舊參數。

- [ ] 跑既有純單元測試確認未退步：

```bash
bun test tests/shipping.test.ts tests/order-response-shipping.test.ts tests/stock-helper.test.ts tests/items-hash.test.ts
```

預期：全綠。

### 3e. commit（合併 Task 2 + 3）
- [ ] commit：

```bash
git add src/lib/order-response.ts tests/order-response-shipping.test.ts \
        src/pages/api/orders.ts src/pages/api/admin/orders.ts \
        src/pages/api/admin/orders/[id]/save.ts
git commit -m "feat(shipping): shippingFor reads season shipping_config (Σ package_fen×qty)

P4 §5.5: shippingFor now takes resolved items + parsed ShippingConfig.
Customer/admin/save order paths read seasons.shipping_config (active season for
new orders; the order's own season for edits) instead of env.SHIPPING_FEE_TWD.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — `loadSiteSettings` 從 active season 讀 `shipping_config`

目的：前端 `order.astro` / `products.astro` 需要 active season 的運費設定來渲染（文案 + JSON island）。`loadSiteSettings` 是這些頁的唯一資料來源。

**Files**
- Modify: `src/lib/site-settings.ts:16`(import seasons 已含)、`:18-42`(SiteSettings interface)、`:44-94`(query + return)
- Modify: `src/lib/types.ts:24-32`(SiteSettings interface 鏡像)

### 4a. 擴充 `SiteSettings` 型別（site-settings.ts 本地 interface）
- [ ] 在 `src/lib/site-settings.ts` 檔頭新增 shipping import。把第 14-16 行：

```ts
import { and, asc, eq } from "drizzle-orm";
import { makeDb, type AppEnv } from "../db/client";
import { products, product_groups, seasons } from "../db/schema";
```

改為：

```ts
import { and, asc, eq } from "drizzle-orm";
import { makeDb, type AppEnv } from "../db/client";
import { products, product_groups, seasons } from "../db/schema";
import { parseShippingConfig, computeShipping, type ShippingConfig } from "./shipping";
```

> `and` 目前未使用也保留（既有狀態，不在本模組範圍）。

- [ ] 在 `SiteSettings` interface（第 18-42 行）內，於 `shipping_fee_twd` 之後新增 `shipping_config`。把：

```ts
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
  eta_days_after_payment: number;
```

改為：

```ts
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
  // V6 §5.5: active season's parsed shipping policy. Frontend uses this to render
  // the fee line / FAQ and to bake a JSON island for client-side shipping preview.
  // shipping_fee_twd above is kept (legacy field) and now derives from shipping_config.
  shipping_config: ShippingConfig;
  eta_days_after_payment: number;
```

### 4b. 查 active season 的 shipping_config 並回傳
現況：`loadSiteSettings` 的 JOIN（第 49-68 行）已 `innerJoin(seasons, eq(seasons.id, products.season_id)).where(eq(seasons.status,"active"))`，但沒 select `seasons.shipping_config`，且當 active season **沒有任何 product** 時 `productRows` 會是空陣列、拿不到 config。為穩健，**另查一次 active season 的 config**（小規模，無妨）。

- [ ] 在 `loadSiteSettings` 內、`const db = makeDb(env);`（第 45 行）之後、productRows 查詢之前，新增 active-season config 查詢：

把第 44-49 行：

```ts
export async function loadSiteSettings(env: AppEnv): Promise<SiteSettings> {
  const db = makeDb(env);

  // Pull active-season products + their group's pool weight in one JOIN.
  // (Tiny scale — ~5 SKUs in active season — so no caching layer needed.)
  const productRows = await db
```

改為：

```ts
export async function loadSiteSettings(env: AppEnv): Promise<SiteSettings> {
  const db = makeDb(env);

  // V6 §5.5: active season shipping policy. Queried separately so it resolves even when
  // the season has zero products yet (productRows would be empty in that case).
  const activeSeasonRows = await db
    .select({ shipping_config: seasons.shipping_config })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const shippingConfig = parseShippingConfig(activeSeasonRows[0]?.shipping_config ?? null);

  // Pull active-season products + their group's pool weight in one JOIN.
  // (Tiny scale — ~5 SKUs in active season — so no caching layer needed.)
  const productRows = await db
```

- [ ] 修改 return（第 70-93 行）：把 `shipping_fee_twd` 與 `free_shipping_min_packages` 改為由 `shippingConfig` 衍生，並新增 `shipping_config`。把：

```ts
    shipping_fee_twd: parseInt(env.SHIPPING_FEE_TWD, 10) || 150,
    free_shipping_min_packages: parseInt(env.FREE_SHIPPING_MIN_PACKAGES, 10) || 10,
    eta_days_after_payment: parseInt(env.ETA_DAYS_AFTER_PAYMENT, 10) || 5,
    bank_account_display: env.BANK_ACCOUNT_DISPLAY,
    support_line_id: "", // legacy field, kept for V1 client compat
  };
```

改為：

```ts
    // V6: legacy field now derives from shipping_config (the "base" fee charged below
    // threshold / always for flat). Kept so any V1-era client reading it still works.
    shipping_fee_twd: shippingConfig.fee_twd,
    // Legacy field — V6 threshold uses fen (free_over_fen), not package count. For a
    // threshold_jin config we surface the 斤 figure (free_over_fen/100) as a best-effort
    // back-compat value; flat configs report 0 (no threshold). Not used by V6 UI.
    free_shipping_min_packages:
      shippingConfig.type === "threshold_jin"
        ? Math.floor(shippingConfig.free_over_fen / 100)
        : 0,
    shipping_config: shippingConfig,
    eta_days_after_payment: parseInt(env.ETA_DAYS_AFTER_PAYMENT, 10) || 5,
    bank_account_display: env.BANK_ACCOUNT_DISPLAY,
    support_line_id: "", // legacy field, kept for V1 client compat
  };
```

> `computeShipping` 已 import 但此檔暫未直接使用（前端 island 會用到 config 自行算）。若 `astro check` 報「`computeShipping` is declared but never read」，把 import 改成只引入用到的：`import { parseShippingConfig, type ShippingConfig } from "./shipping";`。**先用最小 import** 以免 unused error：

修正 4a 的 import 為（最終版，僅引入實際使用者）：

```ts
import { parseShippingConfig, type ShippingConfig } from "./shipping";
```

### 4c. 鏡像 `src/lib/types.ts` 的 `SiteSettings`
前端 `order.astro` 引用 `loadSiteSettings`（回傳型別來自 site-settings.ts），但 `types.ts` 另有一份 `SiteSettings`（給客戶端 import）。為一致，補上同欄位。

- [ ] 在 `src/lib/types.ts` 檔頭加 shipping type re-export 或 inline。最小改法：inline 一個與 shipping.ts 等價的 union（避免 client bundle 依賴 server lib）。把第 24-32 行：

```ts
export interface SiteSettings {
  accepting_dry: boolean;
  products: Product[];
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
  eta_days_after_payment: number;
  bank_account_display: string;
  support_line_id: string;
}
```

改為：

```ts
// V6 §5.5: mirror of src/lib/shipping.ts ShippingConfig for client-side typing.
// Kept inline (not imported from shipping.ts) so the client bundle doesn't pull server lib.
export type ShippingConfig =
  | { type: "flat"; fee_twd: number }
  | { type: "threshold_jin"; free_over_fen: number; fee_twd: number };

export interface SiteSettings {
  accepting_dry: boolean;
  products: Product[];
  shipping_fee_twd: number;
  free_shipping_min_packages: number;
  shipping_config: ShippingConfig;
  eta_days_after_payment: number;
  bank_account_display: string;
  support_line_id: string;
}
```

### 4d. 驗證
- [ ] 型別檢查：

```bash
bun run build
```

預期：通過。若報 `computeShipping` unused，套用 4b 末的最小 import 修正。

### 4e. commit
- [ ] commit：

```bash
git add src/lib/site-settings.ts src/lib/types.ts
git commit -m "feat(shipping): loadSiteSettings exposes active season shipping_config

P4 §5.5: SiteSettings now carries parsed shipping_config; shipping_fee_twd derives
from it (legacy back-compat). Frontend renders fee line + client preview from this.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — `PATCH /api/admin/seasons/[id]/shipping-config`

運費設定的**權威寫入點**。季節管理頁（P5）會呼叫它；本 P4 提供 API + 整合測試。

**Files**
- Create: `src/pages/api/admin/seasons/[id]/shipping-config.ts`
- Create test: `tests/shipping-config-endpoint.test.ts`

### 5a. 先確認既有 admin-api / csrf 形狀（已 Read `admin-api`/`csrf` 介面）
> 本檔需要 `authorizeAdmin(request, env, "admin")`（回 `{ ok, reason, status, session }`）、`requireSameOrigin(request)`（回 boolean 或 `{ ok }`）、`json()` / `text()` helper。**實作前**先用一個既有 admin mutation 確認簽章，避免杜撰。

- [ ] 確認 helper 簽章（讀現有用法）：

```bash
sed -n '1,60p' src/lib/admin-api.ts
sed -n '1,40p' src/lib/csrf.ts
```

預期看到：`authorizeAdmin(request, env, role?)`、`requireSameOrigin(request)`、`json(body, status)`、`text(msg, status)` 的確切形狀。**若與下方範例不符，以實際簽章為準微調**（這是唯一允許的「依實際 API 調整」處，因為 csrf/admin-api 由其他模組維護）。下方範例採用與 `save.ts`（`authorizeAdmin(request, env, "admin")` + `text(auth.reason, auth.status)`）一致的用法。

### 5b. 先寫失敗測試（整合，需 stage env）
- [ ] 建立 `tests/shipping-config-endpoint.test.ts`，完整內容：

```ts
// Integration: PATCH /api/admin/seasons/[id]/shipping-config (P4 §5.5).
// Requires stage env (see tests/_setup.ts). Seeds a test season, flips its shipping_config,
// asserts the DB row + audit_log shipping_config_change.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedSeason,
  skipIfNoIntegration,
  stageFetch,
  STAGE_URL,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SEASON_CODE = "test-shipcfg-season";

let cookie = "";
let seasonId = 0;

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
  cookie = createTestAdminSession("test-shipcfg@local");
  seasonId = seedSeason({ code: SEASON_CODE, status: "draft" });
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

function readConfig(id: number): string | null {
  const rows = d1Execute(
    `SELECT shipping_config FROM seasons WHERE id = ${id}`,
  ) as Array<{ shipping_config: string | null }>;
  return rows[0]?.shipping_config ?? null;
}

function patchConfig(id: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return stageFetch(`/api/admin/seasons/${id}/shipping-config`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      Origin: STAGE_URL,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH shipping-config", () => {
  it("sets a valid threshold_jin config and writes audit", async () => {
    if (SKIP) return;
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 },
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(readConfig(seasonId)!);
    expect(stored).toEqual({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });

    const audit = d1Execute(
      `SELECT action FROM audit_log WHERE season_id = ${seasonId} AND action = 'shipping_config_change'`,
    ) as Array<{ action: string }>;
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("sets a valid flat config", async () => {
    if (SKIP) return;
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "flat", fee_twd: 200 },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(readConfig(seasonId)!)).toEqual({ type: "flat", fee_twd: 200 });
  });

  it("rejects an invalid config shape (400) and does not mutate", async () => {
    if (SKIP) return;
    const before = readConfig(seasonId);
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "tiered", fee_twd: 150 },
    });
    expect(res.status).toBe(400);
    expect(readConfig(seasonId)).toBe(before);
  });

  it("rejects threshold_jin with non-positive free_over_fen (400)", async () => {
    if (SKIP) return;
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "threshold_jin", free_over_fen: 0, fee_twd: 150 },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-existent season", async () => {
    if (SKIP) return;
    const res = await patchConfig(99999999, {
      shipping_config: { type: "flat", fee_twd: 150 },
    });
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated request (no cookie)", async () => {
    if (SKIP) return;
    const res = await stageFetch(`/api/admin/seasons/${seasonId}/shipping-config`, {
      method: "PATCH",
      headers: { Origin: STAGE_URL },
      body: JSON.stringify({ shipping_config: { type: "flat", fee_twd: 150 } }),
    });
    expect(res.status === 401 || res.status === 403).toBe(true);
  });

  it("rejects cross-origin (CSRF) request", async () => {
    if (SKIP) return;
    const res = await patchConfig(
      seasonId,
      { shipping_config: { type: "flat", fee_twd: 150 } },
      { Origin: "https://evil.example.com" },
    );
    expect(res.status === 403).toBe(true);
  });
});
```

- [ ] 跑驗證（預期 FAIL：endpoint 不存在 → 404 in success cases，或 stage 尚未部署該檔）。前提：需 stage env 已設（`MANGO_STAGE_URL` + `TEST_TOKEN`）：

```bash
bun test tests/shipping-config-endpoint.test.ts
```

預期輸出（紅燈，例如成功案例拿到 404 而非 200）：
```
 ✗ PATCH shipping-config > sets a valid threshold_jin config and writes audit
   expected 200, received 404
```

> 若無 stage env，全部測試 `if (SKIP) return;` 直接 pass（0 實際斷言）——這是預期的 skip 行為，不算驗證成功。實際驗證需在有 stage env 的環境跑，且**該 endpoint 已部署到 stage**（見 Task 9 的部署提醒）。

### 5c. 最小實作
- [ ] 建立 `src/pages/api/admin/seasons/[id]/shipping-config.ts`，完整內容（簽章對齊 save.ts 慣例；若 5a 確認的 helper 形狀不同，依實際微調）：

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { seasons, audit_log } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { requireSameOrigin } from "../../../../../lib/csrf";
import { parseShippingConfig, type ShippingConfig } from "../../../../../lib/shipping";
import { env } from "../../../../../lib/env";

// P4 §5.5: authoritative write point for a season's shipping policy.
// Body: { shipping_config: { type:"flat", fee_twd } | { type:"threshold_jin", free_over_fen, fee_twd } }
// Validates STRICTLY (not via parse fail-safe): an invalid shape is a 400, never silently
// coerced to the default — the admin must see their bad input rejected.
// audit: shipping_config_change with before/after JSON.

interface Body {
  shipping_config?: unknown;
}

// Strict validator (mirrors parseShippingConfig's rules but RETURNS null on failure
// instead of falling back, so the endpoint can 400).
function validateConfig(v: unknown): ShippingConfig | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const feeOk =
    typeof o.fee_twd === "number" && Number.isInteger(o.fee_twd) && o.fee_twd >= 0;
  if (o.type === "flat") {
    return feeOk ? { type: "flat", fee_twd: o.fee_twd as number } : null;
  }
  if (o.type === "threshold_jin") {
    const overOk =
      typeof o.free_over_fen === "number" &&
      Number.isInteger(o.free_over_fen) &&
      o.free_over_fen > 0;
    return feeOk && overOk
      ? {
          type: "threshold_jin",
          free_over_fen: o.free_over_fen as number,
          fee_twd: o.fee_twd as number,
        }
      : null;
  }
  return null;
}

export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);
  if (!requireSameOrigin(request)) return text("forbidden", 403);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return text("bad id", 400);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return text("bad json", 400);
  }

  const config = validateConfig(body.shipping_config);
  if (!config) return text("invalid shipping_config", 400);

  const db = makeDb(env);

  // Read current season + its config (for the 404 check + audit before-value).
  const rows = await db
    .select({ id: seasons.id, shipping_config: seasons.shipping_config })
    .from(seasons)
    .where(eq(seasons.id, id))
    .limit(1);
  const season = rows[0];
  if (!season) return text("not_found", 404);

  const beforeConfig = parseShippingConfig(season.shipping_config ?? null);
  const afterJson = JSON.stringify(config);
  const now = new Date().toISOString();

  // Single atomic batch: UPDATE shipping_config + INSERT audit (shipping_config_change).
  await env.DB.batch([
    env.DB.prepare(`UPDATE seasons SET shipping_config = ? WHERE id = ?`).bind(
      afterJson,
      id,
    ),
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      now,
      auth.session.email,
      "shipping_config_change",
      null,
      id,
      JSON.stringify({ before: beforeConfig, after: config }),
    ),
  ]);

  return json({ ok: true, shipping_config: config });
};
```

> 路徑深度確認：檔在 `src/pages/api/admin/seasons/[id]/shipping-config.ts`，到 `src/db/` 是 `../../../../../db/`（5 層上溯：`[id]`→`seasons`→`admin`→`api`→`pages`→`src`），與 `save.ts`（`src/pages/api/admin/orders/[id]/save.ts`）相同層級，故 import 路徑數量一致。**實作後以 `bun run build` 的模組解析為準**。

### 5d. 驗證
- [ ] 型別 + build：

```bash
bun run build
```

預期：通過。若 import 路徑層數錯，會報 `Cannot find module '../../../../../db/client'` —— 對照 save.ts 的相對路徑修正。

- [ ] （需 stage env 且已部署）跑整合測試：見 Task 9 的「部署到 stage 後統一驗證」。此處先確保 build 綠燈即可 commit。

### 5e. commit
- [ ] commit：

```bash
git add "src/pages/api/admin/seasons/[id]/shipping-config.ts" tests/shipping-config-endpoint.test.ts
git commit -m "feat(shipping): PATCH /api/admin/seasons/[id]/shipping-config + audit

P4 §5.5: authoritative write point for season shipping policy. Strict-validates
flat/threshold_jin, atomic UPDATE+audit (shipping_config_change). Integration tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — 前端 `order.astro`：`data-package-fen` + JSON island + 預覽算斤

目標：客戶端即時運費預覽改用「總斤數 + shipping_config」。把每列 qty input 帶 `data-package-fen`，並用 `is:inline application/json` island 把 active season 的 shipping_config 傳給 bundled script（與 `[id].astro` 的 `#v5-order-state` 同模式）。

**Files**
- Modify: `src/pages/order.astro:12`(frontmatter)、`:53`(form data attr)、`:113-122`(qty input)、`:299-300`(island)、`:307-343`(client compute)

### 6a. frontmatter：取出 shipping_config
- [ ] 把第 12 行：

```ts
const shipFee = settings.shipping_fee_twd;
```

改為：

```ts
const shipFee = settings.shipping_fee_twd;
const shipConfig = settings.shipping_config;
```

### 6b. qty input 帶 `data-package-fen`
- [ ] 把第 113-122 行的 `<input>`（含 `data-sku`/`data-price`）：

```astro
                    <input
                      type="number"
                      name={`qty_${p.sku}`}
                      data-sku={p.sku}
                      data-price={p.price}
                      min="0"
                      max={Math.min(99, p.derived_available_count)}
                      value="0"
                      class="item-qty w-20 border border-mango-300 rounded px-2 py-1 text-center focus:border-mango-500 outline-none"
                    />
```

改為（新增 `data-package-fen`）：

```astro
                    <input
                      type="number"
                      name={`qty_${p.sku}`}
                      data-sku={p.sku}
                      data-price={p.price}
                      data-package-fen={p.package_fen}
                      min="0"
                      max={Math.min(99, p.derived_available_count)}
                      value="0"
                      class="item-qty w-20 border border-mango-300 rounded px-2 py-1 text-center focus:border-mango-500 outline-none"
                    />
```

> `p.package_fen` 已在 `settings.products`（site-settings.ts:84）內可用。

### 6c. 加 JSON island（shipping_config）
- [ ] 在 `</Layout>` 之前（檔尾，現第 300 行 `</Layout>` 上方、`</section>` 之後、`<script>` 區塊之外），新增一個 inline JSON island。具體：在第 300 行 `</Layout>` 前插入：

```astro
  <script
    is:inline
    type="application/json"
    id="ship-config"
    set:html={JSON.stringify(shipConfig)}
  />
```

> 放在 `<script>...</script>`（302-468）之後、`</Layout>`（300→變 301）之前皆可；Astro 對 `is:inline` 不做 bundling，frontmatter 變數可用 `set:html` 注入。**注意**：現檔 `</Layout>` 在第 300 行，`<script>` 在 302-468 之後再 `</Layout>`？實際上 order.astro 的 `</section>`/`</Layout>` 在 299-300，`<script>` 在 302 起、檔案結尾 469 是 `</Layout>` 之外的 `<script>`收尾——**請以實檔為準**：把 island 放在最後一個 `</Layout>`（第 ...）之前。最穩妥位置：緊接在 `</script>`（第 468 行）之後、`</Layout>` 之前。

修正後的精確插入點（在 `</script>`（:468）與 `</Layout>` 之間）：

```astro
  </script>

  <script
    is:inline
    type="application/json"
    id="ship-config"
    set:html={JSON.stringify(shipConfig)}
  />
</Layout>
```

### 6d. 客戶端：讀 island + 用 package_fen 算斤
- [ ] 在 `<script>` 開頭（第 307-309 行附近，`const form = ...` 之後、`const shipFee = ...` 之後）讀取 island 與 config。把第 307-309 行：

```ts
  const form = document.getElementById("order-form") as HTMLFormElement | null;
  if (form) {
    const shipFee = Number(form.dataset.shipFee ?? 150);
```

改為：

```ts
  const form = document.getElementById("order-form") as HTMLFormElement | null;
  if (form) {
    const shipFee = Number(form.dataset.shipFee ?? 150);
    // V6 §5.5: shipping_config baked by SSR island so the live preview matches the server.
    type ShipConfig =
      | { type: "flat"; fee_twd: number }
      | { type: "threshold_jin"; free_over_fen: number; fee_twd: number };
    const shipCfgNode = document.getElementById("ship-config");
    let shipCfg: ShipConfig = { type: "flat", fee_twd: shipFee };
    try {
      if (shipCfgNode?.textContent) shipCfg = JSON.parse(shipCfgNode.textContent) as ShipConfig;
    } catch {
      /* keep flat fallback */
    }
    function previewShipping(totalFen: number): number {
      if (totalFen <= 0) return 0;
      if (shipCfg.type === "flat") return shipCfg.fee_twd;
      return totalFen >= shipCfg.free_over_fen ? 0 : shipCfg.fee_twd;
    }
```

- [ ] 修改 `computeItems`（第 319-334 行）使其同時回傳 `totalFen`。把：

```ts
    function computeItems(): { items: OrderItem[]; totalQty: number; subtotal: number } {
      const items: OrderItem[] = [];
      let totalQty = 0;
      let subtotal = 0;
      qtyInputs.forEach((el) => {
        const qty = Math.max(0, Math.floor(Number(el.value) || 0));
        if (qty > 0) {
          const sku = el.dataset.sku as OrderItem["sku"];
          const price = Number(el.dataset.price ?? 0);
          items.push({ sku, qty });
          totalQty += qty;
          subtotal += price * qty;
        }
      });
      return { items, totalQty, subtotal };
    }
```

改為（新增 `totalFen` 累加 `package_fen × qty`）：

```ts
    function computeItems(): {
      items: OrderItem[];
      totalQty: number;
      subtotal: number;
      totalFen: number;
    } {
      const items: OrderItem[] = [];
      let totalQty = 0;
      let subtotal = 0;
      let totalFen = 0;
      qtyInputs.forEach((el) => {
        const qty = Math.max(0, Math.floor(Number(el.value) || 0));
        if (qty > 0) {
          const sku = el.dataset.sku as OrderItem["sku"];
          const price = Number(el.dataset.price ?? 0);
          const packageFen = Number(el.dataset.packageFen ?? 0);
          items.push({ sku, qty });
          totalQty += qty;
          subtotal += price * qty;
          totalFen += packageFen * qty;
        }
      });
      return { items, totalQty, subtotal, totalFen };
    }
```

- [ ] 修改 `recomputeSummary`（第 336-343 行）改用 `previewShipping(totalFen)`。把：

```ts
    function recomputeSummary() {
      const { totalQty, subtotal } = computeItems();
      const shipping = totalQty > 0 ? shipFee : 0;
      const total = subtotal + shipping;
      subtotalEl.textContent = `$${subtotal}`;
      shippingEl.textContent = `$${shipping}`;
      totalEl.textContent = `$${total}`;
    }
```

改為：

```ts
    function recomputeSummary() {
      const { subtotal, totalFen } = computeItems();
      const shipping = previewShipping(totalFen);
      const total = subtotal + shipping;
      subtotalEl.textContent = `$${subtotal}`;
      shippingEl.textContent = `$${shipping}`;
      totalEl.textContent = `$${total}`;
    }
```

> 注意：`computeItems` 在 submit handler（第 364 行 `const { items, totalQty } = computeItems();`）也被呼叫，新增欄位向後相容（解構只取需要的），不需改。`shipFee` 仍被 island fallback 用到，保留。

### 6e. 驗證
- [ ] build：

```bash
bun run build
```

預期：通過（`astro check` 對 `.astro` 內 `<script>` 做型別檢查；`data-package-fen` → `el.dataset.packageFen` 為 string，`Number(...)` 轉換正確）。

> 無頭瀏覽器驗證（選配）：可用 `/browse` 或 `bun run dev` 開 `/order`，輸入數量觀察「運費」即時變化（threshold 季滿斤變 $0）。本計畫不強制，留待 Task 9 後的 stage QA。

### 6f. commit
- [ ] commit：

```bash
git add src/pages/order.astro
git commit -m "feat(shipping): order.astro live preview uses package_fen + shipping_config

P4 §5.5: qty inputs carry data-package-fen; SSR bakes #ship-config island; client
preview sums total 斤 and applies flat/threshold_jin (mirrors server computeShipping).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — 前端 `admin/orders/[id].astro`：`package_fen` + 預覽算斤

admin 訂單編輯頁的運費預覽同樣改用斤數 + config。資料管道：`data-products`（`sellableForNew`）需多帶 `package_fen`；`#v5-order-state` island 需多帶 `shipping_config`（取代/補充 `shippingFeeTwd`）。

**Files**
- Modify: `src/pages/admin/orders/[id].astro:68-76`(sellableForNew 加 package_fen)、`:330-336`(ProductInfo 型別)、`:359-376`(island 解析)、`:395-417`(recomputeTotals)、`:886-893`(SSR island)

### 7a. SSR：`sellableForNew` 帶 `package_fen`
- [ ] 把第 68-76 行：

```ts
const sellableForNew = productRows
  .filter((p) => p.available && (p.stock > 0 || skusOnOrder.has(p.sku)))
  .map((p) => ({
    sku: p.sku,
    name: p.name,
    variant: p.variant,
    price: p.price,
    stock: p.stock,
  }));
```

改為（新增 `package_fen`）：

```ts
const sellableForNew = productRows
  .filter((p) => p.available && (p.stock > 0 || skusOnOrder.has(p.sku)))
  .map((p) => ({
    sku: p.sku,
    name: p.name,
    variant: p.variant,
    price: p.price,
    stock: p.stock,
    package_fen: p.package_fen,
  }));
```

> `p.package_fen` 來自 `productJoined`（:39）→`productRows`（:46-49 展開），已有。

### 7b. SSR island：補 `shipping_config`，並查 order 所屬 season 的 config
現況 island（第 886-893 行）只放 `shippingFeeTwd: parseInt(env.SHIPPING_FEE_TWD,...)`。改為放整個 `shipping_config`（該訂單所屬 season）。

- [ ] 在 frontmatter（`---` 區，第 1-82 行）內，於 `cancelledMeta`（:78-81）之後新增查該訂單 season 的 shipping_config。插在第 81 行（`: undefined;`）之後、`---`（:82）之前：

```ts
import { seasons } from "../../../db/schema"; // ← 若尚未在頂部 import，改在頂部 import 區加入

// V6 §5.5: this order's season shipping policy for the client-side preview.
const seasonCfgRows = order.season_id
  ? await db
      .select({ shipping_config: seasons.shipping_config })
      .from(seasons)
      .where(eq(seasons.id, order.season_id))
      .limit(1)
  : [];
const orderShipConfig = seasonCfgRows[0]?.shipping_config ?? null;
```

> **import 注意**：第 7 行已 `import { orders, order_items, products, product_groups, audit_log } from "../../../db/schema";` —— **沒有 `seasons`**。正確做法：把第 7 行改為含 `seasons`：

把第 7 行：

```ts
import { orders, order_items, products, product_groups, audit_log } from "../../../db/schema";
```

改為：

```ts
import { orders, order_items, products, product_groups, audit_log, seasons } from "../../../db/schema";
```

（並**移除**上面範例裡那行「若尚未在頂部 import」的 inline import，統一在頂部 import。）

- [ ] 修改 SSR island（第 883-893 行）。把：

```astro
  <script
    is:inline
    type="application/json"
    id="v5-order-state"
    set:html={JSON.stringify({
      paid: order.paid,
      shipped: order.shipped,
      cancelled_at: order.cancelled_at,
      shippingFeeTwd: parseInt(env.SHIPPING_FEE_TWD, 10) || 150,
    })}
  />
```

改為（加 `shippingConfigJson`；保留 `shippingFeeTwd` 作為 fallback）：

```astro
  <script
    is:inline
    type="application/json"
    id="v5-order-state"
    set:html={JSON.stringify({
      paid: order.paid,
      shipped: order.shipped,
      cancelled_at: order.cancelled_at,
      shippingFeeTwd: parseInt(env.SHIPPING_FEE_TWD, 10) || 150,
      shippingConfigJson: orderShipConfig,
    })}
  />
```

> `orderShipConfig` 是 DB 原始字串（可能為 null）；客戶端再 `JSON.parse` 一次。這樣 island 自身仍是合法 JSON（巢狀字串）。

### 7c. 客戶端：型別 + 解析 config + 預覽算斤
- [ ] 修改 `ProductInfo`（第 330-336 行）加 `package_fen`。把：

```ts
    interface ProductInfo {
      sku: string;
      name: string;
      variant: string;
      price: number;
      stock: number;
    }
```

改為：

```ts
    interface ProductInfo {
      sku: string;
      name: string;
      variant: string;
      price: number;
      stock: number;
      package_fen: number;
    }
```

- [ ] 修改 island 解析（第 359-376 行），新增 shipping config 解析。把：

```ts
    // expected_state + shipping config baked from SSR via JSON island.
    interface OrderStateIsland extends ExpectedState {
      shippingFeeTwd?: number;
    }
    const stateNode = document.getElementById("v5-order-state");
    const stateIsland: OrderStateIsland = stateNode
      ? JSON.parse(stateNode.textContent || "{}")
      : { paid: false, shipped: false, cancelled_at: null };
    let expectedState: ExpectedState = {
      paid: stateIsland.paid,
      shipped: stateIsland.shipped,
      cancelled_at: stateIsland.cancelled_at,
      // Items fingerprint at page-load. Sent with every /save so the server
      // can detect another tab modifying items between this page-load and
      // submit (the "double-decrement" race).
      items_hash: itemsHash(initialItems),
    };
    const shippingFeeTwd = stateIsland.shippingFeeTwd ?? 150;
```

改為：

```ts
    // expected_state + shipping config baked from SSR via JSON island.
    type ShipConfig =
      | { type: "flat"; fee_twd: number }
      | { type: "threshold_jin"; free_over_fen: number; fee_twd: number };
    interface OrderStateIsland extends ExpectedState {
      shippingFeeTwd?: number;
      shippingConfigJson?: string | null;
    }
    const stateNode = document.getElementById("v5-order-state");
    const stateIsland: OrderStateIsland = stateNode
      ? JSON.parse(stateNode.textContent || "{}")
      : { paid: false, shipped: false, cancelled_at: null };
    let expectedState: ExpectedState = {
      paid: stateIsland.paid,
      shipped: stateIsland.shipped,
      cancelled_at: stateIsland.cancelled_at,
      // Items fingerprint at page-load. Sent with every /save so the server
      // can detect another tab modifying items between this page-load and
      // submit (the "double-decrement" race).
      items_hash: itemsHash(initialItems),
    };
    const shippingFeeTwd = stateIsland.shippingFeeTwd ?? 150;
    // V6 §5.5: parse this order's season shipping_config for the preview.
    let shipCfg: ShipConfig = { type: "flat", fee_twd: shippingFeeTwd };
    try {
      if (stateIsland.shippingConfigJson) {
        shipCfg = JSON.parse(stateIsland.shippingConfigJson) as ShipConfig;
      }
    } catch {
      /* keep flat fallback */
    }
    function previewShipping(totalFen: number): number {
      if (totalFen <= 0) return 0;
      if (shipCfg.type === "flat") return shipCfg.fee_twd;
      return totalFen >= shipCfg.free_over_fen ? 0 : shipCfg.fee_twd;
    }
```

- [ ] 修改 `recomputeTotals`（第 395-417 行）改用 package_fen 算斤 + previewShipping。把：

```ts
    function recomputeTotals(): void {
      // Skip when items are clean: SSR already rendered server-truthful totals.
      // Recomputing here would stomp the DB-correct shipping/total with a preview
      // that mirrors the server formula but rounds differently if env values
      // ever drift.
      if (itemsDirtyCount() === 0) return;
      let subtotal = 0;
      let totalQty = 0;
      for (const w of working) {
        const p = productMap.get(w.sku);
        if (p) subtotal += p.price * w.qty;
        totalQty += w.qty;
      }
      // Mirrors src/lib/order-response.ts shippingFor — flat fee per order.
      // Server is authoritative; this is just a preview for the dirty state.
      const shipping = totalQty > 0 ? shippingFeeTwd : 0;
      const subEl = document.getElementById("items-subtotal");
      const shipEl = document.getElementById("items-shipping");
      const totEl = document.getElementById("items-total");
      if (subEl) subEl.textContent = "$" + subtotal;
      if (shipEl) shipEl.textContent = "$" + shipping;
      if (totEl) totEl.textContent = "$" + (subtotal + shipping);
    }
```

改為：

```ts
    function recomputeTotals(): void {
      // Skip when items are clean: SSR already rendered server-truthful totals.
      // Recomputing here would stomp the DB-correct shipping/total with a preview
      // that mirrors the server formula but rounds differently.
      if (itemsDirtyCount() === 0) return;
      let subtotal = 0;
      let totalFen = 0;
      for (const w of working) {
        const p = productMap.get(w.sku);
        if (p) {
          subtotal += p.price * w.qty;
          totalFen += p.package_fen * w.qty;
        }
      }
      // V6 §5.5: mirrors src/lib/shipping.ts computeShipping(totalFen, config).
      // Server is authoritative; this is just a preview for the dirty state.
      const shipping = previewShipping(totalFen);
      const subEl = document.getElementById("items-subtotal");
      const shipEl = document.getElementById("items-shipping");
      const totEl = document.getElementById("items-total");
      if (subEl) subEl.textContent = "$" + subtotal;
      if (shipEl) shipEl.textContent = "$" + shipping;
      if (totEl) totEl.textContent = "$" + (subtotal + shipping);
    }
```

> `shippingFeeTwd` 仍被 `shipCfg` 的 fallback 初值使用，保留宣告，無 unused 風險。

### 7d. 驗證
- [ ] build：

```bash
bun run build
```

預期：通過。常見錯誤：`productMap.get(w.sku)` 的型別已含 `package_fen`（因 `ProductInfo` 已加），`p.package_fen` 可用。

### 7e. commit
- [ ] commit：

```bash
git add "src/pages/admin/orders/[id].astro"
git commit -m "feat(shipping): admin order edit preview uses package_fen + season config

P4 §5.5: sellableForNew carries package_fen; #v5-order-state island bakes the order's
season shipping_config; recomputeTotals sums total 斤 and applies threshold/flat.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — 文案：`products.astro` FAQ + `order.astro` 運費行

把寫死的「每筆訂單運費 $150 元」改為依 `shipping_config` 動態描述。

**Files**
- Modify: `src/pages/products.astro:7`(frontmatter)、`:44-47`(FAQ 文案)
- Modify: `src/pages/order.astro:45-47`(運費行文案)

### 8a. 共用文案 helper（純函式，放 shipping.ts）
為前後台文案一致，加一個純函式 `describeShipping(config): string`。

- [ ] 在 `src/lib/shipping.ts` 末尾新增：

```ts
// Human-readable Traditional-Chinese description of a shipping policy, for the
// fee line + FAQ. fen→斤 conversion is /100.
export function describeShipping(config: ShippingConfig): string {
  if (config.type === "flat") {
    return config.fee_twd === 0
      ? "全館免運。"
      : `每筆訂單運費 $${config.fee_twd} 元。`;
  }
  const jin = config.free_over_fen / 100;
  const jinText = Number.isInteger(jin) ? `${jin}` : jin.toFixed(2);
  return `滿 ${jinText} 斤免運，未滿每筆訂單運費 $${config.fee_twd} 元。`;
}
```

- [ ] 為 `describeShipping` 補純單元測試（加到 `tests/shipping.test.ts` 末尾）：

```ts
import { describeShipping } from "../src/lib/shipping";

describe("describeShipping", () => {
  it("flat fee", () => {
    expect(describeShipping({ type: "flat", fee_twd: 150 })).toBe("每筆訂單運費 $150 元。");
  });
  it("flat free", () => {
    expect(describeShipping({ type: "flat", fee_twd: 0 })).toBe("全館免運。");
  });
  it("threshold whole 斤", () => {
    expect(
      describeShipping({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 }),
    ).toBe("滿 10 斤免運，未滿每筆訂單運費 $150 元。");
  });
  it("threshold fractional 斤", () => {
    expect(
      describeShipping({ type: "threshold_jin", free_over_fen: 50, fee_twd: 150 }),
    ).toBe("滿 0.50 斤免運，未滿每筆訂單運費 $150 元。");
  });
});
```

> 把這段 `import { describeShipping }` 合併到檔案頂部既有 import 較整齊；分開 import 同模組在 bun/ts 也合法，但建議手動併入第一個 import 區塊。

- [ ] 跑驗證（先 FAIL：`describeShipping` 尚未在 import 前已可用？已在同檔，故新增測試 + 新增實作後應 PASS）：

```bash
bun test tests/shipping.test.ts
```

預期：新增 4 個 describeShipping 測試全綠，其餘維持綠。

### 8b. `products.astro` FAQ
- [ ] 在 frontmatter 取出 config 並 import helper。把第 1-8 行：

```astro
---
import Layout from "../layouts/Layout.astro";
import ProductCard from "../components/ProductCard.astro";
import { env } from "../lib/env";
import { loadSiteSettings } from "../lib/site-settings";

const settings = await loadSiteSettings(env);
---
```

改為：

```astro
---
import Layout from "../layouts/Layout.astro";
import ProductCard from "../components/ProductCard.astro";
import { env } from "../lib/env";
import { loadSiteSettings } from "../lib/site-settings";
import { describeShipping } from "../lib/shipping";

const settings = await loadSiteSettings(env);
const shipDesc = describeShipping(settings.shipping_config);
---
```

- [ ] 把第 44-47 行 FAQ：

```astro
        <h3 class="font-semibold text-base mb-1">運費怎麼算？</h3>
        <p class="text-mango-700">
          每筆訂單運費 ${settings.shipping_fee_twd} 元。
        </p>
```

改為：

```astro
        <h3 class="font-semibold text-base mb-1">運費怎麼算？</h3>
        <p class="text-mango-700">
          {shipDesc}
        </p>
```

### 8c. `order.astro` 運費行
- [ ] frontmatter 已在 Task 6 取出 `shipConfig`；補 import helper + 文案變數。把第 1-13 行的 import/frontmatter（Task 6 後狀態）裡，於 import 區加入：

把：

```astro
import { loadSiteSettings } from "../lib/site-settings";
```

改為：

```astro
import { loadSiteSettings } from "../lib/site-settings";
import { describeShipping } from "../lib/shipping";
```

並在 `const shipConfig = settings.shipping_config;`（Task 6 新增）之後加：

```ts
const shipDesc = describeShipping(shipConfig);
```

- [ ] 把第 44-47 行運費行：

```astro
          <h1 class="text-3xl font-bold mb-1">下訂</h1>
          <p class="text-mango-700 mb-8 text-sm">
            每筆訂單運費 ${shipFee} 元。
          </p>
```

改為：

```astro
          <h1 class="text-3xl font-bold mb-1">下訂</h1>
          <p class="text-mango-700 mb-8 text-sm">
            {shipDesc}
          </p>
```

### 8d. 驗證
- [ ] build + 文案測試：

```bash
bun run build && bun test tests/shipping.test.ts
```

預期：build 綠燈；shipping.test.ts 全綠。

### 8e. commit
- [ ] commit：

```bash
git add src/lib/shipping.ts tests/shipping.test.ts src/pages/products.astro src/pages/order.astro
git commit -m "feat(shipping): fee line + FAQ describe shipping_config (describeShipping)

P4 §5.5: products.astro FAQ and order.astro fee line now render the season's policy
(flat / threshold 滿N斤免運) via describeShipping. Pure unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — 端到端整合測試（下單後 `orders.shipping` 符合規則）

驗證後端權威路徑：customer 下單後 DB 的 `orders.shipping` 在 flat 與 threshold 兩種 config 下都正確；以及剛好門檻的邊界。需 stage env。

**Files**
- Create test: `tests/shipping-e2e.test.ts`

### 9a. 先部署到 stage（讓新 API + shippingFor 上線）
整合測試打的是 stage worker，必須先把本模組程式碼部署到 stage。
- [ ] 確認當前 active 的 `PUBLIC_ORDER_TOKEN` 等於 **stage** 的 `ORDER_TOKEN`（見 CLAUDE.md：token 在 `.env`；跨環境部署要換 active line）。
- [ ] 部署 stage：

```bash
bun run deploy:stage
```

預期：clean-build → astro build → wrangler deploy 成功，三道 token guard 通過。

### 9b. 寫端到端測試
- [ ] 建立 `tests/shipping-e2e.test.ts`，完整內容：

```ts
// E2E (stage): customer order shipping snapshot matches the season's shipping_config.
// Requires stage env (MANGO_STAGE_URL + TEST_TOKEN) and the P4 build deployed to stage.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  TEST_TOKEN,
  cleanupTestData,
  cleanupTestAdmin,
  d1Execute,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
  stageFetch,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SEASON_CODE = "test-ship-e2e-season";
const GROUP_SLUG = "test-ship-e2e-group";
const SKU_1JIN = "TEST-SHIP-1JIN"; // package_fen 100
const SKU_HALF = "TEST-SHIP-HALF"; // package_fen 50

let seasonId = 0;

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

// Seed an active season with a fat stock pool + two package sizes, then set its
// shipping_config directly (seedActiveSeasonScenario leaves the P3 default flat-150).
function seedWithConfig(config: object) {
  const r = seedActiveSeasonScenario({
    season_code: SEASON_CODE,
    group_slug: GROUP_SLUG,
    initial_stock_fen: 100_000, // huge — never the limiting factor here
    skus: [
      { sku: SKU_1JIN, package_fen: 100, price: 500 },
      { sku: SKU_HALF, package_fen: 50, price: 300 },
    ],
  });
  seasonId = r.season_id;
  d1Execute(
    `UPDATE seasons SET shipping_config = '${JSON.stringify(config)}' WHERE id = ${seasonId}`,
  );
}

async function order(items: Array<{ sku: string; qty: number }>) {
  const res = await stageFetch("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: `test-${crypto.randomUUID()}`,
      token: TEST_TOKEN,
      honeypot: "",
      name: "test-ship-buyer",
      phone: "0912345678",
      address: "test address 100",
      items,
      notes: "",
      pdpa_accepted: true,
    }),
  });
  return (await res.json()) as {
    ok: boolean;
    order_id?: string;
    subtotal?: number;
    shipping?: number;
    total?: number;
    error_code?: string;
  };
}

function dbShipping(orderId: string): number {
  const rows = d1Execute(
    `SELECT shipping FROM orders WHERE order_id = '${orderId}'`,
  ) as Array<{ shipping: number }>;
  return rows[0]!.shipping;
}

describe("shipping E2E — flat config", () => {
  it("charges flat fee regardless of weight", async () => {
    if (SKIP) return;
    seedWithConfig({ type: "flat", fee_twd: 150 });
    const r = await order([{ sku: SKU_1JIN, qty: 1 }]); // 1 斤
    expect(r.ok).toBe(true);
    expect(r.shipping).toBe(150);
    expect(dbShipping(r.order_id!)).toBe(150);
    expect(r.total).toBe((r.subtotal ?? 0) + 150);
  });
});

describe("shipping E2E — threshold_jin config", () => {
  it("below threshold (5 斤 < 10) charges fee", async () => {
    if (SKIP) return;
    seedWithConfig({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });
    const r = await order([{ sku: SKU_1JIN, qty: 5 }]); // 500 fen
    expect(r.ok).toBe(true);
    expect(r.shipping).toBe(150);
    expect(dbShipping(r.order_id!)).toBe(150);
  });

  it("exactly at threshold (10 斤) is free", async () => {
    if (SKIP) return;
    seedWithConfig({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });
    const r = await order([{ sku: SKU_1JIN, qty: 10 }]); // 1000 fen
    expect(r.ok).toBe(true);
    expect(r.shipping).toBe(0);
    expect(dbShipping(r.order_id!)).toBe(0);
  });

  it("mixed package sizes aggregate by weight (9×1斤 + 2×半斤 = 10斤) → free", async () => {
    if (SKIP) return;
    seedWithConfig({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });
    const r = await order([
      { sku: SKU_1JIN, qty: 9 }, // 900
      { sku: SKU_HALF, qty: 2 }, // 100
    ]); // 1000 fen
    expect(r.ok).toBe(true);
    expect(r.shipping).toBe(0);
    expect(dbShipping(r.order_id!)).toBe(0);
  });

  it("1 package below threshold (9 斤 + 1 半斤 = 9.5 斤) still charges", async () => {
    if (SKIP) return;
    seedWithConfig({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });
    const r = await order([
      { sku: SKU_1JIN, qty: 9 }, // 900
      { sku: SKU_HALF, qty: 1 }, // 50
    ]); // 950 fen < 1000
    expect(r.ok).toBe(true);
    expect(r.shipping).toBe(150);
    expect(dbShipping(r.order_id!)).toBe(150);
  });
});
```

- [ ] 跑驗證（部署後，需 stage env）：

```bash
bun test tests/shipping-e2e.test.ts
```

預期輸出（全綠）：
```
 ✓ shipping E2E — flat config > charges flat fee regardless of weight
 ✓ shipping E2E — threshold_jin config > below threshold (5 斤 < 10) charges fee
 ✓ shipping E2E — threshold_jin config > exactly at threshold (10 斤) is free
 ✓ shipping E2E — threshold_jin config > mixed package sizes aggregate ...
 ✓ shipping E2E — threshold_jin config > 1 package below threshold ... still charges
 5 pass
 0 fail
```

- [ ] 同時跑 shipping-config endpoint 整合測試（Task 5b，部署後才有真實斷言）：

```bash
bun test tests/shipping-config-endpoint.test.ts
```

預期：全綠（7 個案例）。

### 9c. commit
- [ ] commit：

```bash
git add tests/shipping-e2e.test.ts
git commit -m "test(shipping): E2E — orders.shipping matches season shipping_config

P4 §5.5/§7: flat charges flat; threshold_jin frees at/over the 斤 threshold,
aggregating mixed package sizes by weight. Boundary (exactly N斤, N斤-半斤) covered.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 — 全量驗證 + 收尾

**Files**: 無（驗證）

- [ ] 全套純單元測試（無 env 也能跑）：

```bash
bun test tests/shipping.test.ts tests/order-response-shipping.test.ts tests/stock-helper.test.ts tests/items-hash.test.ts tests/csp.test.ts tests/deploy-token-guard.test.ts
```

預期：全綠（這些不依賴 stage）。

- [ ] 全套測試（有 stage env 時）：

```bash
bun test
```

預期：全綠；特別確認 `save-endpoint.test.ts`、`stock-d1.test.ts`、`regression-cancelled-orders.test.ts` 未因 `shippingFor` 簽章變更而退步（它們驗證 `orders.shipping`/編輯運費——本模組改動後仍應通過，因為 stage 季節的 `shipping_config` 是 P3 預設 flat-150，等同舊行為）。

> **若 `save-endpoint.test.ts` 斷言運費為固定 150**：本模組未改變「stage 預設 flat-150」的等價結果，故應仍綠。若它顯式期望某值且失敗，檢查是否該測試自己 seed 的 season 被別的測試改了 `shipping_config`（`cleanupTestData` 會刪 test season，故不互汙）。這是**回歸觀察點**，非預期失敗。

- [ ] build 最終確認：

```bash
bun run build
```

預期：`astro check` 0 error、build 成功。

- [ ] （選配）部署後 reconcile（本模組不動庫存，理論上零影響，但 CLAUDE.md 要求部署後跑）：

```bash
bun run scripts/reconcile-stock.ts --env stage
```

預期：exit 0，無 drift。

- [ ] 收尾 commit（若 Task 10 過程有任何小修；否則略過）：

```bash
git add -A
git commit -m "chore(shipping): P4 threshold-shipping module verification pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 附錄 A：本模組改動檔案清單（production code）

- `src/lib/shipping.ts`（**新增**）— 純計算核心 + 文案 helper。
- `src/lib/order-response.ts`（改）— `shippingFor` 簽章改為 `(items, config)`。
- `src/pages/api/orders.ts`（改）— active season 查詢加 `shipping_config`，傳 resolved items + config。
- `src/pages/api/admin/orders.ts`（改）— 同上。
- `src/pages/api/admin/orders/[id]/save.ts`（改）— 用 order 所屬 season 的 config 重算運費。
- `src/lib/site-settings.ts`（改）— `SiteSettings` 增 `shipping_config`，由 active season 讀取。
- `src/lib/types.ts`（改）— `SiteSettings` 鏡像增 `shipping_config` + `ShippingConfig` type。
- `src/pages/api/admin/seasons/[id]/shipping-config.ts`（**新增**）— 運費設定 PATCH API。
- `src/pages/order.astro`（改）— `data-package-fen` + `#ship-config` island + 預覽算斤 + 文案。
- `src/pages/admin/orders/[id].astro`（改）— `package_fen` 入 `data-products`/`ProductInfo` + island 帶 season config + 預覽算斤。
- `src/pages/products.astro`（改）— FAQ 文案。

測試檔（新增）：`tests/shipping.test.ts`、`tests/order-response-shipping.test.ts`、`tests/shipping-config-endpoint.test.ts`、`tests/shipping-e2e.test.ts`。

## 附錄 B：不碰清單（明確邊界）

- 不改 `orders.shipping` 欄位語意（仍是下單當下快照）。
- 不改 intake API、`products/batch.ts`、`group_stock_change` 稽核路徑。
- 不刪 `AppEnv.SHIPPING_FEE_TWD` / `FREE_SHIPPING_MIN_PACKAGES`（移除需動 `wrangler.jsonc` + `scripts/deploy.mjs`，超出本模組；保留為 dead config）。
- 不建立季節管理頁 `src/pages/admin/seasons/index.astro`（P5 負責；本模組只提供 shipping-config API 供其呼叫）。
- 不改 Telegram「含運」顯示（`orders.shipping` 已是最終值，下游無變）。
- 不改 P3 的遷移/schema（依賴其產出 `seasons.shipping_config`）。
