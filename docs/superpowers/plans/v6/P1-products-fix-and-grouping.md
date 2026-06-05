# P1 — 品項管理：修復新增表單破洞 + 依群組分組顯示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修好「新增商品」表單（補送 `group_slug` 與 `package_fen`，目前缺這兩個必填欄位導致從 UI 新增任何 SKU 必失敗），並把品項清單改為「依品種群組分組」顯示。

**Architecture:** 純前端／Astro 頁面改動，後端 API 完全不碰。`src/pages/admin/products/index.astro` 的 frontmatter 額外查詢當季 `seasons` 與其 `product_groups`，把群組 `slug`+`name` 餵進新增表單的「所屬群組」下拉，並加「包裝大小」下拉（半斤=50 / 1斤=100 / 10斤=1000 → `package_fen`）。`readForm` 讀這兩個新欄位並一起 POST 給既有的 `/api/admin/products/create`（該端點 `create.ts:43-49` 早已要求這兩欄）。清單區改為先查當季 `product_groups`，再把 `products` 依 `group_id` 分組渲染（沿用既有 dirty-tracker / StickyBar / batch 儲存路徑，`data-sku` / `data-prod-field` / `data-dirty-key` 結構不變，只是包進每個群組的 `<section>`）。

**Tech Stack:** Astro 6 SSR、Cloudflare Workers + D1 + Drizzle、Tailwind v4、bun test（stage 整合測試，HTTP 打 stage worker；helper 在 `tests/_setup.ts`）。

---

## 背景事實（實作前必讀，已查證行號）

- **破洞位置**：`src/pages/admin/products/index.astro`
  - 新增表單 `<form id="create-form">` 在 **131-159 行**，欄位只有 `sku`/`name`/`variant`/`price`/`display_order`/`available`（132-150 行），**沒有** `group_slug`、`package_fen` 的 input。
  - `readForm()` 在 **329-344 行**，回傳物件只含 `name`/`variant`/`price`/`available`/`display_order`，**沒讀** `group_slug`、`package_fen`。
  - submit handler 在 **346-370 行**，組 `data` 時 `{ sku, ...readForm(createForm) }`（350-353 行）→ 送出的 JSON 缺這兩欄。
- **後端契約（不可改，本任務只負責讓前端符合它）**：`src/pages/api/admin/products/create.ts`
  - 第 **40-41 行** 讀 `groupSlug = (body.group_slug ?? "").trim()`、`package_fen = Number(body.package_fen)`。
  - 第 **47 行**：`if (!groupSlug || !/^[a-z0-9-]+$/.test(groupSlug)) return text("bad group_slug", 400);`
  - 第 **48-49 行**：`if (!Number.isInteger(package_fen) || package_fen <= 0 || package_fen > 100_000) return text("bad package_fen ...", 400);`
  - 第 **54-62 行**：解析 `status='active'` 的 season，無則回 `409 NO_ACTIVE_SEASON`。
  - 第 **64-76 行**：在當季用 `slug` 找 group，找不到回 `404 GROUP_NOT_FOUND`。
  - 第 **79-84 行**：當季 SKU 重複回 `409`。
  - 成功回 `json({ ok: true, sku }, 200)`，audit action 為 `'product_create'`（既有 action，本任務不新增 audit action）。
- **既有清單分組資料已有現成參考寫法**：`src/pages/admin/product-groups/index.astro` 的 frontmatter（21-55 行）已示範「查當季 season → 查當季 groups（依 `display_order`,`slug`）→ 查當季 products → 用 `Map<group_id, products[]>` 分組」，可直接照抄該模式到 products 頁。
- **包裝大小對照**（spec §5.3 / §4 庫存單位）：半斤 = `50` fen、1斤 = `100` fen、10斤 = `1000` fen。`package_fen` 單位是 fen（1斤 = 100 fen）。
- **新增表單目前在 121-160 行的 `<section>`**（標題「新增商品」在 122 行；欄位標頭 grid 在 123-130 行）。
- **既有清單在 41-119 行**的 `<ul data-dirty-track="products">`：標頭列 45-52 行；每列 `<li ... data-prod-row data-sku={p.sku}>` 53-114 行；空狀態 116-118 行。
- **frontmatter 目前 query**（16-19 行）只 `select().from(products).orderBy(asc(display_order), asc(sku))`，**沒有 season 過濾**。本任務改為查當季並依群組分組（與後端 create「只在當季建」一致；避免顯示跨季殘留 SKU）。

### 測試策略說明（為何 TDD 錨點是 HTTP）

本 codebase 的整合測試全部是「HTTP 打 stage worker」，`.astro` 頁面的 client script 無單元測試框架。因此本計畫的 TDD 失敗測試錨在兩個可驗證的 HTTP 契約上：

1. **後端契約測試**（`tests/products-create.test.ts`，新檔）：直接 POST `/api/admin/products/create` 帶 `group_slug`+`package_fen`，證明「修好的表單會送出的 payload」能成功建出 SKU；並覆蓋缺欄位 / 壞值 / GROUP_NOT_FOUND / 重複 / 授權 / CSRF。這個測試**不依賴**前端，但它鎖定的就是修好後表單必須送出的 JSON 形狀——前端改完後此契約仍綠即代表 payload 正確。
2. **頁面渲染測試**（同檔內）：用 admin session cookie `GET /admin/products`，斷言回傳的 HTML 內含新表單的 `name="group_slug"`、`name="package_fen"`、各群組 `<option>`、以及「依群組分組」的容器標記（`data-group-section` 與 `data-group-slug`）。SSR 頁面把 frontmatter 算好的群組直接渲染進 HTML，故 HTML 斷言能驗證 frontmatter + 模板的正確性，無需瀏覽器。

> 為什麼夠：前端 submit handler 只是把表單欄位塞進 `create` 的 JSON。只要 (a) 表單 HTML 真的有這兩個 input（頁面測試證明）且 (b) `create` 端點吃這個 payload 會成功（契約測試證明），破洞即修復。client-side handler 的字串組裝屬瑣碎、無分支邏輯，不另設瀏覽器測試（YAGNI）。

---

## Task 1：後端契約測試 — 帶 group_slug + package_fen 能成功新增，缺欄位則失敗

**Files:**
- Create: `tests/products-create.test.ts`

> 這個 Task 先把「修好的表單該送出什麼」鎖成可執行契約。此時前端尚未改，但 `create.ts` 端點本來就已實作；因此這些 API 測試應**直接通過**（它們驗的是端點，不是前端）。這一步的價值是：把契約釘死、之後改前端時當回歸網。頁面 HTML 測試（Task 3/4）才是「先紅後綠」的部分。

- [ ] **Step 1: 寫契約測試檔**

建立 `tests/products-create.test.ts`，完整內容如下：

```typescript
// V6 P1 /api/admin/products/create integration tests.
//
// Locks the contract that the (fixed) admin "新增商品" form must satisfy: a create
// payload carrying group_slug + package_fen succeeds; missing/invalid either field fails;
// unknown group → 404; duplicate SKU in active season → 409; auth + CSRF enforced.
//
// This pins the JSON shape the front-end submit handler is required to send (see plan P1
// Task 2/3). Skipped without MANGO_STAGE_URL + TEST_TOKEN.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-create-season";
const TEST_GROUP_SLUG = "test-create-group";
const SEED_SKU = "TEST-CREATE-SEED";
const NEW_SKU = "TEST-CREATE-NEW";
const PACKAGE_FEN = 100;

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

// One active season + one group (slug=TEST_GROUP_SLUG) + one pre-existing SKU.
function seedScenario() {
  const r = seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: 10 * PACKAGE_FEN,
    skus: [{ sku: SEED_SKU, package_fen: PACKAGE_FEN, price: 100 }],
  });
  seasonId = r.season_id;
}

interface CreatePayload {
  sku?: string;
  name?: string;
  variant?: string;
  price?: number;
  available?: boolean;
  display_order?: number;
  group_slug?: string;
  package_fen?: number;
}

async function adminCreate(
  cookie: string,
  payload: CreatePayload,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== null) {
    headers.Origin = opts.origin ?? STAGE_URL;
  }
  return fetch(`${STAGE_URL}/api/admin/products/create`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

describe("V6 P1 /api/admin/products/create", () => {
  it("happy path: payload with group_slug + package_fen creates the SKU in active season", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "test product create",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      group_slug: TEST_GROUP_SLUG,
      display_order: 0,
      available: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sku: string };
    expect(body.ok).toBe(true);
    expect(body.sku).toBe(NEW_SKU);

    // Row exists in the active season, with the package_fen we sent.
    const rows = d1Execute(
      `SELECT p.package_fen, p.season_id
         FROM products p
         JOIN seasons s ON s.id = p.season_id AND s.status = 'active'
        WHERE p.sku = '${NEW_SKU}'`,
    ) as Array<{ package_fen: number; season_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.package_fen).toBe(PACKAGE_FEN);
    expect(rows[0]!.season_id).toBe(seasonId);
  });

  it("missing group_slug → 400 bad group_slug (the original UI bug)", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "no group",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      // group_slug intentionally omitted
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("group_slug");
  });

  it("missing package_fen → 400 bad package_fen (the original UI bug)", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "no package",
      variant: "1 斤",
      price: 450,
      group_slug: TEST_GROUP_SLUG,
      // package_fen intentionally omitted
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("package_fen");
  });

  it("package_fen=50 (半斤) accepted", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "half jin",
      variant: "半斤",
      price: 250,
      package_fen: 50,
      group_slug: TEST_GROUP_SLUG,
    });
    expect(res.status).toBe(200);
    const rows = d1Execute(
      `SELECT package_fen FROM products WHERE sku = '${NEW_SKU}'`,
    ) as Array<{ package_fen: number }>;
    expect(rows[0]!.package_fen).toBe(50);
  });

  it("unknown group_slug → 404 GROUP_NOT_FOUND", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "ghost group",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      group_slug: "test-create-nonexistent",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("GROUP_NOT_FOUND");
  });

  it("duplicate SKU in active season → 409", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: SEED_SKU, // already seeded
      name: "dup",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      group_slug: TEST_GROUP_SLUG,
    });
    expect(res.status).toBe(409);
  });

  it("auth: no cookie → 401", async () => {
    if (SKIP) return;
    seedScenario();
    const res = await fetch(`${STAGE_URL}/api/admin/products/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL },
      body: JSON.stringify({
        sku: NEW_SKU,
        name: "x",
        variant: "1 斤",
        price: 1,
        package_fen: PACKAGE_FEN,
        group_slug: TEST_GROUP_SLUG,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("csrf: missing Origin → 403", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await adminCreate(
      cookie,
      {
        sku: NEW_SKU,
        name: "x",
        variant: "1 斤",
        price: 1,
        package_fen: PACKAGE_FEN,
        group_slug: TEST_GROUP_SLUG,
      },
      { origin: null },
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑測試，確認檔案能載入並通過（端點本已實作）**

Run:
```bash
bun test tests/products-create.test.ts
```
Expected（已設好 `MANGO_STAGE_URL` + `TEST_TOKEN` + `wrangler login`）：全部 PASS（約 8 個 it 綠燈）。
若**未**設 stage env：印出 `⚠️ V5.2 tests need MANGO_STAGE_URL + TEST_TOKEN env` 並 skip（每個 it 內 `if (SKIP) return` → 顯示 pass/skip），不算失敗。
若出現 `wrangler d1 execute failed`：代表 stage 登入或 D1 連線問題，先 `wrangler login`。

> 註：這一步若不是綠燈而是 `400 bad group_slug` 之類，代表 stage 上 `create.ts` 與本機不同步（stage 是舊版）。此時先把目前 main 部署到 stage（`bun run deploy:stage`，遵照 CLAUDE.md 的 token 規則）再重跑。

- [ ] **Step 3: Commit**

```bash
git add tests/products-create.test.ts
git commit -m "test(products): pin create-endpoint contract (group_slug + package_fen required)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2：頁面渲染測試 — GET /admin/products 的 HTML 含新表單欄位（先紅）

**Files:**
- Modify: `tests/products-create.test.ts`（新增一個 `describe` 區塊）

> 這是真正「先紅後綠」的 TDD 錨點：頁面目前的新增表單沒有 `group_slug`/`package_fen` input，所以 HTML 斷言會失敗。Task 3 改頁面後轉綠。

- [ ] **Step 1: 在測試檔尾端追加「頁面渲染」describe**

在 `tests/products-create.test.ts` 檔案**最後**（最末一個 `});` 之後）追加以下內容：

```typescript

// ---- Page render (SSR HTML) assertions ----
// The admin products page is server-rendered. With an authed admin cookie, GET /admin/products
// must include the create-form inputs for group_slug + package_fen, plus an <option> per
// active-season group. No browser needed: frontmatter-computed groups are baked into the HTML.

async function getProductsPage(cookie: string): Promise<Response> {
  return fetch(`${STAGE_URL}/admin/products`, {
    method: "GET",
    headers: { Cookie: cookie },
  });
}

describe("V6 P1 /admin/products page render", () => {
  it("create form exposes group_slug + package_fen controls and lists active-season groups", async () => {
    if (SKIP) return;
    seedScenario(); // active season + group(slug=TEST_GROUP_SLUG) + one SKU
    const cookie = createTestAdminSession();

    const res = await getProductsPage(cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The two previously-missing form controls now exist.
    expect(html).toContain('name="group_slug"');
    expect(html).toContain('name="package_fen"');

    // The seeded group is rendered as a selectable option (value = slug).
    expect(html).toContain(`value="${TEST_GROUP_SLUG}"`);

    // Package-size options expose the three fen values.
    expect(html).toContain('value="50"');
    expect(html).toContain('value="100"');
    expect(html).toContain('value="1000"');
  });

  it("products are grouped by product_group (group section markers present)", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await getProductsPage(cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Grouped display: a section per group carrying its slug.
    expect(html).toContain("data-group-section");
    expect(html).toContain(`data-group-slug="${TEST_GROUP_SLUG}"`);
  });
});
```

- [ ] **Step 2: 跑頁面測試，確認失敗（紅）**

Run:
```bash
bun test tests/products-create.test.ts -t "page render"
```
Expected: 2 個 it **FAIL**。
- 第 1 個失敗於 `expect(html).toContain('name="group_slug"')`（目前表單無此欄位）。
- 第 2 個失敗於 `expect(html).toContain("data-group-section")`（目前清單未分組）。

> 若這兩個反而通過，代表頁面已被改過或 stage 版本較新；停下來確認 stage 與本機程式碼一致再繼續。

- [ ] **Step 3: Commit（紅燈測試入庫，標記為待實作）**

```bash
git add tests/products-create.test.ts
git commit -m "test(products): assert page render exposes group_slug + package_fen + grouping (red)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3：修復破洞 — 表單加「所屬群組」下拉 + 「包裝大小」下拉，readForm 補送兩欄

**Files:**
- Modify: `src/pages/admin/products/index.astro`
  - frontmatter：擴充 query（取得當季 season 與其 groups）
  - 新增表單 `<form id="create-form">`（131-159 行區塊）：加兩個 `<select>`
  - 表單欄位標頭（123-130 行）：加兩欄標題
  - `readForm`（329-344 行）：讀 `group_slug` + `package_fen`
  - submit handler（346-370 行）：把這兩欄併進 payload；空群組時擋下並提示

> 本 Task 把「破洞」修好但**先不動清單分組**（分組留給 Task 4，保持每步小且可獨立驗證）。完成後 Task 2 的第 1 個頁面測試（group_slug/package_fen/options）應轉綠；第 2 個（分組標記）仍紅，由 Task 4 處理。

- [ ] **Step 1: 擴充 frontmatter，查當季 season 與其 groups**

把 `src/pages/admin/products/index.astro` 的 frontmatter（目前 1-20 行）整段替換為下列內容（保留既有 import，加入 `seasons`、`product_groups`、`and`、`eq`，並新增 `activeSeason` / `groupRows` query）：

```astro
---
import Layout from "../../../layouts/Layout.astro";
import StickyBar from "../../../components/admin/StickyBar.astro";
import { makeDb } from "../../../db/client";
import { products, product_groups, seasons } from "../../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { env } from "../../../lib/env";

const session = Astro.locals.session;
if (!session) return Astro.redirect("/admin/login");
if (session.role !== "admin") {
  return new Response("admin only", { status: 403 });
}

const db = makeDb(env);

// V6: scope the catalog to the active season (matches create.ts, which only creates within
// status='active'). Without an active season there is nowhere to create products.
const activeSeasonRows = await db
  .select()
  .from(seasons)
  .where(eq(seasons.status, "active"))
  .limit(1);
const activeSeason = activeSeasonRows[0] ?? null;

// Groups of the active season — feeds the "所屬群組" <select> and the grouped product list.
const groupRows = activeSeason
  ? await db
      .select()
      .from(product_groups)
      .where(eq(product_groups.season_id, activeSeason.id))
      .orderBy(asc(product_groups.display_order), asc(product_groups.slug))
  : [];

// Products of the active season only. Grouped by group_id in the template (Task 4).
const productRows = activeSeason
  ? await db
      .select()
      .from(products)
      .where(eq(products.season_id, activeSeason.id))
      .orderBy(asc(products.group_id), asc(products.display_order), asc(products.sku))
  : [];

// group_id -> products[] for the grouped render.
const productsByGroup = new Map<number, typeof productRows>();
for (const p of productRows) {
  const list = productsByGroup.get(p.group_id) ?? [];
  list.push(p);
  productsByGroup.set(p.group_id, list);
}

// Package-size options shared by the create form (fen units: 半斤=50, 1斤=100, 10斤=1000).
const PACKAGE_OPTIONS: Array<{ fen: number; label: string }> = [
  { fen: 50, label: "半斤（50）" },
  { fen: 100, label: "1 斤（100）" },
  { fen: 1000, label: "10 斤（1000）" },
];
---
```

> 注意：上面把 `productRows` 改成「當季 + 依 group_id 排序」並加了 `productsByGroup`、`PACKAGE_OPTIONS`、`groupRows`、`activeSeason`。`and` 目前雖未直接用到（Task 4 也只用 `eq`），但保留 import 不影響；若 `astro check` 抱怨未使用，於 Step 6 一併處理（見該步）。

- [ ] **Step 2: 在新增表單欄位標頭加兩欄（群組 / 包裝）**

在 `src/pages/admin/products/index.astro` 找到新增表單的欄位標頭（目前 123-130 行）：

```astro
      <div class="hidden sm:grid sm:grid-cols-[7rem_1fr_4rem_5rem_4rem_4rem] items-center gap-2 mb-1 px-1 text-xs font-medium text-amber-800">
        <div>SKU</div>
        <div>名稱</div>
        <div>規格</div>
        <div>價格</div>
        <div>順序</div>
        <div class="text-center">上架</div>
      </div>
```

整段替換為（grid 改為 8 欄，加「所屬群組」「包裝」）：

```astro
      <div class="hidden sm:grid sm:grid-cols-[7rem_1fr_7rem_6rem_4rem_5rem_4rem_4rem] items-center gap-2 mb-1 px-1 text-xs font-medium text-amber-800">
        <div>SKU</div>
        <div>名稱</div>
        <div>所屬群組</div>
        <div>包裝</div>
        <div>規格</div>
        <div>價格</div>
        <div>順序</div>
        <div class="text-center">上架</div>
      </div>
```

- [ ] **Step 3: 在新增表單加「所屬群組」「包裝大小」兩個 select，並處理無群組情況**

找到 `<form id="create-form">` 內的欄位 grid（目前 132-150 行）：

```astro
        <div class="grid grid-cols-2 items-center gap-2 sm:grid-cols-[7rem_1fr_4rem_5rem_4rem_4rem]">
          <input
            type="text"
            name="sku"
            required
            pattern="[A-Z0-9_-]+"
            aria-label="SKU"
            class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm font-mono"
            placeholder="SKU"
          />
          <input type="text" name="name" required aria-label="名稱" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="名稱" />
          <input type="text" name="variant" required aria-label="規格" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="規格" />
          <input type="number" name="price" required min="0" aria-label="價格" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="價格" />
          <input type="number" name="display_order" required value="0" aria-label="順序" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="順序" />
          <label class="flex items-center justify-center gap-1 min-h-[44px] text-sm">
            <input type="checkbox" name="available" checked />
            <span>上架</span>
          </label>
        </div>
```

整段替換為（grid 改 8 欄；在 name 之後插入「所屬群組」select，在其後插入「包裝」select）：

```astro
        <div class="grid grid-cols-2 items-center gap-2 sm:grid-cols-[7rem_1fr_7rem_6rem_4rem_5rem_4rem_4rem]">
          <input
            type="text"
            name="sku"
            required
            pattern="[A-Z0-9_-]+"
            aria-label="SKU"
            class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm font-mono"
            placeholder="SKU"
          />
          <input type="text" name="name" required aria-label="名稱" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="名稱" />
          <select
            name="group_slug"
            required
            aria-label="所屬群組"
            class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm"
          >
            <option value="" disabled selected>選擇群組</option>
            {groupRows.map((g) => (
              <option value={g.slug}>{g.name}</option>
            ))}
          </select>
          <select
            name="package_fen"
            required
            aria-label="包裝大小"
            class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm"
          >
            <option value="" disabled selected>選擇包裝</option>
            {PACKAGE_OPTIONS.map((o) => (
              <option value={o.fen}>{o.label}</option>
            ))}
          </select>
          <input type="text" name="variant" required aria-label="規格" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="規格" />
          <input type="number" name="price" required min="0" aria-label="價格" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="價格" />
          <input type="number" name="display_order" required value="0" aria-label="順序" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="順序" />
          <label class="flex items-center justify-center gap-1 min-h-[44px] text-sm">
            <input type="checkbox" name="available" checked />
            <span>上架</span>
          </label>
        </div>
```

- [ ] **Step 4: 無群組時，整個「新增商品」區塊改提示先建群組**

新增表單外層 `<section class="rounded border border-amber-200 bg-amber-50 p-4">`（目前 121 行）內，標題之後即是 form。為避免「沒有群組可選 → 一定建不成」的死路，於 `<h2 class="mb-3 text-lg font-bold">新增商品</h2>`（目前 122 行）**之後、`<div class="hidden sm:grid ...">` 標頭之前**插入下列群組空狀態提示，並用條件把表單包起來。

具體做法：找到目前 121-160 行的整個 `<section>`，替換為下列版本（在標題後加「無群組提示」，並把「欄位標頭 + form」整段用 `{groupRows.length > 0 ? (...) : (...)}` 包住）：

```astro
    <section class="rounded border border-amber-200 bg-amber-50 p-4">
      <h2 class="mb-3 text-lg font-bold">新增商品</h2>
      {!activeSeason && (
        <p class="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          找不到當季（status='active'）。請先到「年度設定」啟用一個季節，才能新增商品。
        </p>
      )}
      {activeSeason && groupRows.length === 0 && (
        <p class="rounded bg-amber-100 px-3 py-2 text-sm text-amber-900">
          當季尚無品種群組。請先到
          <a href="/admin/product-groups" class="underline">庫存池（進貨）</a>
          建立群組，才能在這裡新增商品。
        </p>
      )}
      {activeSeason && groupRows.length > 0 && (
        <>
          <div class="hidden sm:grid sm:grid-cols-[7rem_1fr_7rem_6rem_4rem_5rem_4rem_4rem] items-center gap-2 mb-1 px-1 text-xs font-medium text-amber-800">
            <div>SKU</div>
            <div>名稱</div>
            <div>所屬群組</div>
            <div>包裝</div>
            <div>規格</div>
            <div>價格</div>
            <div>順序</div>
            <div class="text-center">上架</div>
          </div>
          <form id="create-form" class="space-y-3">
            <div class="grid grid-cols-2 items-center gap-2 sm:grid-cols-[7rem_1fr_7rem_6rem_4rem_5rem_4rem_4rem]">
              <input
                type="text"
                name="sku"
                required
                pattern="[A-Z0-9_-]+"
                aria-label="SKU"
                class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm font-mono"
                placeholder="SKU"
              />
              <input type="text" name="name" required aria-label="名稱" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="名稱" />
              <select
                name="group_slug"
                required
                aria-label="所屬群組"
                class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm"
              >
                <option value="" disabled selected>選擇群組</option>
                {groupRows.map((g) => (
                  <option value={g.slug}>{g.name}</option>
                ))}
              </select>
              <select
                name="package_fen"
                required
                aria-label="包裝大小"
                class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm"
              >
                <option value="" disabled selected>選擇包裝</option>
                {PACKAGE_OPTIONS.map((o) => (
                  <option value={o.fen}>{o.label}</option>
                ))}
              </select>
              <input type="text" name="variant" required aria-label="規格" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="規格" />
              <input type="number" name="price" required min="0" aria-label="價格" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="價格" />
              <input type="number" name="display_order" required value="0" aria-label="順序" class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm" placeholder="順序" />
              <label class="flex items-center justify-center gap-1 min-h-[44px] text-sm">
                <input type="checkbox" name="available" checked />
                <span>上架</span>
              </label>
            </div>
            <div class="flex justify-end">
              <button
                type="submit"
                class="w-full sm:w-auto inline-flex items-center justify-center rounded bg-amber-600 px-6 py-2 min-h-[44px] text-sm font-medium text-white hover:bg-amber-700"
              >
                新增商品
              </button>
            </div>
          </form>
        </>
      )}
    </section>
```

> 這一步把 Step 2、Step 3 的兩段（標頭 + grid）併入了最終 section 版本。若你已先做 Step 2/3 的局部替換，這裡的整段替換會覆蓋它們——以本步的整段為準（Step 2/3 是漸進說明，Step 4 給最終形）。`<>...</>` 是 Astro/JSX fragment，避免多包一層 DOM。

- [ ] **Step 5: 改 `readForm` 與 submit handler，把 group_slug + package_fen 併進 payload**

找到 client `<script>` 內的 `readForm`（目前 329-344 行）：

```typescript
    function readForm(form: HTMLFormElement): {
      name: string;
      variant: string;
      price: number;
      available: boolean;
      display_order: number;
    } {
      const fd = new FormData(form);
      return {
        name: String(fd.get("name") ?? "").trim(),
        variant: String(fd.get("variant") ?? "").trim(),
        price: Number(fd.get("price") ?? 0),
        available: fd.get("available") === "on",
        display_order: Number(fd.get("display_order") ?? 0),
      };
    }
```

整段替換為（回傳型別與物件都補上 `group_slug` 與 `package_fen`）：

```typescript
    function readForm(form: HTMLFormElement): {
      name: string;
      variant: string;
      price: number;
      available: boolean;
      display_order: number;
      group_slug: string;
      package_fen: number;
    } {
      const fd = new FormData(form);
      return {
        name: String(fd.get("name") ?? "").trim(),
        variant: String(fd.get("variant") ?? "").trim(),
        price: Number(fd.get("price") ?? 0),
        available: fd.get("available") === "on",
        display_order: Number(fd.get("display_order") ?? 0),
        group_slug: String(fd.get("group_slug") ?? "").trim(),
        package_fen: Number(fd.get("package_fen") ?? 0),
      };
    }
```

接著找到 submit handler（目前 346-370 行）：

```typescript
    const createForm = document.getElementById("create-form") as HTMLFormElement | null;
    createForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(createForm);
      const data = {
        sku: String(fd.get("sku") ?? "").trim(),
        ...readForm(createForm),
      };
      if (!/^[A-Z0-9_-]+$/.test(data.sku)) {
        showToast("SKU 只能大寫英數、底線、連字號", { kind: "error" });
        return;
      }
      const res = await fetch("/api/admin/products/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(data),
      });
      if (res.ok) {
        flashToast("已新增商品", { kind: "success" });
        location.reload();
      } else {
        showToast(`新增失敗：${await res.text()}`, { kind: "error" });
      }
    });
```

整段替換為（在送出前加 group_slug / package_fen 的前端驗證，給出明確中文提示，避免送出空值後才被後端 400）：

```typescript
    const createForm = document.getElementById("create-form") as HTMLFormElement | null;
    createForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(createForm);
      const data = {
        sku: String(fd.get("sku") ?? "").trim(),
        ...readForm(createForm),
      };
      if (!/^[A-Z0-9_-]+$/.test(data.sku)) {
        showToast("SKU 只能大寫英數、底線、連字號", { kind: "error" });
        return;
      }
      if (!/^[a-z0-9-]+$/.test(data.group_slug)) {
        showToast("請選擇所屬群組", { kind: "error" });
        return;
      }
      if (!Number.isInteger(data.package_fen) || data.package_fen <= 0) {
        showToast("請選擇包裝大小", { kind: "error" });
        return;
      }
      const res = await fetch("/api/admin/products/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(data),
      });
      if (res.ok) {
        flashToast("已新增商品", { kind: "success" });
        location.reload();
      } else {
        showToast(`新增失敗：${await res.text()}`, { kind: "error" });
      }
    });
```

- [ ] **Step 6: 型別檢查 + build（含未使用 import 檢查）**

Run:
```bash
bun run build
```
Expected: build 成功（`astro check` 0 errors、0 warnings → 接著 vite/astro 產 `dist/`）。

若 `astro check` 報 `'and' is declared but its value is never read`：把 frontmatter import 那行
```astro
import { and, asc, eq } from "drizzle-orm";
```
改為
```astro
import { asc, eq } from "drizzle-orm";
```
再重跑 `bun run build`。

> 為何可能未使用 `and`：本頁 query 都只用單一 `eq`（`status='active'`、`season_id=...`），不需 `and` 組合。Task 4 也只用 `eq`。保守起見預設不 import `and`——若你照 Step 1 已寫了 `and` 就在這裡移除。

- [ ] **Step 7: 跑頁面測試的第 1 個 case，確認 group_slug/package_fen/options 轉綠**

> 此 Task 改的是本機 `.astro`，但整合測試打的是 **stage worker**。要讓頁面測試看到新 HTML，必須先把改動部署到 stage。

先部署 stage（遵照 CLAUDE.md：本機 `.env` 的 `PUBLIC_ORDER_TOKEN` 必須等於 stage 的 `ORDER_TOKEN`；clean-build 由 `deploy:stage` 自動處理）：
```bash
bun run deploy:stage
```
Expected: 三道 token guard 通過、`wrangler deploy` 成功、印出 stage worker URL。

再跑：
```bash
bun test tests/products-create.test.ts -t "create form exposes"
```
Expected: 該 it **PASS**（HTML 已含 `name="group_slug"`、`name="package_fen"`、`value="${TEST_GROUP_SLUG}"`、`value="50"`/`100`/`1000`）。

> 「分組標記」那個 it（`data-group-section`）此時仍 **FAIL**——交給 Task 4。可單獨確認：
> ```bash
> bun test tests/products-create.test.ts -t "grouped by product_group"
> ```
> Expected: 仍 FAIL（預期內）。

- [ ] **Step 8: Commit**

```bash
git add src/pages/admin/products/index.astro
git commit -m "fix(products): send group_slug + package_fen from create form (UI create was always failing)

Add 所屬群組 (active-season groups) and 包裝大小 (半斤=50/1斤=100/10斤=1000 → package_fen)
selects; readForm + submit now include both fields the create.ts endpoint requires.
Guard empty-group / no-active-season states with inline guidance.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4：依群組分組顯示品項清單

**Files:**
- Modify: `src/pages/admin/products/index.astro`
  - 清單區（目前 41-119 行的 `<ul data-dirty-track="products">`）：改為「每個群組一個 `<section data-group-section data-group-slug=...>`，內含該群組的 `<li data-prod-row>`」。dirty-track 仍掛在外層單一容器，`data-sku`/`data-prod-field`/`data-dirty-key` 結構不變 → batch 儲存路徑零改動。

> 關鍵：dirty-tracker 透過 `createDirtyTracker({ root })` 掃描 root 底下所有 `[data-dirty-key]`（見 `src/lib/dirty-tracker.ts`）。只要所有商品列仍在同一個 `data-dirty-track="products"` root 內，分組只是視覺層級，儲存邏輯不受影響。因此把分組 `<section>` 放在該 root **裡面**。

- [ ] **Step 1: 替換清單區為分組版本**

找到目前 41-119 行的整個清單區：

```astro
    <ul
      class="mb-8 divide-y divide-gray-200 rounded border border-gray-200"
      data-dirty-track="products"
    >
      <li class="hidden sm:grid sm:grid-cols-[7rem_1fr_4rem_5rem_4rem_4rem] items-center gap-2 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-600">
        <div>SKU</div>
        <div>名稱</div>
        <div>規格</div>
        <div>價格</div>
        <div>順序</div>
        <div class="text-center">上架</div>
      </li>
      {productRows.map((p) => (
        <li class="px-4 py-3 space-y-2" data-prod-row data-sku={p.sku}>
          <div class="grid grid-cols-2 items-center gap-2 sm:grid-cols-[7rem_1fr_4rem_5rem_4rem_4rem]">
            <div class="font-mono text-sm text-gray-700">{p.sku}</div>
            <input
              type="text"
              data-dirty-key={`${p.sku}__name`}
              data-prod-field="name"
              value={p.name}
              required
              maxlength="50"
              aria-label={`${p.sku} 名稱`}
              class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
              placeholder="名稱"
            />
            <input
              type="text"
              data-dirty-key={`${p.sku}__variant`}
              data-prod-field="variant"
              value={p.variant}
              required
              maxlength="30"
              aria-label={`${p.sku} 規格`}
              class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
              placeholder="規格"
            />
            <input
              type="number"
              data-dirty-key={`${p.sku}__price`}
              data-prod-field="price"
              value={p.price}
              required
              min="0"
              max="100000"
              aria-label={`${p.sku} 價格`}
              class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
              placeholder="價格"
            />
            <input
              type="number"
              data-dirty-key={`${p.sku}__display_order`}
              data-prod-field="display_order"
              value={p.display_order}
              required
              min="0"
              aria-label={`${p.sku} 順序`}
              class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
              placeholder="順序"
            />
            <label class="flex items-center justify-center gap-1 min-h-[44px] text-sm">
              <input
                type="checkbox"
                data-dirty-key={`${p.sku}__available`}
                data-prod-field="available"
                checked={p.available}
                aria-label={`${p.sku} 上架`}
              />
              <span>上架</span>
            </label>
          </div>

        </li>
      ))}
      {productRows.length === 0 && (
        <li class="px-4 py-6 text-center text-sm text-gray-500">（尚無商品）</li>
      )}
    </ul>
```

整段替換為（外層改 `<div data-dirty-track="products">`；內部 `groupRows.map` 出每個群組 section，section 內放該群組的商品列；最後處理「群組存在但無商品」與「完全無群組」狀態）：

```astro
    <div class="mb-8 space-y-6" data-dirty-track="products">
      {groupRows.map((g) => {
        const groupProducts = productsByGroup.get(g.id) ?? [];
        return (
          <section
            class="rounded border border-gray-200"
            data-group-section
            data-group-slug={g.slug}
          >
            <header class="flex items-baseline justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2">
              <h2 class="text-sm font-bold text-gray-800">{g.name}</h2>
              <span class="font-mono text-xs text-gray-500">{g.slug}</span>
            </header>

            <div class="hidden sm:grid sm:grid-cols-[7rem_1fr_4rem_5rem_4rem_4rem] items-center gap-2 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-600">
              <div>SKU</div>
              <div>名稱</div>
              <div>規格</div>
              <div>價格</div>
              <div>順序</div>
              <div class="text-center">上架</div>
            </div>

            <ul class="divide-y divide-gray-200">
              {groupProducts.map((p) => (
                <li class="px-4 py-3 space-y-2" data-prod-row data-sku={p.sku}>
                  <div class="grid grid-cols-2 items-center gap-2 sm:grid-cols-[7rem_1fr_4rem_5rem_4rem_4rem]">
                    <div class="font-mono text-sm text-gray-700">{p.sku}</div>
                    <input
                      type="text"
                      data-dirty-key={`${p.sku}__name`}
                      data-prod-field="name"
                      value={p.name}
                      required
                      maxlength="50"
                      aria-label={`${p.sku} 名稱`}
                      class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
                      placeholder="名稱"
                    />
                    <input
                      type="text"
                      data-dirty-key={`${p.sku}__variant`}
                      data-prod-field="variant"
                      value={p.variant}
                      required
                      maxlength="30"
                      aria-label={`${p.sku} 規格`}
                      class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
                      placeholder="規格"
                    />
                    <input
                      type="number"
                      data-dirty-key={`${p.sku}__price`}
                      data-prod-field="price"
                      value={p.price}
                      required
                      min="0"
                      max="100000"
                      aria-label={`${p.sku} 價格`}
                      class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
                      placeholder="價格"
                    />
                    <input
                      type="number"
                      data-dirty-key={`${p.sku}__display_order`}
                      data-prod-field="display_order"
                      value={p.display_order}
                      required
                      min="0"
                      aria-label={`${p.sku} 順序`}
                      class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
                      placeholder="順序"
                    />
                    <label class="flex items-center justify-center gap-1 min-h-[44px] text-sm">
                      <input
                        type="checkbox"
                        data-dirty-key={`${p.sku}__available`}
                        data-prod-field="available"
                        checked={p.available}
                        aria-label={`${p.sku} 上架`}
                      />
                      <span>上架</span>
                    </label>
                  </div>
                </li>
              ))}
              {groupProducts.length === 0 && (
                <li class="px-4 py-6 text-center text-sm text-gray-500">
                  此群組尚無商品。用下方「新增商品」並選此群組來建立。
                </li>
              )}
            </ul>
          </section>
        );
      })}

      {activeSeason && groupRows.length === 0 && (
        <p class="rounded border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          當季尚無品種群組，因此沒有商品。請先到
          <a href="/admin/product-groups" class="text-mango-700 underline">庫存池（進貨）</a>
          建立群組。
        </p>
      )}
      {!activeSeason && (
        <p class="rounded border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          找不到當季（status='active'）。請先到「年度設定」啟用一個季節。
        </p>
      )}
    </div>
```

> dirty-track 容器從 `<ul>` 改成 `<div>` 不影響 `createDirtyTracker`——它只看 `root.querySelectorAll('[data-dirty-key]')`（見 `src/lib/dirty-tracker.ts`），與容器標籤無關。所有 `data-prod-row`/`data-dirty-key` 仍在這個 root 內，故 batch 儲存、StickyBar、Cmd+S、beforeunload 全部沿用，無需改 `<script>`。

- [ ] **Step 2: 型別檢查 + build**

Run:
```bash
bun run build
```
Expected: build 成功，0 errors。

- [ ] **Step 3: 部署 stage 並跑頁面測試（兩個 case 全綠）**

```bash
bun run deploy:stage
```
Expected: 部署成功。

```bash
bun test tests/products-create.test.ts -t "page render"
```
Expected: 「page render」describe 下兩個 it **皆 PASS**：
- `create form exposes group_slug + package_fen ...` PASS
- `products are grouped by product_group ...` PASS（HTML 含 `data-group-section` 與 `data-group-slug="${TEST_GROUP_SLUG}"`）。

- [ ] **Step 4: 跑整個 products-create 測試檔，全綠回歸**

Run:
```bash
bun test tests/products-create.test.ts
```
Expected: 全部 PASS（Task 1 的 8 個契約 it + Task 2 的 2 個頁面 it）。

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/products/index.astro
git commit -m "feat(products): group product list by product_group (active season)

Render one section per active-season group with its SKUs; dirty-track root stays a single
container so batch-save / StickyBar are unchanged. Empty-group and no-active-season states
get inline guidance.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5：回歸 — 既有 products/batch 測試仍綠（確認沒打到批次編輯路徑）

**Files:**
- （不改檔）執行既有 `tests/products-batch.test.ts`

> spec §8 風險表明列：「品項破洞修復影響既有批次編輯 → 只動新增表單路徑，batch API 不改；回歸測試」。本 Task 就是那道回歸網。我們沒改 `batch.ts`、也沒改 `data-sku`/`data-prod-field`/`data-dirty-key` 結構，故 batch 應全綠。

- [ ] **Step 1: 跑既有批次測試**

Run:
```bash
bun test tests/products-batch.test.ts
```
Expected: 全部 PASS（multi-row update / server-side diff / DEPRECATED_FIELD / empty row / 404 / CSRF）。

> 若任何一項紅燈，代表分組改動意外動到了 dirty-track 結構。回頭檢查 Task 4 的 `data-dirty-key` 是否仍為 `${p.sku}__<field>`、`data-prod-row`/`data-sku` 是否仍在同一個 `data-dirty-track="products"` root 內。

- [ ] **Step 2: 跑兩個純單元測試確認無連帶破壞**

Run:
```bash
bun test tests/stock-helper.test.ts tests/items-hash.test.ts
```
Expected: 全部 PASS（這兩個不需 stage env，純單元；確認沒有意外改到共用 lib 的型別匯出）。

- [ ] **Step 3: Commit（若前面步驟有任何 lint/格式微調才需要；無改動則跳過）**

若 Step 1/2 過程未產生任何檔案變動，本步跳過，不需空 commit。

---

## Task 6：手動 smoke（瀏覽器實機驗收，非自動化）

**Files:** （不改檔）

> 自動化測試覆蓋了「payload 正確」「HTML 含欄位/分組」。本 Task 用實機補「店主真的能在 UI 點選下拉、送出、看到新商品」這條人因路徑，呼應 spec §5.3「目前店主根本無法自助新增品項」的驗收目標。

- [ ] **Step 1: 起本機 dev server**

Run:
```bash
bun run dev
```
Expected: Astro dev server 起在 `http://localhost:4321`（或終端顯示的埠）。

- [ ] **Step 2: 登入後台並開商品頁**

- [ ] 瀏覽 `http://localhost:4321/admin/login`，用既有 admin 帳號登入。
- [ ] 開 `http://localhost:4321/admin/products`。
- [ ] 確認：清單依「品種群組」分區（每區有群組名 + slug）；「新增商品」區有「所屬群組」下拉（列出當季群組名）與「包裝」下拉（半斤/1斤/10斤）。

- [ ] **Step 3: 實機新增一個 SKU**

- [ ] 在新增表單填：SKU=`TEST-SMOKE-1`、名稱=`煙霧測試`、所屬群組=任一當季群組、包裝=`1 斤（100）`、規格=`1 斤`、價格=`1`、順序=`0`、上架打勾。
- [ ] 按「新增商品」。
- [ ] Expected：toast「已新增商品」，頁面 reload 後該 SKU 出現在所選群組區塊內。

- [ ] **Step 4: 清理 smoke 測試資料**

> `TEST-SMOKE-1` 是本機 dev 連到的 D1（依 `bun run dev` 的 binding；通常是本機/remote 視設定）。若連到 stage/remote，請刪除避免污染。

Run（依實際連線環境擇一；若 dev 用本機 miniflare D1 則可忽略）：
```bash
bunx wrangler d1 execute mango-hsu-stage --env stage --remote --command "DELETE FROM products WHERE sku = 'TEST-SMOKE-1'"
```
Expected: 刪除 0 或 1 列（本機 dev 未寫到 stage 則 0 列）。

- [ ] **Step 5: 收尾**

- [ ] 停掉 dev server（Ctrl+C）。
- [ ] 無程式改動，無需 commit。

---

## 收尾：本模組驗收清單

- [ ] `bun test tests/products-create.test.ts` 全綠（契約 8 + 頁面 2）。
- [ ] `bun test tests/products-batch.test.ts` 全綠（回歸）。
- [ ] `bun run build` 0 errors 0 warnings。
- [ ] 已 `bun run deploy:stage`（讓 stage 反映新頁面，整合測試才測得到）。
- [ ] 手動 smoke 能從 UI 成功新增帶群組 + 包裝的 SKU。
- [ ] 未改任何後端檔（`create.ts`/`batch.ts`/`schema.ts`/intake 路徑皆未動）。

---

## Self-Review 註記（撰寫者已核對）

- **Spec §5.3 覆蓋**：破洞修復（Task 3）+ 依群組分組（Task 4）+ 「同 SKU 跨季不同商品 / 不要刪 SKU」提醒——後者已存在於頁面 32-39 行的既有說明文字（本任務未移除，仍在頁面頂部），故不重複新增。
- **無新 audit action**：`create.ts` 用既有 `product_create`；本模組未觸碰共用契約中的新 action（season_*/group_*/shipping_config_change/password_reset_*）。
- **未動庫存路徑**：`stock_fen` / intake / `group_stock_change` audit 全未碰，符合硬性規則。
- **型別一致**：`readForm` 回傳型別與物件兩處都加了 `group_slug: string` + `package_fen: number`；`PACKAGE_OPTIONS` 形狀 `{fen:number;label:string}` 在 frontmatter 定義、模板 `o.fen`/`o.label` 使用一致；`productsByGroup` 鍵型別 `number`（`group_id`）與 `g.id` 一致。
- **placeholder 掃描**：無 TBD/TODO；每個 code step 為完整可貼上的程式碼；每個 test step 附完整測試碼與精確 `bun test -t` 指令與預期輸出。
- **已知前提**：整合測試打 stage，故 Task 3/4 在斷言頁面 HTML 前都包含 `bun run deploy:stage`（遵 CLAUDE.md token 規則）。若團隊改用本機 dev 對頁面做斷言，需另接 dev-server fixture——本計畫採既有「打 stage」慣例以與其他整合測試一致。
