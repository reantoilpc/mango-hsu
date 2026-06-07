# P2 — SKU 介面中文化 + 術語中文化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把後台兩個頁面（`admin/products/index.astro`、`admin/product-groups/index.astro`）面向店主的英文/技術術語全部中文化——SKU→「商品編碼」、slug→「品種代碼」、移除 `fen` 明文（UI 只留「斤」）——後端與驗證規則零改動。

**Architecture:** 純前端文字/label 改動。只改 `.astro` 模板裡會渲染給店主看的字串（表頭、placeholder、aria-label、提示段落、toast 訊息）。**絕對不改**：HTML `data-*` 屬性名（`data-current-fen`/`data-current-fen-label`/`data-current-jin` 等，JS 用 `dataset.currentFen` 讀取，改名會壞）、TypeScript 介面欄位名（`delta_fen`/`package_fen` 等是 API 契約）、表單 `name=` 屬性（後端解析依據）、驗證 regex `[A-Z0-9_-]+`、API 路由。驗證方式：先寫一支 grep 斷言的純單元測試把「禁字不得出現在面向使用者文案」鎖死（先 FAIL），改完文字讓它 PASS，再用 `bun run build` 確認 `.astro` 仍能編譯，最後視覺確認。

**Tech Stack:** Astro 6（`.astro` SSR 模板）、Bun（`bun test` / `bun run build`）、Tailwind v4。本模組為純文字改動，不引入新依賴、不碰 D1/KV/wrangler。

**詞表（全模組一致，與 spec §5.4 一致）**

| 原術語 | 中文 | 備註 |
|---|---|---|
| SKU | 商品編碼 | 識別碼欄位本身維持英數大寫，只改 label |
| slug | 品種代碼 | 識別碼維持小寫英數，只改 label |
| fen | （移除明文，UI 只顯示「斤」） | fen 純內部單位，店主看不到 |
| package_fen | 包裝大小 | label 用詞；data-attr / 欄位名不改 |
| group | 品種 | |
| variant | 規格 | 兩頁皆已是「規格」，僅驗證不需改 |

**範圍鐵則（spec §5.4「純文字/label 改動，後端零改動」）**

- 後端 0 改：`src/pages/api/**`、`src/lib/**`、`src/db/**` 一律不碰。
- 不動驗證 regex（`pattern="[A-Z0-9_-]+"`、`/^[A-Z0-9_-]+$/`）與表單 `name=` 屬性。
- 不動 HTML `data-*` 屬性名與 TS 介面欄位名（含 `fen` 字樣者皆是內部契約）。
- 本模組不碰 stock_fen 變動路徑、不碰 intake / products batch API。

---

## File Structure

| 檔案 | 角色 | 本計畫動作 |
|---|---|---|
| `tests/terminology-zhtw.test.ts` | 純單元 grep 斷言：禁字不得出現在面向使用者文案；中文新詞必須出現 | **Create** |
| `src/pages/admin/products/index.astro` | 商品管理頁；表頭/placeholder/aria-label/toast 中文化 | **Modify** |
| `src/pages/admin/product-groups/index.astro` | 庫存池頁；「包含 SKU：」「品種代碼」label + 移除 fen 明文 | **Modify** |

測試屬「純單元（無 env）」類別：不 import `tests/_setup.ts`、不連 stage、不需 `MANGO_STAGE_URL`/`TEST_TOKEN`，CI 與本機都能直接跑 `bun test`。它把兩個 `.astro` 檔當純文字讀進來，用正則斷言「面向使用者文案」是否含禁字——這是 spec §5.4 要求的「grep 斷言（該術語不再出現於面向使用者文案）」的可重複版本。

**為何不需 stage 整合測試**：本模組後端零改、無 DB 互動、無新 API；spec §7 對 §5.4 的驗證要求是「grep 斷言 + 視覺確認」，不在整合測試清單內。

---

## 改動清單（改前 → 改後，逐行）

> 行號為撰寫計畫當下的狀態，實作者請以「改前文字」為唯一比對依據（行號可能因前置任務微移）。每筆都附 `old_string` 可唯一定位的完整片段，照 Edit 即可。

### A. `src/pages/admin/products/index.astro`

| # | 位置 | 改前 | 改後 | 性質 |
|---|---|---|---|---|
| A1 | L33 提示段 | `不要刪 SKU（會破壞舊訂單品項關聯）。` | `不要刪商品編碼（會破壞舊訂單品項關聯）。` | 面向使用者 |
| A2 | L46 既有列表表頭 | `<div>SKU</div>` | `<div>商品編碼</div>` | 面向使用者 |
| A3 | L124 新增區表頭 | `<div>SKU</div>` | `<div>商品編碼</div>` | 面向使用者 |
| A4 | L138 新增表單 aria-label | `aria-label="SKU"` | `aria-label="商品編碼"` | 面向使用者 |
| A5 | L140 新增表單 placeholder | `placeholder="SKU"` | `placeholder="商品編碼"` | 面向使用者 |
| A6 | L355 驗證 toast | `showToast("SKU 只能大寫英數、底線、連字號", { kind: "error" });` | `showToast("商品編碼只能大寫英數、底線、連字號", { kind: "error" });` | 面向使用者 |
| A7 | L64 列 aria-label | `aria-label={`${p.sku} 名稱`}` | `aria-label={`${p.sku} 名稱`}` | **不改**（值是動態 SKU 字串 + 中文「名稱」，無英文術語） |
| A8 | L75/L87/L98/L108 列 aria-label | `規格`/`價格`/`順序`/`上架` | 同左 | **不改**（皆已中文） |

> A7/A8 說明：spec §5.4 點名「每列 aria-label 前綴（64/75/87/98/108）」，實際讀檔後這些 aria-label 形如 `` `${p.sku} 名稱` `` ——前綴是**動態 SKU 值**（如 `MANGO-1KG`），不是字面英文單字 "SKU"，後綴已是中文。因此無字面術語可改；保留動態 SKU 值是正確的（那是該列的識別碼，唸出來幫助辨識）。本任務不動它們，並由測試的「面向使用者文案」掃描確認其不含禁字字面 `SKU`/`slug`/`fen`。

> **L235 `// Group dirty fields by SKU into batch rows.`**：JS 程式碼註解，非面向使用者文案，spec §5.4 範圍是「面向使用者文案」。**不改**。

### B. `src/pages/admin/product-groups/index.astro`

| # | 位置 | 改前 | 改後 | 性質 |
|---|---|---|---|---|
| B1 | L97-99 提示段（fen 明文） | `V5.2：每個品種共用一個重量池（fen，1 fen = 0.01 斤）。` + 下一行 `下訂時系統會自動依 SKU 的包裝大小（如半斤=50、1 斤=100）從這個池扣 fen。` | `V5.2：每個品種共用一個重量池（以「斤」計，可到小數第二位）。` + `下訂時系統會自動依商品編碼的包裝大小（如半斤、1 斤）從這個池扣庫存。` | 移除 fen 明文 + SKU→商品編碼 |
| B2 | L127 群組 slug 顯示 | `<div class="font-mono text-xs text-gray-500">{g.slug}</div>` | `<div class="font-mono text-xs text-gray-500">品種代碼：{g.slug}</div>` | slug→品種代碼 label |
| B3 | L133-135 fen 副標 | `<div class="text-xs text-gray-500" data-current-fen-label>` + 下一行 `({g.stock_fen} fen)` | 整個 `<div data-current-fen-label>...</div>` 區塊**移除**（連同 JS 內對應更新，見 B6） | 移除 fen 明文 |
| B4 | L141 群組內 SKU 標籤 | `包含 SKU：` | `包含商品編碼：` | SKU→商品編碼 |
| B5 | L146 半斤/包顯示 | `（{s.variant}，{fenToJin(s.package_fen)} 斤/包` | 同左 | **不改**（已用 `fenToJin` 轉「斤/包」，無 fen 明文；`s.variant` 是規格值） |
| B6 | `<script>` 內 fen-label 更新（若存在） | 見 Task 4 實查 | 對應移除 | 配合 B3 |

> **B5 說明**：L146 已經是 `{fenToJin(s.package_fen)} 斤/包`——畫面顯示「0.50 斤/包」，無 fen 明文。`package_fen` 只出現在 `fenToJin()` 的引數（程式碼，非文案）。符合「package_fen→包裝大小」精神（畫面講「斤/包」即包裝大小），**不改**。

> **B3/B6 配套**：移除 `data-current-fen-label` 這個 DOM 節點前，必須確認 `<script>` 沒有 `querySelector('[data-current-fen-label]')` 之類的讀取，否則會留下指向不存在節點的死碼或 runtime null。Task 4 會先 grep 確認；目前讀檔結果該頁 `<script>`（L236-357）只讀 `data-group-card` / `data-current-fen`（attribute，非 label 節點）/ `data-intake-form`，**未**讀 `data-current-fen-label`，故移除該節點安全、無需改 JS。`data-current-fen`（L122，attribute 形式）是 JS `card.dataset.currentFen` 的來源（L292），**保留不動**。

> **不改清單（避免實作者誤砍）**：`data-current-fen`（L122）、`data-current-jin`（L130）、`fenToJin()` 函式名與內部 `fen` 變數、所有 TS 介面欄位（`delta_fen`/`new_pool_fen`/`expected_pool_fen`/`current_pool_fen`/`package_fen`/`before_fen`/`after_fen`，L67-69/L242-250/L41）、JS 註解 L281 `// 0.01 斤 = 1 fen...`、L162/L171 表單 aria-label（已中文）。這些含 `fen` 但都是**內部識別碼/契約/程式碼註解**，非面向使用者文案。

---

## Task 1: 建立術語掃描單元測試（先 FAIL）

**Files:**
- Create: `tests/terminology-zhtw.test.ts`

**做什麼**：寫一支純單元測試，把兩個 `.astro` 檔讀成字串，從中**抽出「面向使用者文案」**（渲染文字節點 + `placeholder=` + `aria-label=` 字面值 + `showToast(...)` 訊息），斷言這些文案不含禁字 `SKU`、`slug`、`fen`，且必含中文新詞「商品編碼」「品種代碼」。此刻原始碼仍含禁字，測試應 FAIL——這就是 TDD 紅燈。

掃描刻意**只取面向使用者的片段**，避開 `data-*` 屬性、TS 介面、`name=`、`pattern=`、import 路徑、JS 變數/註解（那些含 `fen`/`sku` 是合法內部用法）。實作策略：逐行讀，移除每行的「已知內部 token」後再驗禁字，這樣 `data-current-fen` 不會誤判，但渲染文字 `({g.stock_fen} fen)` 裡的尾巴 `fen` 會被抓到。

- [ ] **Step 1: 寫測試檔**

```typescript
// tests/terminology-zhtw.test.ts
//
// 純單元測試（無 env）：鎖死後台兩頁的術語中文化。
// 把 .astro 檔當純文字讀入，抽出「面向使用者文案」，斷言不含英文/技術術語禁字。
//
// 為什麼能跑：不 import tests/_setup.ts、不連 stage、不碰 D1/KV，
// 只讀本機檔案字串做正則斷言，CI 與本機 `bun test` 皆可直接執行。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PRODUCTS = resolve(ROOT, "src/pages/admin/products/index.astro");
const GROUPS = resolve(ROOT, "src/pages/admin/product-groups/index.astro");

// 面向使用者文案禁字（字面、區分大小寫）：
//  - "SKU"  → 應為「商品編碼」
//  - "slug" → 應為「品種代碼」
//  - "fen"  → 移除明文，UI 只顯示「斤」
const FORBIDDEN = ["SKU", "slug", "fen"] as const;

// 這些是「合法的內部 token」——含禁字子字串但屬於程式碼/屬性/契約，
// 不是面向使用者文案。掃描時先把整段移除，剩下的才視為文案。
// 注意：用「最長優先」順序，先吃掉長的（package_fen）再吃短的（fen）。
const INTERNAL_TOKENS = [
  // HTML data-* 屬性（含含 fen 者）
  "data-current-fen-label",
  "data-current-fen",
  "data-current-jin",
  "data-package-fen",
  "data-group-card",
  "data-group-id",
  "data-intake-form",
  "data-dirty-track",
  "data-dirty-key",
  "data-prod-field",
  "data-prod-row",
  "data-sku",
  "data-sticky-bar",
  "data-sticky-count",
  "data-sticky-save-label",
  "data-sticky-save",
  "data-sticky-discard",
  // TS 介面欄位 / API 契約 / JS 變數（含 fen / sku 子字串）
  "expected_pool_fen",
  "current_pool_fen",
  "new_pool_fen",
  "before_fen",
  "after_fen",
  "package_fen",
  "delta_fen",
  "stock_fen",
  "expectedFen",
  "deltaFen",
  "fenToJin",
  "delta_jin",
  // 屬性 key（單純 attribute 名，值另外保留）
  "p.sku",
  "s.sku",
  "products.sku",
  "products.package_fen",
  ".sku",
] as const;

/**
 * 移除一行裡所有已知內部 token，回傳「疑似面向使用者文案」殘餘字串。
 * 這讓 `data-current-fen` 之類不誤判，但渲染文字尾巴的 `fen` 仍會留下被抓到。
 */
function stripInternal(line: string): string {
  let out = line;
  for (const tok of INTERNAL_TOKENS) {
    out = out.split(tok).join(" ");
  }
  return out;
}

/**
 * 收集「面向使用者文案」候選行：
 *  - 含 placeholder= / aria-label= 的行（取整行，後續 stripInternal 清內部）
 *  - 含 showToast( 的行（toast 訊息）
 *  - 其餘行（渲染文字節點、提示段落）也納入——靠 stripInternal 濾掉內部 token。
 * 排除：import 行、純 frontmatter 型別宣告行（interface/function 簽名）以降低雜訊。
 */
function userFacingLines(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("import "))
    .map(stripInternal);
}

function assertNoForbidden(filePath: string, label: string): void {
  const src = readFileSync(filePath, "utf8");
  const lines = userFacingLines(src);
  for (let i = 0; i < lines.length; i++) {
    for (const bad of FORBIDDEN) {
      expect(
        lines[i].includes(bad),
        `${label}: 第 ${i + 1} 行的面向使用者文案仍含禁字 "${bad}"：${lines[i].trim()}`,
      ).toBe(false);
    }
  }
}

describe("後台術語中文化 — products/index.astro", () => {
  test("面向使用者文案不得含 SKU / slug / fen", () => {
    assertNoForbidden(PRODUCTS, "products/index.astro");
  });

  test("必含中文新詞「商品編碼」", () => {
    const src = readFileSync(PRODUCTS, "utf8");
    expect(src.includes("商品編碼")).toBe(true);
  });
});

describe("後台術語中文化 — product-groups/index.astro", () => {
  test("面向使用者文案不得含 SKU / slug / fen", () => {
    assertNoForbidden(GROUPS, "product-groups/index.astro");
  });

  test("必含中文新詞「商品編碼」與「品種代碼」", () => {
    const src = readFileSync(GROUPS, "utf8");
    expect(src.includes("商品編碼")).toBe(true);
    expect(src.includes("品種代碼")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認 FAIL（紅燈）**

Run: `bun test tests/terminology-zhtw.test.ts`

Expected: FAIL。預期至少 3 個 `assertNoForbidden` 斷言失敗 + 2 個「必含中文新詞」失敗。錯誤訊息形如：
```
error: products/index.astro: 第 33 行的面向使用者文案仍含禁字 "SKU"：不要刪 SKU（會破壞舊訂單品項關聯）。
...
error: product-groups/index.astro: 第 97 行的面向使用者文案仍含禁字 "fen"：V5.2：每個品種共用一個重量池（fen，1 fen = 0.01 斤）。
...
expect(received).toBe(expected)  // 必含中文新詞「品種代碼」
```
（行號可能略有出入；重點是 FAIL 且訊息指向禁字字面 SKU/fen。）

- [ ] **Step 3: Commit（紅燈測試先進版本控制）**

```bash
git add tests/terminology-zhtw.test.ts
git commit -m "test(admin): assert no SKU/slug/fen in user-facing copy (red)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: products/index.astro — SKU → 商品編碼

**Files:**
- Modify: `src/pages/admin/products/index.astro:33`（提示段）
- Modify: `src/pages/admin/products/index.astro:46`（既有列表表頭）
- Modify: `src/pages/admin/products/index.astro:124`（新增區表頭）
- Modify: `src/pages/admin/products/index.astro:138`（新增表單 aria-label）
- Modify: `src/pages/admin/products/index.astro:140`（新增表單 placeholder）
- Modify: `src/pages/admin/products/index.astro:355`（驗證 toast）
- Test: `tests/terminology-zhtw.test.ts`（沿用 Task 1）

> 表頭 `<div>SKU</div>` 在 L46 與 L124 各出現一次，文字相同。用 `replace_all: true` 一次換掉兩處（兩處都該變「商品編碼」，無例外）。

- [ ] **Step 1: 改提示段 SKU（A1）**

Edit `old_string`：
```
      下架某商品就把「上架」取消勾選；不要刪 SKU（會破壞舊訂單品項關聯）。
```
`new_string`：
```
      下架某商品就把「上架」取消勾選；不要刪商品編碼（會破壞舊訂單品項關聯）。
```

- [ ] **Step 2: 改兩處表頭 SKU（A2 + A3，replace_all）**

Edit `old_string`：
```
        <div>SKU</div>
```
`new_string`：
```
        <div>商品編碼</div>
```
使用 `replace_all: true`（L46 與 L124 兩處同時換）。

- [ ] **Step 3: 改新增表單 aria-label + placeholder（A4 + A5）**

此為 L133-141 的整個 `<input name="sku" ...>`，一次改兩個屬性。Edit `old_string`：
```
          <input
            type="text"
            name="sku"
            required
            pattern="[A-Z0-9_-]+"
            aria-label="SKU"
            class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm font-mono"
            placeholder="SKU"
          />
```
`new_string`：
```
          <input
            type="text"
            name="sku"
            required
            pattern="[A-Z0-9_-]+"
            aria-label="商品編碼"
            class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm font-mono"
            placeholder="商品編碼"
          />
```
> 注意：`name="sku"`、`pattern="[A-Z0-9_-]+"` 保持原樣不動——只改 `aria-label` 與 `placeholder` 兩個面向使用者屬性。

- [ ] **Step 4: 改驗證 toast（A6）**

Edit `old_string`：
```
        showToast("SKU 只能大寫英數、底線、連字號", { kind: "error" });
```
`new_string`：
```
        showToast("商品編碼只能大寫英數、底線、連字號", { kind: "error" });
```
> 注意：上方的 `if (!/^[A-Z0-9_-]+$/.test(data.sku)) {` 驗證 regex 不動，只改 toast 文字。

- [ ] **Step 5: 跑測試確認 products 那兩個斷言轉綠**

Run: `bun test tests/terminology-zhtw.test.ts`

Expected: `products/index.astro` 的「面向使用者文案不得含 SKU / slug / fen」與「必含中文新詞商品編碼」兩個 test **PASS**；`product-groups/index.astro` 相關 test 仍 FAIL（Task 3/4 處理）。整體 exit code 仍非 0（因 groups 尚未改）。

- [ ] **Step 6: 確認 .astro 仍可編譯（型別/語法 gate）**

Run: `bun run build`

Expected: build 成功（含 `astro build` 對 `.astro` 的編譯/型別檢查通過），無 error。若因環境缺 `PUBLIC_ORDER_TOKEN` 而在 deploy guard 前的 `astro build` 階段成功即可——本 step 只關心 `astro build` 編譯通過，不需 `wrangler deploy`。
> 若 `bun run build` 在本機因缺 Cloudflare 綁定/token 報非編譯類錯誤（例如 deploy guard），改跑純編譯：`bunx astro build` 已含於 `build`；只要 `.astro` 模板與 `<script>` TS 編譯無誤即視為通過，文字改動不影響型別。

- [ ] **Step 7: Commit**

```bash
git add src/pages/admin/products/index.astro
git commit -m "i18n(admin): SKU → 商品編碼 in products page copy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: product-groups/index.astro — SKU → 商品編碼 + slug → 品種代碼

**Files:**
- Modify: `src/pages/admin/product-groups/index.astro:97-99`（提示段，含 fen 明文與 SKU）
- Modify: `src/pages/admin/product-groups/index.astro:127`（群組 slug 顯示）
- Modify: `src/pages/admin/product-groups/index.astro:141`（群組內 SKU 標籤）
- Test: `tests/terminology-zhtw.test.ts`（沿用 Task 1）

> 本 Task 處理 SKU/slug 兩字 + 提示段的 fen 明文（B1/B2/B4）；下一個 Task 4 專門處理 L133-135 的 `({g.stock_fen} fen)` 副標移除（B3，含 DOM 節點刪除）。

- [ ] **Step 1: 改提示段——移除 fen 明文 + SKU→商品編碼（B1）**

此為 L96-102 的整個 `<p>`。Edit `old_string`：
```
    <p class="mb-4 text-sm text-gray-600">
      V5.2：每個品種共用一個重量池（fen，1 fen = 0.01 斤）。
      下訂時系統會自動依 SKU 的包裝大小（如半斤=50、1 斤=100）從這個池扣 fen。
      <br />
      進貨／校正請填「斤」(可用小數，例如 30 或 0.5)，正數=進貨，負數=校正/報廢。
      所有變動會記入變更紀錄。
    </p>
```
`new_string`：
```
    <p class="mb-4 text-sm text-gray-600">
      V5.2：每個品種共用一個重量池（以「斤」計，可到小數第二位）。
      下訂時系統會自動依商品編碼的包裝大小（如半斤、1 斤）從這個池扣庫存。
      <br />
      進貨／校正請填「斤」(可用小數，例如 30 或 0.5)，正數=進貨，負數=校正/報廢。
      所有變動會記入變更紀錄。
    </p>
```
> 改點：①「（fen，1 fen = 0.01 斤）」→「（以「斤」計，可到小數第二位）」移除 fen 明文；②「依 SKU 的」→「依商品編碼的」；③「（如半斤=50、1 斤=100）」這串 `=50`/`=100` 是 fen 值的暗示，改為「（如半斤、1 斤）」避免露出 fen 數字；④句尾「扣 fen」→「扣庫存」。

- [ ] **Step 2: 改群組 slug 顯示（B2）**

Edit `old_string`：
```
                <div class="font-mono text-xs text-gray-500">{g.slug}</div>
```
`new_string`：
```
                <div class="font-mono text-xs text-gray-500">品種代碼：{g.slug}</div>
```
> `{g.slug}` 是動態值（如 `jinhuang`）保留；只在前面加中文 label「品種代碼：」。

- [ ] **Step 3: 改群組內 SKU 標籤（B4）**

Edit `old_string`：
```
                包含 SKU：
```
`new_string`：
```
                包含商品編碼：
```

- [ ] **Step 4: 跑測試（groups 的 SKU/slug 應消失，但 fen 副標仍在 → 仍 FAIL）**

Run: `bun test tests/terminology-zhtw.test.ts`

Expected: `product-groups/index.astro` 的「必含中文新詞商品編碼與品種代碼」**PASS**；但「面向使用者文案不得含 SKU / slug / fen」**仍 FAIL**——因為 L134 `({g.stock_fen} fen)` 的尾巴 `fen` 還沒移除（Task 4 處理）。錯誤訊息應只剩指向該行的 `fen`：
```
error: product-groups/index.astro: 第 134 行的面向使用者文案仍含禁字 "fen"：({g.stock_fen} fen)
```
> 這是預期中的「部分轉綠」：SKU/slug 已清，獨留 fen 副標給 Task 4。

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/product-groups/index.astro
git commit -m "i18n(admin): SKU→商品編碼, slug→品種代碼 in stock-pool copy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: product-groups/index.astro — 移除 fen 明文副標

**Files:**
- Modify: `src/pages/admin/product-groups/index.astro:133-135`（移除 `({g.stock_fen} fen)` 副標 `<div>`）
- Test: `tests/terminology-zhtw.test.ts`（沿用 Task 1）

> spec §5.4：「移除 `fen` 明文顯示（97、130-135、146、287，UI 只留「斤」，fen 純內部）」。L97 已於 Task 3 處理；L146 經實查為 `{fenToJin(s.package_fen)} 斤/包`（無明文 fen，不改，見改動清單 B5）；L130-135 的真正明文 fen 是 L134 的 `({g.stock_fen} fen)` 副標，本 Task 移除整個 `data-current-fen-label` `<div>`。L287 在 `<script>` 內為 `// 0.01 斤 = 1 fen.` 註解（非文案，不改）。

- [ ] **Step 1: 先確認 `<script>` 未引用 `data-current-fen-label`（安全前置檢查）**

Run: `grep -n "data-current-fen-label" src/pages/admin/product-groups/index.astro`

Expected: 只回 1 行——即 L133 的模板宣告本身：
```
133:                <div class="text-xs text-gray-500" data-current-fen-label>
```
若**只有這 1 個 hit**，代表 JS 沒有 `querySelector('[data-current-fen-label]')`，移除該 DOM 節點不會留下死碼或 runtime null，可安全刪除。
> 若意外出現第 2 個 hit（JS 端讀取），**停止**並改為：保留節點但把可見文字 `({g.stock_fen} fen)` 改為不含 fen 的內容（例如刪除節點內文字、保留空 div），同時不動 JS 讀取——但依目前讀檔結果不會發生（JS 僅讀 `data-current-fen` 與 `data-group-card`）。

- [ ] **Step 2: 移除 fen 副標 `<div>`（B3）**

此為 L129-136 的 `<div class="text-right">` 區塊。移除其中的 fen 副標子節點，保留上方「斤」大字。Edit `old_string`：
```
              <div class="text-right">
                <div class="text-2xl font-bold text-mango-700" data-current-jin>
                  {fenToJin(g.stock_fen)} 斤
                </div>
                <div class="text-xs text-gray-500" data-current-fen-label>
                  ({g.stock_fen} fen)
                </div>
              </div>
```
`new_string`：
```
              <div class="text-right">
                <div class="text-2xl font-bold text-mango-700" data-current-jin>
                  {fenToJin(g.stock_fen)} 斤
                </div>
              </div>
```
> 保留 `data-current-jin` 大字（顯示「X.XX 斤」）；只刪掉 `data-current-fen-label` 那個 `({g.stock_fen} fen)` 副標。`data-current-fen`（在 L122 `<article ... data-current-fen={g.stock_fen}>`，attribute 形式）**不動**——它是 JS `card.dataset.currentFen` 樂觀鎖比對的來源（L292 `Number(card.dataset.currentFen)`）。

- [ ] **Step 3: 跑測試確認**全綠**

Run: `bun test tests/terminology-zhtw.test.ts`

Expected: 全部 6 個 test **PASS**，exit code 0。輸出形如：
```
 6 pass
 0 fail
```

- [ ] **Step 4: 跑全測試確保沒弄壞別的（無 stage env 時純單元應通過）**

Run: `bun test tests/terminology-zhtw.test.ts tests/stock-helper.test.ts tests/items-hash.test.ts tests/csp.test.ts tests/deploy-token-guard.test.ts`

Expected: 這幾支純單元（無 env）全 PASS。本任務未碰它們對應的 production code，理應不受影響——此 step 只是確認術語測試與既有純單元無衝突（例如沒誤刪到共用檔）。
> 不跑 `bun test`（全量）以免觸發 stage 整合測試在無 env 時的 abort/skip 噪音；CLAUDE.md「Testing」載明 stage-dependent 測試需 `MANGO_STAGE_URL`/`TEST_TOKEN`。

- [ ] **Step 5: 確認 .astro 仍可編譯**

Run: `bun run build`

Expected: build 成功，`.astro` 編譯無 error（同 Task 2 Step 6 的判準；只要 `astro build` 編譯階段通過即可）。

- [ ] **Step 6: Commit**

```bash
git add src/pages/admin/product-groups/index.astro
git commit -m "i18n(admin): drop raw fen subscript, show 斤 only in stock pool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 視覺確認（spec §5.4 要求的「視覺確認」）

**Files:** 無（只跑 dev server + 截圖，不改 production code）

> spec §5.4/§7 要求「grep 斷言 + 視覺確認」。Task 1-4 已完成 grep 斷言（自動化測試）；本 Task 補視覺確認：實際開兩頁看中文 label 正確、版面無破。需登入後台（`/admin`），故須有 stage 或本機 dev 的 admin session。

- [ ] **Step 1: 啟動 dev server**

Run（背景執行）: `bun run dev`

Expected: Astro dev server 起在 `http://localhost:4321`（或 console 顯示的 port），含 Cloudflare bindings（`platformProxy`）。

- [ ] **Step 2: 視覺確認「商品管理」頁**

用 `/browse` skill 或瀏覽器開 `http://localhost:4321/admin/products`（需先登入 `/admin/login`）。逐項核對：
- 既有列表表頭第一欄顯示「商品編碼」（非 SKU）。
- 「新增商品」區表頭第一欄顯示「商品編碼」。
- 新增表單第一個輸入框 placeholder 顯示「商品編碼」。
- 提示段顯示「不要刪商品編碼（會破壞舊訂單品項關聯）。」。
- 故意在新增表單第一格輸入小寫 `abc` 送出 → toast 顯示「商品編碼只能大寫英數、底線、連字號」（驗 regex 仍生效、文案中文）。

截圖存證（若用 `/browse`：take annotated screenshot）。

- [ ] **Step 3: 視覺確認「庫存池（進貨）」頁**

開 `http://localhost:4321/admin/product-groups`。逐項核對：
- 頂部提示段不含「fen」字樣，改述「以『斤』計，可到小數第二位…依商品編碼的包裝大小…從這個池扣庫存」。
- 每個品種卡右上只顯示「X.XX 斤」大字，**底下不再有「(NNN fen)」副標**。
- 每個品種卡標題下顯示「品種代碼：xxx」。
- 群組內品項列顯示「包含商品編碼：…」（非「包含 SKU：」）。
- 「最近 20 筆庫存變動」區（若有資料）金額仍顯示「斤」、版面正常。

截圖存證。

- [ ] **Step 4: 關閉 dev server**

停掉背景的 `bun run dev`（Ctrl-C 或結束該背景程序）。

- [ ] **Step 5: 視覺確認無 production 改動，不需 commit**

本 Task 不產生程式碼變更（無 `git add`）。若截圖檔想保留，存到 `docs/` 之外的暫存區即可，不納入版控。

---

## Self-Review（撰寫者已執行）

**1. Spec 覆蓋（§5.4 + §5.7 術語部分）**

| spec §5.4 盤點點 | 對應 Task | 狀態 |
|---|---|---|
| products: 表頭 SKU（46/124） | Task 2 Step 2 | ✅ replace_all 兩處 |
| products: placeholder/aria-label（138-140） | Task 2 Step 3 | ✅ |
| products: 驗證 toast（355） | Task 2 Step 4 | ✅ |
| products: 每列 aria-label（64/75/87/98/108） | 改動清單 A7/A8 | ✅ 實查後皆為「動態SKU值+中文」或已中文，無字面術語可改，並由測試掃描守住 |
| products: 不要刪 SKU 提示（33，盤點外但屬面向使用者） | Task 2 Step 1 | ✅ 一併中文化 |
| product-groups: 「包含 SKU：」 | Task 3 Step 3 | ✅ |
| product-groups: 移除 fen 明文（97/130-135/146/287） | Task 3 Step1 + Task 4 | ✅ 97→Task3；134→Task4；146 實查無明文(B5)；287 為註解不改 |
| product-groups: slug（34/127） | Task 3 Step 2 | ✅ 127→「品種代碼：」；34 為 frontmatter `.orderBy(...products.slug)` 程式碼非文案，不改 |
| §5.7 術語中文化（全後台一致詞表） | 全 Task | ✅ 詞表已對齊 spec §5.4 表 |

> spec §5.4 列「slug（34、127）」，但 L34 是 `.orderBy(asc(product_groups.display_order), asc(product_groups.slug))`（Drizzle 查詢欄位，frontmatter 程式碼），非面向使用者文案——依「後端零改、不動欄位」鐵則保留。僅 L127 顯示用 slug 需改。已在 open_concerns 標注。

**2. Placeholder 掃描**：全計畫無 TBD/TODO；每個 code step 附完整 `old_string`/`new_string` 或完整測試碼；每個 run step 附精確指令與預期輸出。無「類似 Task N」。✅

**3. 型別/名稱一致性**：測試只用 `readFileSync`/正則，無跨 Task 函式簽名。production 改動全是字串替換，未引入新型別/函式。`data-current-fen`（保留）vs `data-current-fen-label`（移除）已明確區分，避免誤刪 JS 依賴的 attribute。✅

**4. 範圍鐵則複查**：無任何 step 改 `name=`/`pattern=`/regex/`data-*` 名/TS 介面/API/路由；後端檔案一律未列入 Files。✅
