# P8 — 後台易用性 / 可發現性 實作計畫（spec §5.7）

> 對應 spec：`docs/superpowers/specs/2026-06-06-v6-admin-selfservice-design.md` §5.7（後台易用性 + 可發現性）。
> 術語中文化（詞表）屬 §5.4，由 **P2** 模組負責；本計畫**不改任何 UI 文字詞表**，只做導航 / 儀表板 / 麵包屑 / 空狀態 / 無權限提示等結構與資料呈現。

## 這份計畫給誰看

你是對 **mango-hsu 這個 codebase 零 context** 的工程師。照著做就能完成 P8，不需要先讀懂整個專案。每一步都標了精確檔案路徑、完整程式碼、要跑的指令與預期輸出。每步約 2–5 分鐘。

### 你需要先知道的最小背景

- **技術棧**：Astro 6 SSR on Cloudflare Workers + D1（SQLite）+ Drizzle ORM + Tailwind v4。執行器是 **Bun**（`bun test`、`bun run ...`）。
- **後台頁面**在 `src/pages/admin/**`（`.astro` 檔，frontmatter 在 `---` 之間跑在 server 端）。
- **共用版面**是 `src/layouts/Layout.astro`：它有一段「登入後的後台 header 導航」，目前長在 `Layout.astro:42-90`，admin 分支在 `51-67`。判斷是否顯示後台導航的變數叫 `isAdminShell`（= `pathname.startsWith("/admin") && !!session`）。
- **登入 session**：middleware（`src/middleware.ts`）驗證 cookie `mh_session` 後，把 `{ email, role }` 塞進 `Astro.locals.session`。`role` 只有兩種值：`"admin"` 或 `"operator"`。每個後台頁 frontmatter 都會 `const session = Astro.locals.session; if (!session) return Astro.redirect("/admin/login");`。
- **role 條件顯示既有慣例**：只有 `admin` 能看到「商品管理 / 庫存池」，`operator` 看不到（見 `src/pages/admin/index.astro:99` 的 `{session.role === "admin" && (...)}`）。**沿用此慣例，不要改授權邏輯。**
- **庫存模型（讀懂這段就夠做儀表板）**：庫存存在 `product_groups.stock_fen`（INTEGER，單位 `fen`，1 斤 = 100 fen）。每個品種群組一個池。「某包裝還剩幾包」是**推導**出來的：`Math.floor(group.stock_fen / sku.package_fen)`（這個式子已在 `src/pages/admin/orders/new.astro` 用過）。儀表板只需顯示**各品種池剩餘斤數** = `stock_fen / 100`。
- **「當季」是什麼**：`seasons` 表最多一列 `status = 'active'`。讀當季的標準寫法（已在 `src/pages/admin/product-groups/index.astro:21-26` 用過）：
  ```ts
  const activeSeasonRows = await db.select().from(seasons).where(eq(seasons.status, "active")).limit(1);
  const activeSeason = activeSeasonRows[0] ?? null;
  ```
- **Tailwind v4**：用 `@import "tailwindcss"` + `@theme` 自訂色（`src/styles/global.css`）。專案有自訂色階 `mango-50..900`（如 `bg-mango-600`、`text-mango-700`）。觸控目標慣例：互動元素加 `min-h-[44px]`。手機/桌機切換用 `sm:` 前綴。
- **Astro 元件 client 端 script**：用 `<script>`（會被 bundle、type-checked）。元件內傳變數給 inline script 用 `define:vars`（見 `src/components/admin/Modal.astro:62`）。

### 與其他 P 模組的對接點（重要：本計畫只「預留位置」，不實作對方功能）

| 對接 | 來源模組 | 本計畫怎麼處理 |
|---|---|---|
| 導航多一個「年度設定」入口，連到 `/admin/seasons` | **P5（季節管理）** 會建立 `/admin/seasons` 頁 | 本計畫在導航**加上連到 `/admin/seasons` 的連結**。若該頁尚未存在，連結點下去會 404——這是預期的、由 P5 補上。導航結構不依賴該頁存在。 |
| 儀表板「各品種剩餘庫存」資料來源 | **P4（庫存/儀表板數據）** 同樣讀 `product_groups.stock_fen` | 本計畫**直接讀 `product_groups` + `seasons`**（與 `product-groups/index.astro` 同樣的 query），不依賴 P4 產出任何新 API。若 P4 之後抽了共用 query helper，可在收尾時 refactor，但**本計畫自帶完整可運行的讀取邏輯**。 |
| 術語中文化（SKU→商品編碼 等） | **P2** | 本計畫**不碰**任何詞表文字。導航標籤用「訂單 / 年度設定 / 品種庫存 / 商品 / 紀錄 / 設定 / 帳號」這組（spec §5.7 明列），P2 若要微調文字屬另一模組。 |

---

## 全域設計決策（先讀，影響每個 Task）

1. **可測試邏輯抽成純函式**：導航項目清單 + 「目前在哪一頁」的 active 判定，以及儀表板的「低量標紅」門檻判定，都抽到 `src/lib/` 的純 TypeScript module（無 Astro、無 env、無 DB）。這樣能用 `bun test`（純單元，無 stage env）做**真正的 TDD**。Astro 元件只負責把這些純函式的輸出 render 成 HTML。
2. **UI 結構用 stage 整合測試做「存在性斷言」**：頁面 render 對不對，用對 stage worker 發 HTTP GET、抓回 HTML、`expect(html).toContain(...)` 驗關鍵元素存在。需 stage env（見最下方「測試環境」）。
3. **不改授權**：`operator` 看不到的東西繼續看不到；無權限頁從「`admin only` 純文字」升級成「友善說明頁」，但 **HTTP status 仍是 403**（不可降級成 200，避免測試/監控誤判）。
4. **不改任何既有 API 行為、不改 DB schema**。本模組純前端結構 + 既有資料讀取。
5. **commit 頻繁**：每個 Task 結束 commit 一次。

---

## Task 0：建立工作分支

**Files**：無（git 操作）

- [ ] 確認在乾淨的 working tree（除了已知的 `M CLAUDE.md`，那不屬本計畫，先 stash 或忽略）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git status --short
  ```
- [ ] 從 `main` 開出本模組分支：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git checkout -b feature/v6-p8-admin-ux
  ```
  預期輸出含 `Switched to a new branch 'feature/v6-p8-admin-ux'`。

---

## Task 1：導航模型純函式 `admin-nav.ts`（TDD）

把「後台導航有哪些項目」與「目前 pathname 對應哪個項目（active）」抽成純函式。這是整個導航強化的可測試核心。

**Files**
- Create: `src/lib/admin-nav.ts`
- Test: `tests/admin-nav.test.ts`

### Step 1.1 — 先寫失敗測試

- [ ] 建立 `tests/admin-nav.test.ts`，完整內容：

```ts
// Pure unit test (no stage env). Tests the admin nav model + active detection.
import { describe, expect, it } from "bun:test";
import { ADMIN_NAV_ITEMS, navItemsForRole, activeNavKey } from "../src/lib/admin-nav";

describe("admin-nav model", () => {
  it("exposes the seven V6 nav items in declared order", () => {
    const keys = ADMIN_NAV_ITEMS.map((i) => i.key);
    expect(keys).toEqual([
      "orders",
      "seasons",
      "groups",
      "products",
      "audit",
      "settings",
      "account",
    ]);
  });

  it("every item has a non-empty label and an /admin href", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.href.startsWith("/admin")).toBe(true);
    }
  });

  it("operator role hides admin-only items (products, groups, seasons, settings)", () => {
    const operatorKeys = navItemsForRole("operator").map((i) => i.key);
    expect(operatorKeys).toEqual(["orders", "audit", "account"]);
  });

  it("admin role sees every item", () => {
    const adminKeys = navItemsForRole("admin").map((i) => i.key);
    expect(adminKeys).toEqual([
      "orders",
      "seasons",
      "groups",
      "products",
      "audit",
      "settings",
      "account",
    ]);
  });

  it("activeNavKey matches the longest href prefix of the current path", () => {
    expect(activeNavKey("/admin/orders")).toBe("orders");
    expect(activeNavKey("/admin/orders/M-20260606-001")).toBe("orders");
    expect(activeNavKey("/admin/orders/new")).toBe("orders");
    expect(activeNavKey("/admin/product-groups")).toBe("groups");
    expect(activeNavKey("/admin/products")).toBe("products");
    expect(activeNavKey("/admin/seasons")).toBe("seasons");
    expect(activeNavKey("/admin/audit")).toBe("audit");
    expect(activeNavKey("/admin/change-password")).toBe("account");
  });

  it("does NOT mis-match /admin/products as /admin/product-groups (or vice versa)", () => {
    // 'groups' href is /admin/product-groups; 'products' href is /admin/products.
    // /admin/products must not be swallowed by the shorter shared 'product' string.
    expect(activeNavKey("/admin/products")).toBe("products");
    expect(activeNavKey("/admin/product-groups")).toBe("groups");
  });

  it("returns null when no item matches (e.g. dashboard root)", () => {
    expect(activeNavKey("/admin")).toBeNull();
    expect(activeNavKey("/admin/")).toBeNull();
  });
});
```

- [ ] 跑測試，**確認 FAIL**（module 還不存在）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun test tests/admin-nav.test.ts
  ```
  預期：`error: Cannot find module '../src/lib/admin-nav'`（或解析失敗），測試不通過。這是預期的紅燈。

### Step 1.2 — 最小實作

- [ ] 建立 `src/lib/admin-nav.ts`，完整內容：

```ts
// V6 §5.7 — admin nav model.
// Pure (no Astro / env / DB) so it can be unit-tested and shared by both the
// desktop header and the mobile drawer in Layout.astro.
//
// Active detection uses LONGEST matching href prefix so /admin/products is never
// swallowed by a shorter shared substring, and /admin (dashboard root) maps to no
// item (the dashboard isn't in the nav list — its own "管理後台" title stands in).

export type AdminRole = "admin" | "operator";

export interface AdminNavItem {
  key: string;
  label: string;
  href: string;
  /** Visible to operators too. When false, only admins see it. */
  operatorVisible: boolean;
}

// Declared order is the on-screen order (spec §5.7: 訂單 / 年度設定 / 品種庫存 / 商品 / 紀錄 / 設定 / 帳號).
// "seasons" links to /admin/seasons (built by P5; link is harmless before that page exists).
// "settings" links to /admin/seasons too for now (shipping config lives on the season page per
// spec §5.5); P5/P3 own that page. Keeping a distinct key lets us re-point it later without
// touching callers.
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { key: "orders", label: "訂單", href: "/admin/orders", operatorVisible: true },
  { key: "seasons", label: "年度設定", href: "/admin/seasons", operatorVisible: false },
  { key: "groups", label: "品種庫存", href: "/admin/product-groups", operatorVisible: false },
  { key: "products", label: "商品", href: "/admin/products", operatorVisible: false },
  { key: "audit", label: "紀錄", href: "/admin/audit", operatorVisible: true },
  { key: "settings", label: "設定", href: "/admin/seasons", operatorVisible: false },
  { key: "account", label: "帳號", href: "/admin/change-password", operatorVisible: true },
] as const;

export function navItemsForRole(role: AdminRole): AdminNavItem[] {
  if (role === "admin") return [...ADMIN_NAV_ITEMS];
  return ADMIN_NAV_ITEMS.filter((i) => i.operatorVisible);
}

// Returns the key of the nav item whose href is the longest prefix of `pathname`,
// or null if none matches. A match requires the path to equal the href or continue
// with a "/" so /admin/products doesn't match an href of /admin/product.
export function activeNavKey(pathname: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const item of ADMIN_NAV_ITEMS) {
    const h = item.href;
    const isMatch = pathname === h || pathname.startsWith(h + "/");
    if (!isMatch) continue;
    if (!best || h.length > best.len) {
      best = { key: item.key, len: h.length };
    }
  }
  return best ? best.key : null;
}
```

> 注意：`settings` 與 `seasons` 兩個 item 都連到 `/admin/seasons`。`activeNavKey` 用「最長前綴 + 同長取較長者」，當路徑是 `/admin/seasons` 時兩者 href 等長（都 `/admin/seasons`），迴圈先碰到 `seasons`（宣告在前），之後 `settings` 同長不會覆蓋（用 `>` 嚴格大於），所以 `/admin/seasons` 正確 active 在 `seasons`。測試已涵蓋 `activeNavKey("/admin/seasons") === "seasons"`。

- [ ] 跑測試，**確認 PASS**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun test tests/admin-nav.test.ts
  ```
  預期：`8 pass`、`0 fail`（檔內 8 個 `it`）。

### Step 1.3 — commit

- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/lib/admin-nav.ts tests/admin-nav.test.ts && git commit -m "$(cat <<'EOF'
feat(admin-ux): pure admin-nav model + active detection (P8)

Nav item list (role-scoped) and longest-prefix active key extracted as a
pure module so the desktop header and mobile drawer in Layout.astro share
one source of truth. Unit-tested with no stage env.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 2：儀表板低量門檻純函式 `admin-dashboard.ts`（TDD）

抽出「某品種池剩餘幾斤、是否低量該標紅」的純邏輯。

**Files**
- Create: `src/lib/admin-dashboard.ts`
- Test: `tests/admin-dashboard.test.ts`

### Step 2.1 — 先寫失敗測試

- [ ] 建立 `tests/admin-dashboard.test.ts`，完整內容：

```ts
// Pure unit test (no stage env). Tests dashboard stock-summary derivation:
// fen -> jin display + low-stock flag.
import { describe, expect, it } from "bun:test";
import {
  LOW_STOCK_THRESHOLD_FEN,
  fenToJinLabel,
  groupStockSummary,
} from "../src/lib/admin-dashboard";

describe("admin-dashboard stock summary", () => {
  it("fenToJinLabel converts fen to 斤 with 2 decimals", () => {
    expect(fenToJinLabel(0)).toBe("0.00");
    expect(fenToJinLabel(100)).toBe("1.00");
    expect(fenToJinLabel(50)).toBe("0.50");
    expect(fenToJinLabel(1234)).toBe("12.34");
  });

  it("low-stock threshold is 5 斤 (500 fen)", () => {
    expect(LOW_STOCK_THRESHOLD_FEN).toBe(500);
  });

  it("flags low when stock_fen is at or below the threshold", () => {
    const rows = [
      { id: 1, name: "金煌芒果乾", stock_fen: 2000 }, // 20 斤 — ok
      { id: 2, name: "愛文芒果乾", stock_fen: 500 }, //  5 斤 — low (boundary, inclusive)
      { id: 3, name: "土芒果乾", stock_fen: 0 }, //      0 斤 — low + sold out
    ];
    const summary = groupStockSummary(rows);
    expect(summary).toEqual([
      { id: 1, name: "金煌芒果乾", stock_fen: 2000, jin: "20.00", low: false, soldOut: false },
      { id: 2, name: "愛文芒果乾", stock_fen: 500, jin: "5.00", low: true, soldOut: false },
      { id: 3, name: "土芒果乾", stock_fen: 0, jin: "0.00", low: true, soldOut: true },
    ]);
  });

  it("treats just-above-threshold as not low", () => {
    const [s] = groupStockSummary([{ id: 9, name: "x", stock_fen: 501 }]);
    expect(s!.low).toBe(false);
  });

  it("returns an empty array for no groups", () => {
    expect(groupStockSummary([])).toEqual([]);
  });
});
```

- [ ] 跑測試，**確認 FAIL**（module 不存在）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun test tests/admin-dashboard.test.ts
  ```
  預期：`Cannot find module '../src/lib/admin-dashboard'`，紅燈。

### Step 2.2 — 最小實作

- [ ] 建立 `src/lib/admin-dashboard.ts`，完整內容：

```ts
// V6 §5.7 — admin home operations dashboard helpers.
// Pure (no env/DB): the .astro page reads product_groups rows, then maps them
// through groupStockSummary for display. Keeping it pure makes the "low stock"
// rule unit-testable and consistent.

// 1 斤 = 100 fen. "Low stock" = pool at or below 5 斤; surface in red so the
// shop owner restocks before customers hit 售完.
export const LOW_STOCK_THRESHOLD_FEN = 500;

export function fenToJinLabel(fen: number): string {
  return (fen / 100).toFixed(2);
}

export interface GroupStockRow {
  id: number;
  name: string;
  stock_fen: number;
}

export interface GroupStockSummaryItem {
  id: number;
  name: string;
  stock_fen: number;
  jin: string;
  low: boolean;
  soldOut: boolean;
}

export function groupStockSummary(rows: GroupStockRow[]): GroupStockSummaryItem[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    stock_fen: r.stock_fen,
    jin: fenToJinLabel(r.stock_fen),
    low: r.stock_fen <= LOW_STOCK_THRESHOLD_FEN,
    soldOut: r.stock_fen <= 0,
  }));
}
```

- [ ] 跑測試，**確認 PASS**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun test tests/admin-dashboard.test.ts
  ```
  預期：`5 pass`、`0 fail`。

### Step 2.3 — commit

- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/lib/admin-dashboard.ts tests/admin-dashboard.test.ts && git commit -m "$(cat <<'EOF'
feat(admin-ux): pure dashboard stock-summary helper (P8)

fen->斤 label + low-stock (<=5斤) / sold-out flags, unit-tested with no env.
The admin home page maps product_groups rows through this for the per-flavour
remaining-stock panel.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 3：可重用麵包屑元件 `AdminBreadcrumb.astro`

提供頁面層級導引。純展示元件，接受一個 `items` 陣列（label + 可選 href）。

**Files**
- Create: `src/components/admin/AdminBreadcrumb.astro`
- Test: 由 Task 9 的 stage HTML 整合測試覆蓋（此步先不寫測試，元件無邏輯）

### Step 3.1 — 建立元件

- [ ] 建立 `src/components/admin/AdminBreadcrumb.astro`，完整內容：

```astro
---
// V6 §5.7 — admin breadcrumb. Pure presentational, no client JS.
// Usage:
//   <AdminBreadcrumb items={[{ label: "後台首頁", href: "/admin" }, { label: "商品" }]} />
// The last item is the current page (no href -> rendered as plain aria-current text).
interface Crumb {
  label: string;
  href?: string;
}
interface Props {
  items: Crumb[];
}
const { items } = Astro.props;
---

<nav aria-label="麵包屑" class="mb-4 text-sm text-gray-600" data-admin-breadcrumb>
  <ol class="flex flex-wrap items-center gap-1">
    {items.map((c, i) => (
      <li class="flex items-center gap-1">
        {i > 0 && <span aria-hidden="true" class="text-gray-300">/</span>}
        {c.href ? (
          <a href={c.href} class="rounded px-1 py-0.5 hover:bg-mango-100 hover:text-mango-700 underline">
            {c.label}
          </a>
        ) : (
          <span aria-current="page" class="px-1 py-0.5 font-medium text-gray-800">
            {c.label}
          </span>
        )}
      </li>
    ))}
  </ol>
</nav>
```

### Step 3.2 — 型別檢查 + commit

- [ ] 跑型別檢查確認元件無誤（`astro check` 會編譯全部 `.astro`）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -20
  ```
  預期：結尾出現 `0 errors`（warnings 可忽略；若出現與本檔無關的既有 warning 也可接受，但**不可有 error**）。
- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/components/admin/AdminBreadcrumb.astro && git commit -m "$(cat <<'EOF'
feat(admin-ux): reusable AdminBreadcrumb component (P8)

Presentational breadcrumb; last item is aria-current="page". Used across admin
sub-pages for hierarchy wayfinding.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 4：全域導航強化 — 改寫 `Layout.astro` 後台 header（桌機 active 標示 + 手機 drawer）

把 `Layout.astro:51-67` 寫死的 5 連結，換成由 `admin-nav.ts` 驅動、含 active 標示與手機抽屜的導航。

> ⚠️ **跨模組協調（總編加註）**：`src/layouts/Layout.astro` 的 admin nav **也是 P5（季節管理）Task 8 的改動點**——P5 會在原始 5 連結 nav 內插入一個「年度」連結。本 Task 4 的整段重寫**取代並涵蓋** P5 那筆改動（`admin-nav.ts` 的 `ADMIN_NAV_ITEMS` 已含 `seasons`→`/admin/seasons` 的「年度設定」項）。合併順序固定 **P5 先、P8 後**：執行本 Task 時，下方 Step 4.2 的 `old_string` 是 **main 原始的 5 連結 nav**；若 P5 已先落地（nav 已被插入「年度」連結），該 `old_string` 會比對不到——此時請**先 `Read` Layout.astro 的 admin nav 區塊取得當前實際內容**，把整段（含 P5 加的「年度」連結）一併納入 `old_string` 後再用本 Task 的 data-driven 版本取代之（最終結果一致：data-driven nav 已含年度入口）。詳見 master 計畫「跨模組檔案爭用」表。

**Files**
- Modify: `src/layouts/Layout.astro:1-19`（frontmatter：import nav model + 算 navItems/activeKey）
- Modify: `src/layouts/Layout.astro:51-67`（admin 分支的 `<nav>`；若 P5 先落地則含其加的「年度」連結，見上方協調註）
- Test: Task 9 stage HTML 整合測試

### Step 4.1 — frontmatter 加 import 與計算

目前 `Layout.astro` frontmatter（1-19 行）長這樣：

```
1	---
2	import "../styles/global.css";
3	
4	interface Props {
...
16	const pathname = Astro.url.pathname;
17	const session = (Astro.locals as { session?: { email: string; role: string } }).session;
18	const isAdminShell = pathname.startsWith("/admin") && !!session;
19	---
```

- [ ] 在 `Layout.astro` 第 2 行 `import "../styles/global.css";` 之後，新增一行 import（用 Edit，把該 import 行替換為兩行）：

  old_string:
  ```
  import "../styles/global.css";
  ```
  new_string:
  ```
  import "../styles/global.css";
  import { navItemsForRole, activeNavKey, type AdminRole } from "../lib/admin-nav";
  ```

- [ ] 在 `isAdminShell` 那一行之後（第 18 行後、`---` 之前）插入導航計算。用 Edit：

  old_string:
  ```
  const isAdminShell = pathname.startsWith("/admin") && !!session;
  ---
  ```
  new_string:
  ```
  const isAdminShell = pathname.startsWith("/admin") && !!session;
  const adminNavItems = isAdminShell
    ? navItemsForRole((session!.role as AdminRole) === "admin" ? "admin" : "operator")
    : [];
  const adminActiveKey = isAdminShell ? activeNavKey(pathname) : null;
  ---
  ```

> 說明：`session.role` 型別是 `string`，這裡正規化成 `"admin" | "operator"`（非 admin 一律當 operator，與既有 role 慣例一致——只有 `admin` 看得到較多項目）。

### Step 4.2 — 改寫 admin 分支的 `<nav>`（桌機 + 手機 drawer）

目前 `Layout.astro:51-67` 是：

```
51	        {isAdminShell ? (
52	          <nav class="flex flex-wrap items-center gap-0.5 sm:gap-1 text-sm justify-end">
53	            <a href="/admin/orders" ...>訂單</a>
...
66	            </a>
67	          </nav>
```

- [ ] 用 Edit 整段替換。

  old_string（從 `{isAdminShell ? (` 到對應的 `</nav>`，即 51-67 行那一整塊）：
  ```
        {isAdminShell ? (
          <nav class="flex flex-wrap items-center gap-0.5 sm:gap-1 text-sm justify-end">
            <a href="/admin/orders" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">訂單</a>
            <a href="/admin/products" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">商品</a>
            <a href="/admin/product-groups" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">
              <span class="sm:hidden">庫存</span>
              <span class="hidden sm:inline">庫存池</span>
            </a>
            <a href="/admin/audit" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">
              <span class="sm:hidden">紀錄</span>
              <span class="hidden sm:inline">變更紀錄</span>
            </a>
            <a href="/admin/change-password" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">
              <span class="sm:hidden">密碼</span>
              <span class="hidden sm:inline">變更密碼</span>
            </a>
          </nav>
        ) : (
  ```

  new_string：
  ```
        {isAdminShell ? (
          <>
            {/* Desktop: inline nav with active marker. Hidden on mobile. */}
            <nav aria-label="後台導航" class="hidden sm:flex flex-wrap items-center gap-1 text-sm justify-end">
              {adminNavItems.map((item) => (
                <a
                  href={item.href}
                  aria-current={adminActiveKey === item.key ? "page" : undefined}
                  class:list={[
                    "inline-flex items-center min-h-[44px] px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700",
                    adminActiveKey === item.key
                      ? "bg-mango-100 text-mango-700 font-semibold"
                      : "",
                  ]}
                >
                  {item.label}
                </a>
              ))}
            </nav>
            {/* Mobile: hamburger toggles a drawer. Hidden on desktop. */}
            <button
              type="button"
              data-admin-drawer-toggle
              aria-label="開啟選單"
              aria-expanded="false"
              aria-controls="admin-drawer"
              class="sm:hidden inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded hover:bg-mango-100 hover:text-mango-700"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-6 w-6" aria-hidden="true">
                <path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </>
        ) : (
  ```

### Step 4.3 — 在 header 後加手機 drawer 容器 + 開關 script

drawer 本體放在 `</header>` 之後、`<main>` 之前。目前 `Layout.astro` 第 76-78 行是：

```
76	    </header>
77	
78	    <main class="flex-1">
```

- [ ] 用 Edit 在 `</header>` 與 `<main>` 之間插入 drawer。

  old_string:
  ```
    </header>

    <main class="flex-1">
  ```
  new_string:
  ```
    </header>

    {isAdminShell && (
      <div
        id="admin-drawer"
        data-admin-drawer
        hidden
        class="sm:hidden fixed inset-0 z-40"
      >
        <div data-admin-drawer-backdrop class="absolute inset-0 bg-black/40"></div>
        <nav
          aria-label="後台選單"
          class="absolute right-0 top-0 h-full w-64 max-w-[80vw] bg-white shadow-xl p-4 flex flex-col gap-1 overflow-y-auto"
        >
          <div class="mb-2 flex items-center justify-between">
            <span class="font-bold text-mango-700">選單</span>
            <button
              type="button"
              data-admin-drawer-close
              aria-label="關閉選單"
              class="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded hover:bg-mango-100"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-6 w-6" aria-hidden="true">
                <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          {adminNavItems.map((item) => (
            <a
              href={item.href}
              aria-current={adminActiveKey === item.key ? "page" : undefined}
              class:list={[
                "inline-flex items-center min-h-[44px] px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700",
                adminActiveKey === item.key ? "bg-mango-100 text-mango-700 font-semibold" : "",
              ]}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>

      <script>
        const toggle = document.querySelector<HTMLButtonElement>("[data-admin-drawer-toggle]");
        const drawer = document.querySelector<HTMLElement>("[data-admin-drawer]");
        const backdrop = document.querySelector<HTMLElement>("[data-admin-drawer-backdrop]");
        const closeBtn = document.querySelector<HTMLButtonElement>("[data-admin-drawer-close]");

        function openDrawer(): void {
          if (!drawer || !toggle) return;
          drawer.hidden = false;
          toggle.setAttribute("aria-expanded", "true");
          document.body.style.overflow = "hidden";
        }
        function closeDrawer(): void {
          if (!drawer || !toggle) return;
          drawer.hidden = true;
          toggle.setAttribute("aria-expanded", "false");
          document.body.style.overflow = "";
        }

        toggle?.addEventListener("click", openDrawer);
        closeBtn?.addEventListener("click", closeDrawer);
        backdrop?.addEventListener("click", closeDrawer);
        document.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && drawer && !drawer.hidden) closeDrawer();
        });
      </script>
    )}

    <main class="flex-1">
  ```

### Step 4.4 — 型別檢查 + 啟動 dev server 目視

- [ ] 型別檢查：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -20
  ```
  預期：`0 errors`。
- [ ] （目視，選擇性但建議）啟動 dev server，登入後台，桌機看 active 標示、縮到手機寬度看 hamburger + drawer 開合：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun run dev
  ```
  在瀏覽器開 `http://localhost:4321/admin/login` 登入後，目視確認：(a) 桌機 header 七個項目（admin 角色），目前頁高亮；(b) 視窗縮窄到 < 640px 時 header 變 hamburger，點開出現右側抽屜，點背景/✕/Esc 都能關。確認後 `Ctrl-C` 結束 dev server。

### Step 4.5 — commit

- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/layouts/Layout.astro && git commit -m "$(cat <<'EOF'
feat(admin-ux): data-driven header nav with active marker + mobile drawer (P8)

Layout.astro admin nav now renders from admin-nav model (role-scoped), marks the
current page via aria-current + highlight, and adds a hamburger drawer under sm.
Adds the 年度設定/設定 entries (link to /admin/seasons, built by P5).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 5：首頁營運儀表板 — `admin/index.astro` 加當季 + 各品種剩餘庫存 + 快速操作

在現有 KPI（`admin/index.astro:51-64`）之上，加「當季是哪一年」橫幅與「各品種剩餘庫存（斤，低量標紅）」面板；快速操作沿用現有 nav 區（86-127）。

**Files**
- Modify: `src/pages/admin/index.astro:1-40`（frontmatter：讀 activeSeason + 各群組 stock）
- Modify: `src/pages/admin/index.astro:51-64`（KPI 區後插入儀表板區塊）
- Test: Task 9 stage HTML 整合測試

### Step 5.1 — frontmatter 補資料讀取

目前 `admin/index.astro` frontmatter（1-40 行）已 import `makeDb, orders, sql/desc/eq/and, activeOrdersFilter, env` 並算了 total/pendingPaid/pendingShip/recent。

- [ ] 用 Edit 擴充 import 行。

  old_string:
  ```
  import Layout from "../../layouts/Layout.astro";
  import { makeDb } from "../../db/client";
  import { orders } from "../../db/schema";
  import { sql, desc, eq, and } from "drizzle-orm";
  import { activeOrdersFilter } from "../../lib/orders-query";
  import { env } from "../../lib/env";
  ```
  new_string:
  ```
  import Layout from "../../layouts/Layout.astro";
  import { makeDb } from "../../db/client";
  import { orders, seasons, product_groups } from "../../db/schema";
  import { sql, desc, eq, asc } from "drizzle-orm";
  import { activeOrdersFilter } from "../../lib/orders-query";
  import { groupStockSummary } from "../../lib/admin-dashboard";
  import { env } from "../../lib/env";
  ```

> 註：原 import 含 `and`，但 `admin/index.astro` 現況沒用到 `and`（grep 過：只有 `eq`、`sql`、`desc` 在用）。改成 `asc`（儀表板群組排序要用）。若你的型別檢查抱怨未使用 import，這步已順手移除 `and`。

- [ ] 在 `recent` 查詢之後（第 39 行 `.limit(5);` 之後、`---` 之前）插入當季 + 群組庫存讀取。用 Edit：

  old_string:
  ```
  const recent = await db
    .select()
    .from(orders)
    .where(activeOrdersFilter)
    .orderBy(desc(orders.created_at))
    .limit(5);
  ---
  ```
  new_string:
  ```
  const recent = await db
    .select()
    .from(orders)
    .where(activeOrdersFilter)
    .orderBy(desc(orders.created_at))
    .limit(5);

  // V6 §5.7 dashboard: active season + per-group remaining stock.
  const activeSeasonRows = await db
    .select()
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const activeSeason = activeSeasonRows[0] ?? null;

  const groupRows = activeSeason
    ? await db
        .select({
          id: product_groups.id,
          name: product_groups.name,
          stock_fen: product_groups.stock_fen,
        })
        .from(product_groups)
        .where(eq(product_groups.season_id, activeSeason.id))
        .orderBy(asc(product_groups.display_order), asc(product_groups.slug))
    : [];

  const stockSummary = groupStockSummary(groupRows);
  ---
  ```

### Step 5.2 — KPI 後插入儀表板區塊

目前 `admin/index.astro:51-64` 是 KPI 三格 `<div class="mb-8 grid grid-cols-3 gap-4">...</div>`，其後第 66 行是 `<h2 class="mb-3 text-lg font-bold">最近訂單</h2>`。

- [ ] 用 Edit 在 KPI grid 與「最近訂單」之間插入。

  old_string:
  ```
        <div class="rounded border border-gray-200 p-4">
          <div class="text-sm text-gray-600">待出貨</div>
          <div class="mt-1 text-3xl font-bold text-orange-600">{pendingShip}</div>
        </div>
      </div>

      <h2 class="mb-3 text-lg font-bold">最近訂單</h2>
  ```
  new_string:
  ```
        <div class="rounded border border-gray-200 p-4">
          <div class="text-sm text-gray-600">待出貨</div>
          <div class="mt-1 text-3xl font-bold text-orange-600">{pendingShip}</div>
        </div>
      </div>

      {/* V6 §5.7 — current season banner */}
      {activeSeason ? (
        <p class="mb-6 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          當季：<strong>{activeSeason.name}</strong>（{activeSeason.code}）
        </p>
      ) : (
        <p class="mb-6 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          尚未設定當季年度。請先到「年度設定」建立並啟用一個年度。
          {session.role === "admin" && (
            <a href="/admin/seasons" class="ml-1 underline">前往年度設定 →</a>
          )}
        </p>
      )}

      {/* V6 §5.7 — per-flavour remaining stock (low = red) */}
      {activeSeason && (
        <section class="mb-8" aria-label="各品種剩餘庫存">
          <div class="mb-2 flex items-baseline justify-between">
            <h2 class="text-lg font-bold">各品種剩餘庫存</h2>
            {session.role === "admin" && (
              <a href="/admin/product-groups" class="text-sm text-mango-700 underline">進貨／校正 →</a>
            )}
          </div>
          {stockSummary.length > 0 ? (
            <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2" data-stock-summary>
              {stockSummary.map((g) => (
                <li
                  class:list={[
                    "rounded border p-4 flex items-baseline justify-between",
                    g.low ? "border-red-300 bg-red-50" : "border-gray-200",
                  ]}
                  data-group-id={g.id}
                >
                  <span class="font-medium">{g.name}</span>
                  <span class="text-right">
                    <span class:list={["text-2xl font-bold", g.low ? "text-red-600" : "text-mango-700"]}>
                      {g.jin} 斤
                    </span>
                    {g.soldOut ? (
                      <span class="ml-2 rounded bg-red-600 px-2 py-0.5 text-xs text-white">售完</span>
                    ) : g.low ? (
                      <span class="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">低量</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="rounded border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
              當季尚無品種。
              {session.role === "admin" && (
                <a href="/admin/products" class="ml-1 text-mango-700 underline">先到「商品」建立 SKU →</a>
              )}
            </p>
          )}
        </section>
      )}

      <h2 class="mb-3 text-lg font-bold">最近訂單</h2>
  ```

### Step 5.3 — 型別檢查 + commit

- [ ] 型別檢查：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -20
  ```
  預期：`0 errors`。
- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/index.astro && git commit -m "$(cat <<'EOF'
feat(admin-ux): home dashboard — current season + per-flavour stock (P8)

Adds a 當季年度 banner and a per-group remaining-stock panel (低量<=5斤 in red,
售完 badge) above 最近訂單. Reads product_groups for the active season directly;
maps through the pure groupStockSummary helper.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 6：友善無權限頁 `AdminForbidden.astro` + 套用到 admin-only 頁

目前 `operator` 進 `/admin/products`、`/admin/product-groups` 收到的是裸 `new Response("admin only", { status: 403 })`（白畫面純文字）。spec §5.7 要求「無權限頁顯示說明而非空白」。改為 render 一個套版的友善 403 頁，**HTTP status 維持 403**。

**Files**
- Create: `src/components/admin/AdminForbidden.astro`
- Modify: `src/pages/admin/products/index.astro:11-13`
- Modify: `src/pages/admin/product-groups/index.astro:15-17`
- Test: Task 9 stage HTML 整合測試（驗 403 + 友善文字）

### Step 6.1 — 建立友善 403 元件

- [ ] 建立 `src/components/admin/AdminForbidden.astro`，完整內容：

```astro
---
// V6 §5.7 — friendly "no permission" page body. The PAGE keeps returning HTTP 403;
// this just replaces the blank "admin only" text with an explanation + a way back.
// Usage in a page frontmatter:
//   if (session.role !== "admin") {
//     return new Response(await renderForbidden(Astro), {
//       status: 403, headers: { "Content-Type": "text/html; charset=utf-8" },
//     });
//   }
// But Astro pages render via the template, not a string, so we instead render this
// component and set Astro.response.status = 403 (see page edits).
interface Props {
  reason?: string;
}
const { reason = "這個頁面只有管理員（admin）能進入。" } = Astro.props;
---

<Layout title="沒有權限">
  <main class="mx-auto max-w-md px-4 py-16 text-center">
    <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-6 w-6 text-amber-600" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
    </div>
    <h1 class="mb-2 text-xl font-bold">沒有權限</h1>
    <p class="mb-6 text-sm text-gray-600">{reason}</p>
    <div class="flex justify-center gap-3">
      <a href="/admin" class="rounded bg-mango-600 px-4 py-2 text-sm text-white hover:bg-mango-700">回後台首頁</a>
      <a href="/admin/orders" class="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">前往訂單</a>
    </div>
  </main>
</Layout>

<script>
  import Layout from "../../layouts/Layout.astro";
</script>
```

> **重要修正**：Astro 元件不能在 frontmatter 用 `import Layout` 再於 `<script>` import——上面的寫法錯了。改用下面 Step 6.2 的正確版本覆蓋。先建立檔案再覆蓋，避免你照抄到錯版。

### Step 6.2 — 用正確版本覆蓋 `AdminForbidden.astro`

- [ ] 用 Write **覆蓋** `src/components/admin/AdminForbidden.astro` 為正確內容（frontmatter import Layout，移除錯誤 `<script>`）：

```astro
---
// V6 §5.7 — friendly "no permission" page. Renders a full Layout body with an
// explanation and links back. The PAGE that uses it must set the 403 status via
// `Astro.response.status = 403` (Astro pages can't both render a template and
// return a Response, so status is set on Astro.response).
import Layout from "../../layouts/Layout.astro";
interface Props {
  reason?: string;
}
const { reason = "這個頁面只有管理員（admin）能進入。" } = Astro.props;
---

<Layout title="沒有權限">
  <main class="mx-auto max-w-md px-4 py-16 text-center">
    <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-6 w-6 text-amber-600" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
    </div>
    <h1 class="mb-2 text-xl font-bold">沒有權限</h1>
    <p class="mb-6 text-sm text-gray-600">{reason}</p>
    <div class="flex justify-center gap-3">
      <a href="/admin" class="rounded bg-mango-600 px-4 py-2 text-sm text-white hover:bg-mango-700">回後台首頁</a>
      <a href="/admin/orders" class="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">前往訂單</a>
    </div>
  </main>
</Layout>
```

### Step 6.3 — 套到 `products/index.astro`

目前 `src/pages/admin/products/index.astro:1-13`：

```
1	---
2	import Layout from "../../../layouts/Layout.astro";
3	import StickyBar from "../../../components/admin/StickyBar.astro";
...
9	const session = Astro.locals.session;
10	if (!session) return Astro.redirect("/admin/login");
11	if (session.role !== "admin") {
12	  return new Response("admin only", { status: 403 });
13	}
```

- [ ] 用 Edit 加 import（在 StickyBar import 後）：

  old_string:
  ```
  import StickyBar from "../../../components/admin/StickyBar.astro";
  ```
  new_string:
  ```
  import StickyBar from "../../../components/admin/StickyBar.astro";
  import AdminForbidden from "../../../components/admin/AdminForbidden.astro";
  ```

- [ ] 用 Edit 把 403 區塊改成「設定 status + 標記 render 友善頁」。因為 Astro 頁無法同時 `return new Response(...)` 又 render 模板，做法是：設一個 frontmatter 旗標，set `Astro.response.status = 403`，在模板頂端用旗標短路 render `<AdminForbidden/>`。

  old_string:
  ```
  const session = Astro.locals.session;
  if (!session) return Astro.redirect("/admin/login");
  if (session.role !== "admin") {
    return new Response("admin only", { status: 403 });
  }
  ```
  new_string:
  ```
  const session = Astro.locals.session;
  if (!session) return Astro.redirect("/admin/login");
  const forbidden = session.role !== "admin";
  if (forbidden) {
    Astro.response.status = 403;
  }
  ```

- [ ] 在模板開頭短路 render。`products/index.astro` 模板從第 22 行 `<Layout title="商品管理">` 開始。用 Edit：

  old_string:
  ```
  ---

  <Layout title="商品管理">
  ```
  new_string:
  ```
  ---

  {forbidden ? (
    <AdminForbidden reason="商品管理只有管理員（admin）能進入。" />
  ) : (
  <Layout title="商品管理">
  ```

  > 這會用 `( ... )` 包住整個既有 `<Layout>...</Layout>`。需在檔尾補上對應的 `)}` 收尾——見下一步。

- [ ] `products/index.astro` 檔尾目前是（376-377 行附近）：
  ```
    </script>
  </Layout>
  ```
  用 Edit 在 `</Layout>` 後補 `)}`：

  old_string:
  ```
    </script>
  </Layout>
  ```
  new_string:
  ```
    </script>
  </Layout>
  )}
  ```

  > 注意：`products/index.astro` 內可能有多處 `</script>` 換行緊接 `</Layout>` 嗎？實際只有檔尾一處 `</Layout>`（grep 確認：`</Layout>` 僅出現在最後）。若 Edit 報「不唯一」，改用更長的 old_string 把前一行 `consumeFlash();` 一併納入比對：
  > old_string 改為（含更多上下文）：
  > ```
  >     consumeFlash();
  >   </script>
  > </Layout>
  > ```
  > new_string：
  > ```
  >     consumeFlash();
  >   </script>
  > </Layout>
  > )}
  > ```

### Step 6.4 — 套到 `product-groups/index.astro`（同模式）

目前 `src/pages/admin/product-groups/index.astro:1-17`：

```
1	---
2	import Layout from "../../../layouts/Layout.astro";
...
13	const session = Astro.locals.session;
14	if (!session) return Astro.redirect("/admin/login");
15	if (session.role !== "admin") {
16	  return new Response("admin only", { status: 403 });
17	}
```

- [ ] 加 import（在 Layout import 後）。用 Edit：

  old_string:
  ```
  import Layout from "../../../layouts/Layout.astro";
  import { makeDb } from "../../../db/client";
  ```
  new_string:
  ```
  import Layout from "../../../layouts/Layout.astro";
  import AdminForbidden from "../../../components/admin/AdminForbidden.astro";
  import { makeDb } from "../../../db/client";
  ```

- [ ] 改 403 區塊。用 Edit：

  old_string:
  ```
  const session = Astro.locals.session;
  if (!session) return Astro.redirect("/admin/login");
  if (session.role !== "admin") {
    return new Response("admin only", { status: 403 });
  }
  ```
  new_string:
  ```
  const session = Astro.locals.session;
  if (!session) return Astro.redirect("/admin/login");
  const forbidden = session.role !== "admin";
  if (forbidden) {
    Astro.response.status = 403;
  }
  ```

- [ ] 短路 render。`product-groups/index.astro` 模板從第 89 行 `<Layout title="庫存池管理">` 開始。用 Edit：

  old_string:
  ```
  ---

  <Layout title="庫存池管理">
  ```
  new_string:
  ```
  ---

  {forbidden ? (
    <AdminForbidden reason="品種庫存只有管理員（admin）能進入。" />
  ) : (
  <Layout title="庫存池管理">
  ```

- [ ] 檔尾補 `)}`。`product-groups/index.astro` 檔尾（357-358 行附近）是：
  ```
    </script>
  </Layout>
  ```
  用 Edit：

  old_string:
  ```
    consumeFlash();
  </script>
</Layout>
  ```
  new_string:
  ```
    consumeFlash();
  </script>
</Layout>
)}
  ```

  > 若上述 old_string 因縮排不符而比對失敗：先 `Read` 該檔最後 6 行確認確切縮排，再據實貼上。`product-groups/index.astro` 的 `consumeFlash();` 在 `<script>` 內，縮排為 4 space（見原檔第 356 行 `    consumeFlash();`）。

### Step 6.5 — 型別檢查 + commit

- [ ] 型別檢查：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -25
  ```
  預期：`0 errors`。若報 `AdminForbidden` 未使用——確認你兩個頁面模板都已加上 `{forbidden ? (<AdminForbidden .../>) : (...)}`。
- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/components/admin/AdminForbidden.astro src/pages/admin/products/index.astro src/pages/admin/product-groups/index.astro && git commit -m "$(cat <<'EOF'
feat(admin-ux): friendly 403 page for operator-blocked admin pages (P8)

operator hitting /admin/products or /admin/product-groups now gets an explained
"沒有權限" page with links back instead of a blank "admin only" string. HTTP
status stays 403 (set via Astro.response.status) so monitoring/tests still see it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 7：麵包屑套到 admin 子頁

把 `AdminBreadcrumb` 加到主要 admin 子頁，取代/補強現有的「← 後台首頁」散裝連結。範圍控制：只動 4 個頁面（products、product-groups、audit、orders 列表），其餘頁由各自 P 模組或後續處理。

**Files**
- Modify: `src/pages/admin/products/index.astro`（header 區）
- Modify: `src/pages/admin/product-groups/index.astro`（header 區）
- Modify: `src/pages/admin/audit.astro`（header 區）
- Modify: `src/pages/admin/orders/index.astro`（header 區）
- Test: Task 9 stage HTML 整合測試

### Step 7.1 — products/index.astro 加麵包屑

`products/index.astro` 的 `<main>` 與 header 目前（22-30 行附近）：
```
  <main class="mx-auto max-w-3xl px-4 py-6 pb-32">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold">商品管理</h1>
```
（注意：本檔已在 Task 6 把 import 加進去，但 `AdminBreadcrumb` 尚未 import。）

- [ ] 加 import（在 AdminForbidden import 後）。用 Edit：

  old_string:
  ```
  import AdminForbidden from "../../../components/admin/AdminForbidden.astro";
  ```
  new_string:
  ```
  import AdminForbidden from "../../../components/admin/AdminForbidden.astro";
  import AdminBreadcrumb from "../../../components/admin/AdminBreadcrumb.astro";
  ```

- [ ] 在 `<main ...>` 之後、`<header>` 之前插入麵包屑。用 Edit：

  old_string:
  ```
    <main class="mx-auto max-w-3xl px-4 py-6 pb-32">
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">商品管理</h1>
  ```
  new_string:
  ```
    <main class="mx-auto max-w-3xl px-4 py-6 pb-32">
      <AdminBreadcrumb items={[{ label: "後台首頁", href: "/admin" }, { label: "商品" }]} />
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">商品管理</h1>
  ```

### Step 7.2 — product-groups/index.astro 加麵包屑

- [ ] 加 import（在 AdminForbidden import 後）。用 Edit：

  old_string:
  ```
  import AdminForbidden from "../../../components/admin/AdminForbidden.astro";
  import { makeDb } from "../../../db/client";
  ```
  new_string:
  ```
  import AdminForbidden from "../../../components/admin/AdminForbidden.astro";
  import AdminBreadcrumb from "../../../components/admin/AdminBreadcrumb.astro";
  import { makeDb } from "../../../db/client";
  ```

- [ ] `product-groups/index.astro` 的 `<main>`/header 目前（90-92 行）：
  ```
    <main class="mx-auto max-w-3xl px-4 py-6 pb-12">
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">庫存池（進貨）</h1>
  ```
  用 Edit 插入麵包屑：

  old_string:
  ```
    <main class="mx-auto max-w-3xl px-4 py-6 pb-12">
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">庫存池（進貨）</h1>
  ```
  new_string:
  ```
    <main class="mx-auto max-w-3xl px-4 py-6 pb-12">
      <AdminBreadcrumb items={[{ label: "後台首頁", href: "/admin" }, { label: "品種庫存" }]} />
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">庫存池（進貨）</h1>
  ```

### Step 7.3 — audit.astro 加麵包屑

`audit.astro`（51-54 行）：
```
<Layout title="變更紀錄">
  <main class="mx-auto max-w-5xl px-4 py-6">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold">變更紀錄</h1>
```

- [ ] 加 import。`audit.astro` 第 2 行是 `import Layout from "../../layouts/Layout.astro";`。用 Edit：

  old_string:
  ```
  import Layout from "../../layouts/Layout.astro";
  import { makeDb } from "../../db/client";
  ```
  new_string:
  ```
  import Layout from "../../layouts/Layout.astro";
  import AdminBreadcrumb from "../../components/admin/AdminBreadcrumb.astro";
  import { makeDb } from "../../db/client";
  ```

- [ ] 插入麵包屑。用 Edit：

  old_string:
  ```
  <Layout title="變更紀錄">
    <main class="mx-auto max-w-5xl px-4 py-6">
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">變更紀錄</h1>
  ```
  new_string:
  ```
  <Layout title="變更紀錄">
    <main class="mx-auto max-w-5xl px-4 py-6">
      <AdminBreadcrumb items={[{ label: "後台首頁", href: "/admin" }, { label: "紀錄" }]} />
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">變更紀錄</h1>
  ```

### Step 7.4 — orders/index.astro 加麵包屑

`orders/index.astro`（81-84 行）：
```
<Layout>
  <main class="mx-auto max-w-5xl px-4 py-6">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold">訂單列表</h1>
```

- [ ] 加 import。`orders/index.astro` 第 2 行 `import Layout from "../../../layouts/Layout.astro";`。用 Edit：

  old_string:
  ```
  import Layout from "../../../layouts/Layout.astro";
  import { makeDb } from "../../../db/client";
  ```
  new_string:
  ```
  import Layout from "../../../layouts/Layout.astro";
  import AdminBreadcrumb from "../../../components/admin/AdminBreadcrumb.astro";
  import { makeDb } from "../../../db/client";
  ```

- [ ] 插入麵包屑。用 Edit：

  old_string:
  ```
  <Layout>
    <main class="mx-auto max-w-5xl px-4 py-6">
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">訂單列表</h1>
  ```
  new_string:
  ```
  <Layout>
    <main class="mx-auto max-w-5xl px-4 py-6">
      <AdminBreadcrumb items={[{ label: "後台首頁", href: "/admin" }, { label: "訂單" }]} />
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">訂單列表</h1>
  ```

### Step 7.5 — 型別檢查 + commit

- [ ] 型別檢查：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -20
  ```
  預期：`0 errors`。
- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/products/index.astro src/pages/admin/product-groups/index.astro src/pages/admin/audit.astro src/pages/admin/orders/index.astro && git commit -m "$(cat <<'EOF'
feat(admin-ux): breadcrumbs on products / groups / audit / orders pages (P8)

Adds AdminBreadcrumb (後台首頁 / <page>) to the four main admin sub-pages for
consistent wayfinding.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 8：空狀態引導補強

確認/補強「還沒建群組或品項時，告訴店主下一步」。`product-groups/index.astro` 已有一段空狀態（189-193 行）；`products/index.astro` 的空狀態只有「（尚無商品）」太弱。本 Task 升級 products 的空狀態為含「下一步」引導，並確認 groups 空狀態文案指向下一步。

**Files**
- Modify: `src/pages/admin/products/index.astro:116-118`（空狀態列）
- Test: Task 9 stage HTML 整合測試

### Step 8.1 — 升級 products 空狀態

目前 `products/index.astro:116-118`：
```
      {productRows.length === 0 && (
        <li class="px-4 py-6 text-center text-sm text-gray-500">（尚無商品）</li>
      )}
```

- [ ] 用 Edit 升級：

  old_string:
  ```
        {productRows.length === 0 && (
          <li class="px-4 py-6 text-center text-sm text-gray-500">（尚無商品）</li>
        )}
  ```
  new_string:
  ```
        {productRows.length === 0 && (
          <li class="px-4 py-8 text-center text-sm text-gray-500">
            <p class="mb-1 font-medium text-gray-700">還沒有任何商品</p>
            <p>下一步：用下方「新增商品」表單建立第一個品項（記得選所屬品種與包裝大小）。</p>
            <p class="mt-1">建立後可到
              <a href="/admin/product-groups" class="text-mango-700 underline">品種庫存</a>
              進貨。
            </p>
          </li>
        )}
  ```

> 註：spec §5.3 指出新增表單目前缺「所屬群組 / 包裝大小」欄位（P3 模組會補）。本計畫**不改新增表單欄位**，只在空狀態文案提及「選所屬品種與包裝大小」作為引導；實際欄位由 P3 補上。若 P3 尚未合併，文案仍正確（提示店主將需要選這些）。

### Step 8.2 — groups 空狀態確認（已存在，僅驗文案不需改）

- [ ] 確認 `product-groups/index.astro:189-193` 既有空狀態仍在且文案合理：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && sed -n '189,193p' src/pages/admin/product-groups/index.astro
  ```
  > 例外：本檔禁止用 `cat/sed` 編輯，但此處僅**唯讀檢視**確認文案，可接受；亦可改用 `Read` 工具讀該範圍。預期看到既有引導文字「當季尚無品種。請先到『商品管理』建立 SKU…」。**此段不需修改**。

### Step 8.3 — 型別檢查 + commit

- [ ] 型別檢查：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -15
  ```
  預期：`0 errors`。
- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/products/index.astro && git commit -m "$(cat <<'EOF'
feat(admin-ux): actionable empty state on products page (P8)

Empty product list now guides the owner to the next step (create first SKU, then
restock via 品種庫存) instead of a bare "(尚無商品)".

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 9：stage HTML 存在性整合測試

對 stage worker 發 HTTP，抓回 admin 頁 HTML，斷言 P8 新元素存在。這需要 stage env（見「測試環境」）。整合測試覆蓋導航項目、儀表板、麵包屑、友善 403。

**Files**
- Create: `tests/admin-ux-html.test.ts`
- Test: 本身就是 test

### Step 9.1 — 寫整合測試

- [ ] 建立 `tests/admin-ux-html.test.ts`，完整內容：

```ts
// V6 §5.7 — stage HTML existence assertions for admin UX shell.
// Fetches rendered admin pages over HTTP (real SSR) and asserts P8 elements exist.
// Requires MANGO_STAGE_URL + TEST_TOKEN + a stage admin session (wrangler login).
//
// We hit the stage worker directly (NOT stageFetch — that forces Content-Type: json,
// and we want plain GET for HTML). Auth uses the same test session cookie helper as
// the endpoint tests.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  createTestAdminSession,
  cleanupTestAdmin,
  d1Execute,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const OPERATOR_EMAIL = "test-operator@local";

let adminCookie = "";
let operatorCookie = "";

async function getHtml(path: string, cookie: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${STAGE_URL}${path}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  const html = await res.text();
  return { status: res.status, html };
}

beforeAll(() => {
  if (SKIP) return;
  cleanupTestAdmin();
  adminCookie = createTestAdminSession(); // admin role by default
  // Build an operator session: createTestAdminSession upserts an admin; downgrade a
  // second user to operator manually.
  const token = `test-${crypto.randomUUID()}`;
  const expires = new Date(Date.now() + 3600_000).toISOString();
  d1Execute(
    `INSERT OR REPLACE INTO admin_users (email, password_hash, role, must_change_password, created_at)
     VALUES ('${OPERATOR_EMAIL}', 'test-hash-not-real', 'operator', 0, '${new Date().toISOString()}')`,
  );
  d1Execute(
    `INSERT INTO sessions (token, user_email, expires_at) VALUES ('${token}', '${OPERATOR_EMAIL}', '${expires}')`,
  );
  operatorCookie = `mh_session=${token}`;
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestAdmin();
});

describe("admin UX HTML shell (P8)", () => {
  it("header nav renders the V6 entries for an admin", async () => {
    if (SKIP) return;
    const { status, html } = await getHtml("/admin/orders", adminCookie);
    expect(status).toBe(200);
    // The seven labels from admin-nav model (settings + seasons share an href but
    // both labels render). Assert the distinctive new ones exist.
    expect(html).toContain("年度設定");
    expect(html).toContain("品種庫存");
    expect(html).toContain('href="/admin/seasons"');
    // active marker on the current (orders) page
    expect(html).toContain('aria-current="page"');
  });

  it("mobile drawer toggle is present in the admin shell", async () => {
    if (SKIP) return;
    const { html } = await getHtml("/admin/orders", adminCookie);
    expect(html).toContain("data-admin-drawer-toggle");
    expect(html).toContain('id="admin-drawer"');
  });

  it("home dashboard shows the current-season region and stock summary container", async () => {
    if (SKIP) return;
    const { status, html } = await getHtml("/admin", adminCookie);
    expect(status).toBe(200);
    expect(html).toContain("各品種剩餘庫存");
    // either the active-season banner ("當季：") or the no-season prompt renders;
    // both contain "當季" / "年度". Assert at least the section heading exists above.
  });

  it("breadcrumb renders on the orders list", async () => {
    if (SKIP) return;
    const { html } = await getHtml("/admin/orders", adminCookie);
    expect(html).toContain("data-admin-breadcrumb");
    expect(html).toContain('aria-label="麵包屑"');
  });

  it("operator gets a friendly 403 (not blank) on /admin/products", async () => {
    if (SKIP) return;
    const { status, html } = await getHtml("/admin/products", operatorCookie);
    expect(status).toBe(403);
    expect(html).toContain("沒有權限");
    expect(html).toContain('href="/admin"'); // a way back
    // must NOT be the old blank string
    expect(html.trim()).not.toBe("admin only");
  });

  it("operator does NOT see admin-only nav items", async () => {
    if (SKIP) return;
    const { html } = await getHtml("/admin/orders", operatorCookie);
    // operator nav = orders / audit / account only; no 品種庫存 / 商品 / 年度設定 links
    expect(html).not.toContain('href="/admin/product-groups"');
    expect(html).not.toContain('href="/admin/seasons"');
  });
});
```

### Step 9.2 — 跑整合測試

- [ ] 確認 stage env 已設（見「測試環境」段），然後跑：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun test tests/admin-ux-html.test.ts
  ```
  預期：`6 pass`、`0 fail`。
  - 若顯示全部 skip（`6 skip` 或 0 個 assertion 跑到），代表 `MANGO_STAGE_URL` / `TEST_TOKEN` 未設或 `wrangler login` 未完成——此時 `skipIfNoIntegration()` 回 true，測試被略過（不算失敗，但你需要設好 env 才能真正驗證）。
  - 若 `operator does NOT see admin-only nav items` 失敗，多半是 stage 上目前部署的 worker 還是舊版（沒有本 P8 改動）。整合測試是對**已部署的 stage worker** 發請求，**必須先把本分支部署到 stage** 才會反映新 UI：先 `bun run deploy:stage`（注意 deploy 前置條件見 CLAUDE.md 的 PUBLIC_ORDER_TOKEN 規則），再跑此測試。若 CI 流程是「PR 合併後才部署 stage」，則此整合測試在本機 dev 階段可能先 skip，待 stage 部署後於 QA 階段補跑。

### Step 9.3 — commit

- [ ] commit：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add tests/admin-ux-html.test.ts && git commit -m "$(cat <<'EOF'
test(admin-ux): stage HTML existence assertions for P8 shell

Asserts header nav (V6 entries + active marker), mobile drawer toggle, dashboard
stock-summary region, breadcrumbs, and the friendly operator 403 all render.
Skips cleanly when stage env is absent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
  ```

---

## Task 10：全量驗證 + 收尾

**Files**：無新增（驗證 + 收尾）

### Step 10.1 — 跑全部純單元測試（無需 stage）

- [ ] 確認 P8 新增的純單元測試與既有純單元測試全綠：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun test tests/admin-nav.test.ts tests/admin-dashboard.test.ts tests/csp.test.ts tests/items-hash.test.ts tests/stock-helper.test.ts tests/deploy-token-guard.test.ts
  ```
  預期：全部 `pass`、`0 fail`。（前兩個是本模組新增；後四個是既有純單元，確認沒被波及。）

### Step 10.2 — 型別檢查全綠

- [ ] 全專案型別檢查：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -10
  ```
  預期：`0 errors`。

### Step 10.3 — build 通過（確認 SSR 能編譯本模組所有 .astro）

- [ ] 跑 build（會 type-check + 編譯）。注意：`bun run build` 即 `astro build`；**不要**跑 `deploy:*`（那會清快取並真的部署）。
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun run build 2>&1 | tail -20
  ```
  預期：結尾出現 `[build] Complete!`（或等義成功訊息），無 error。

### Step 10.4 —（選擇性）目視最終回歸

- [ ] `bun run dev` 後，以 admin 與 operator 兩種帳號各走一遍：
  - admin：首頁看到當季橫幅 + 各品種剩餘庫存（低量是否標紅，可暫時把某群組 `stock_fen` 改成 < 500 驗證紅色——記得改回）；導航七項、active 正確；手機 drawer 正常；products / groups / audit / orders 都有麵包屑。
  - operator：導航只有 訂單 / 紀錄 / 帳號；點 `/admin/products`（直接打網址）看到友善「沒有權限」頁（非白畫面）。
  - 確認後 `Ctrl-C`。

### Step 10.5 — 確認 diff 範圍乾淨

- [ ] 檢視本分支相對 main 的改動清單，確認**沒有**動到禁區（DB schema、wrangler、package.json、既有 API endpoint、intake/batch）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git diff --stat main...feature/v6-p8-admin-ux
  ```
  預期改動檔（白名單）：
  - `src/lib/admin-nav.ts`（新）
  - `src/lib/admin-dashboard.ts`（新）
  - `src/components/admin/AdminBreadcrumb.astro`（新）
  - `src/components/admin/AdminForbidden.astro`（新）
  - `src/layouts/Layout.astro`
  - `src/pages/admin/index.astro`
  - `src/pages/admin/products/index.astro`
  - `src/pages/admin/product-groups/index.astro`
  - `src/pages/admin/audit.astro`
  - `src/pages/admin/orders/index.astro`
  - `tests/admin-nav.test.ts`、`tests/admin-dashboard.test.ts`、`tests/admin-ux-html.test.ts`（新）
  - `docs/superpowers/plans/v6/P8-admin-ux.md`（本計畫）

  **若出現任何 `src/db/`、`drizzle/`、`wrangler.jsonc`、`package.json`、`src/pages/api/**` 的改動 → 你做錯了，回退那些檔。**

### Step 10.6 — 本模組 PR（若工作流程要求；否則交回總編彙整）

> 是否在此開 PR，依總編/上線策略（spec §6「一次到位」）決定。若要開：

- [ ] 推分支並開 PR（body 用 spec §5.7 摘要）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git push -u origin feature/v6-p8-admin-ux
  ```
  PR body 結尾需含：
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```

---

## 測試環境（跑整合測試前必讀）

純單元測試（`tests/admin-nav.test.ts`、`tests/admin-dashboard.test.ts`）**不需任何 env**，直接 `bun test <file>` 即可。

stage 整合測試（`tests/admin-ux-html.test.ts`）需要：
- `MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev`
- `TEST_TOKEN=<stage 的 ORDER_TOKEN>`（**絕不可用 prod 的**）
- 已 `wrangler login`（或設 `CLOUDFLARE_API_TOKEN`）——因為測試用 `d1Execute` 經 wrangler 對 stage D1 寫 session/admin 列。
- **且 stage 上已部署含本 P8 改動的 worker**（整合測試是對已部署 worker 發 HTTP，不是跑本機程式）。若尚未部署，這些測試會驗到舊 UI 而失敗——此時先 `bun run deploy:stage`（遵守 CLAUDE.md 的 PUBLIC_ORDER_TOKEN 前置規則）再跑，或在 stage 部署後的 QA 階段補跑。

測試資料慣例（已遵守）：admin/operator 測試帳號用 `@local` 結尾 email（`cleanupTestAdmin()` 會清）；session token 用 `test-` 前綴。本模組不建立 season/group/product 測試資料（儀表板讀 stage 既有的 `2026` active season 即可；若 stage 無 active season，儀表板測試只驗「各品種剩餘庫存」標題存在，仍會過）。

---

## 邊界與注意事項彙整（給執行者快速回顧）

1. **不改授權、不改 status code**：友善 403 頁 HTTP 仍是 403（`Astro.response.status = 403`）。operator 看不到的項目繼續看不到。
2. **`/admin/seasons` 連結現在可能 404**：那是 P5 的頁，本計畫只連過去。導航/儀表板**不依賴**該頁存在。
3. **儀表板資料自給自足**：直接讀 `product_groups` + `seasons`，與 `product-groups/index.astro` 同款 query，不依賴 P4 任何新 API。
4. **不碰詞表中文化**（P2）：導航標籤用 spec §5.7 明列那組即可。
5. **整合測試對「已部署 stage」生效**：本機開發階段可能 skip；務必在 stage 部署後補跑驗證。
6. **Edit 比對失敗時**：先用 `Read` 讀該檔對應行確認確切縮排/內容，再據實貼 old_string。本計畫所有行號以撰寫當下（main @ a58736d）為準。
7. **每個 Task 結束都 commit**，訊息結尾務必含 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
