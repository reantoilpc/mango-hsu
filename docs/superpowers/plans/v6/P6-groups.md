# P6 實作計畫：群組管理 + 建置一條龍（spec §5.2 + §5.5 流程）

> 對應設計 spec：`docs/superpowers/specs/2026-06-06-v6-admin-selfservice-design.md` §5.2（群組管理）、§5.5（建群組→進貨→建品項 一條龍）、§6（安全/並發/稽核共用契約）。
>
> **本模組範圍**：在 V5.2 既有「季節 → 群組 pool → SKU」三層上，補上**群組層的 CRUD**——目前店主只能進貨（intake），無法自助建群組、改名、上下架。新增 2 支 API、擴充庫存池頁 UI（＋新增群組 / 編輯 / 上下架），並把「建群組 → 進貨 → 建品項」串成一條龍導引。
>
> **依賴**：P5（季節管理）。本模組所有群組都掛在 `status='active'` 的當季 season 底下；季節不存在時頁面已有 fallback（`index.astro:108-112` 顯示「找不到 active season」），API 則回 `NO_ACTIVE_SEASON`。P5 與 P6 可平行開發——本模組 API 自行查 active season（不依賴 P5 的程式碼，只依賴 seasons 表已有 active 列，stage 的 `2026` 即是），測試用 `seedActiveSeasonScenario` 自備 active season。

---

## 0. 前置：給「對本 codebase 零 context 的工程師」的關鍵事實

照做前先讀懂這幾條，後面每個 Task 都依賴它們：

1. **執行環境**：Bun + Astro 6 SSR on Cloudflare Workers + D1（SQLite）+ Drizzle。測試用 `bun test`。
2. **授權契約（所有 mutation API 一致）**：每支寫入 API 第一行就是
   ```ts
   const auth = await authorizeAdmin(request, env, "admin");
   if (!auth.ok) return text(auth.reason, auth.status);
   ```
   `authorizeAdmin`（`src/lib/admin-api.ts:9`）內部對「非 GET」請求已自動呼叫 `requireSameOrigin`（`src/lib/csrf.ts`），所以 **PATCH/POST 不需再手動呼叫 CSRF 檢查**——缺 `Origin`/`Referer` 會回 403、無 session 回 401、role 非 admin 回 403。`auth.session.email` 拿到操作者 email 寫進 audit。
3. **回應 helper**：`json(body, status)` 與 `text(body, status)` 都來自 `src/lib/admin-api.ts`。慣例成功回 `{ ok: true, ... }`，失敗回 `{ ok: false, error_code: "...", ... }` 配對應 HTTP status。
4. **DB 寫入慣例**：
   - 原子的「資料變動 + audit」一起寫 → `await env.DB.batch([stmt1, stmt2])`（D1 全有全無）。
   - `audit_log` 欄位順序固定：`(ts, user_email, action, order_id, season_id, details)`。非訂單事件 `order_id` 傳 `null`。`details` 是自由 JSON 字串（`JSON.stringify(...)`）。
   - 時間戳一律 `new Date().toISOString()`（UTC，`Z` 結尾）。
5. **`product_groups` 表結構**（`src/db/schema.ts:34-51`）：
   `id`(PK autoincr)、`season_id`(FK→seasons)、`slug`(text)、`name`(text)、`stock_fen`(int default 0)、`available`(boolean，D1 存 0/1)、`display_order`(int default 0)、`created_at`(text)。
   **唯一索引** `product_groups_season_slug` 在 `(season_id, slug)`——同季 slug 不可重複（DB 層會擋，但我們也在 app 層先查、回乾淨的 `SLUG_TAKEN`）。
6. **庫存契約（本模組嚴禁碰）**：`stock_fen` 只能透過 `POST /api/admin/product-groups/[id]/intake` 變動（兩段式 CAS + 防負數 + 冪等 + 同 batch 寫 `group_stock_change` audit）。**本模組的 create 把新群組 `stock_fen` 固定設 0；PATCH 明確拒絕任何帶 `stock_fen` 的請求**（回 400 `STOCK_FORBIDDEN`），庫存一律走 intake。
7. **新 audit action（共用契約，全 V6 一致）**：本模組用 `group_create`、`group_update`。`details` 是 JSON blob。
8. **檔案路徑深度**：新 API 檔放 `src/pages/api/admin/product-groups/`，import 用 **4 層** `../../../../`（與 `src/pages/api/admin/products/create.ts` 同深度）。注意：既有 `intake.ts` 在 `product-groups/[id]/intake.ts`（多一層資料夾），用 5 層 `../../../../../`——別照抄它的 import 深度。
9. **測試整合環境**：import `tests/_setup.ts` 的測試需要 stage env（`MANGO_STAGE_URL` + `TEST_TOKEN` + `wrangler login`）。缺則 `skipIfNoIntegration()` 回 true，每個 `it` 開頭 `if (SKIP) return;` 直接跳過（不會 fail）。所以「TDD 的失敗驗證」分兩種：(a) **編譯/匯入層**的失敗（route 檔不存在 → 整合測試打到 stage 會 404，或 type-check 失敗）；(b) 有 stage env 時跑真實 HTTP。本計畫每個測試 Task 都會明確標示「預期 FAIL 的訊號」。
10. **頁面（Astro）授權**：`.astro` 頁用 `Astro.locals.session`（中介層注入），**不是** `authorizeAdmin`。庫存池頁開頭已有
    ```ts
    const session = Astro.locals.session;
    if (!session) return Astro.redirect("/admin/login");
    if (session.role !== "admin") return new Response("admin only", { status: 403 });
    ```
    沿用即可。

---

## 任務總覽（依序執行，每個 Task 結尾 commit）

| Task | 內容 | 產出檔 |
|---|---|---|
| 1 | 整合測試骨架（create + update + slug 衝突，TDD 先紅） | `tests/group-crud.test.ts`（新） |
| 2 | `POST /api/admin/product-groups/create`（最小實作通過 create + slug 衝突 + 驗證 + 授權） | `src/pages/api/admin/product-groups/create.ts`（新） |
| 3 | `PATCH /api/admin/product-groups/[id]`（改 name/available/display_order；拒絕 stock_fen；CAS 樂觀鎖） | `src/pages/api/admin/product-groups/[id].ts`（新） |
| 4 | 庫存池頁 UI：＋新增群組 表單 | `src/pages/admin/product-groups/index.astro`（改） |
| 5 | 庫存池頁 UI：每群組 編輯（改名/順序）+ 上下架 切換 | `src/pages/admin/product-groups/index.astro`（改） |
| 6 | 一條龍導引：建群組 → 進貨 → 建品項 串接（空狀態 + 每群組「新增此品種的品項」連結 + products 頁回連） | `src/pages/admin/product-groups/index.astro`（改）、`src/pages/admin/products/index.astro`（改：群組下拉 + package_fen，修 §5.3 破洞最小子集所需的回連） |
| 7 | 全量驗證 + 收尾（type-check、整段測試、reconcile 心智檢查） | — |

> **與其他模組的邊界**：§5.3 品項新增破洞（products 頁缺 `group_slug`/`package_fen`）由「地基修復」模組負責；本模組**只**在 Task 6 加「從群組頁跳到 products 頁、並預選群組」的一條龍連結，以及 products 頁接收 `?group=<slug>` query 預選下拉所需的最小改動。若地基修復模組已先落地該下拉，Task 6 的 products 頁改動退化為「讀 query 預選」一行；本計畫兩種情況都給完整 code，並在 Task 6 標明「若已存在則跳過」。詳見 Task 6 開頭的 Coordination note。

---

## Task 1：整合測試骨架（TDD 先紅）

先寫會失敗的整合測試，鎖定 create / update / slug 衝突 / 拒絕 stock_fen / 授權 五組行為。route 檔尚未建立，打到 stage 會 404 → 紅。

**Files**
- Create / Test：`tests/group-crud.test.ts`

**Steps**

- [ ] 1.1 建立測試檔，內容如下（完整貼上）：

```ts
// tests/group-crud.test.ts
// V6 P6: product_groups CRUD (create + update) integration tests against stage worker.
//
// Covers spec §5.2:
//   - POST /api/admin/product-groups/create: slug [a-z0-9-]+, (season_id,slug) unique,
//     name required, display_order/available optional, audit group_create, new stock_fen=0.
//   - PATCH /api/admin/product-groups/[id]: edit name/available/display_order,
//     REJECT any body containing stock_fen (stock only via intake), audit group_update.
//   - auth (authorizeAdmin) + CSRF (requireSameOrigin).
//
// Skipped without MANGO_STAGE_URL + TEST_TOKEN (see tests/_setup.ts).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedActiveSeasonScenario,
  seedGroup,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SEASON_CODE = "test-group-crud-season";
const GROUP_SLUG = "test-gcrud-existing"; // pre-seeded group for update/dup tests
const NEW_SLUG = "test-gcrud-new"; // created via API in create tests

let seasonId = 0;
let existingGroupId = 0;

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

// One active season + one pre-existing group, no SKUs needed for CRUD shape.
function seedScenario() {
  const r = seedActiveSeasonScenario({
    season_code: SEASON_CODE,
    group_slug: GROUP_SLUG,
    initial_stock_fen: 0,
    skus: [],
  });
  seasonId = r.season_id;
  existingGroupId = r.group_id;
}

interface CreateBody {
  slug?: string | null;
  name?: string | null;
  display_order?: number;
  available?: boolean;
  stock_fen?: number; // only used to assert it's rejected
}

async function createGroup(
  cookie: string,
  body: CreateBody,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== null) headers.Origin = opts.origin ?? STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/product-groups/create`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface UpdateBody {
  name?: string;
  available?: boolean;
  display_order?: number;
  stock_fen?: number; // only used to assert it's rejected
  expected?: { name: string; available: boolean; display_order: number };
}

async function updateGroup(
  cookie: string,
  groupId: number | string,
  body: UpdateBody,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== null) headers.Origin = opts.origin ?? STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/product-groups/${groupId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

describe("V6 P6 product-groups create", () => {
  it("happy path: creates group in active season with stock_fen=0 + audit group_create", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, {
      slug: NEW_SLUG,
      name: "test-新群種",
      display_order: 5,
      available: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; group_id: number; slug: string };
    expect(body.ok).toBe(true);
    expect(typeof body.group_id).toBe("number");
    expect(body.slug).toBe(NEW_SLUG);

    const rows = d1Execute(
      `SELECT slug, name, stock_fen, available, display_order, season_id
         FROM product_groups WHERE id = ${body.group_id}`,
    ) as Array<{
      slug: string;
      name: string;
      stock_fen: number;
      available: number;
      display_order: number;
      season_id: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.slug).toBe(NEW_SLUG);
    expect(rows[0]!.name).toBe("test-新群種");
    expect(rows[0]!.stock_fen).toBe(0); // never set on create
    expect(rows[0]!.available).toBe(1);
    expect(rows[0]!.display_order).toBe(5);
    expect(rows[0]!.season_id).toBe(seasonId);

    const audit = d1Execute(
      `SELECT action, details FROM audit_log
        WHERE action = 'group_create' AND season_id = ${seasonId}
        ORDER BY ts DESC LIMIT 1`,
    ) as Array<{ action: string; details: string }>;
    expect(audit.length).toBe(1);
    const d = JSON.parse(audit[0]!.details) as {
      group_id: number;
      slug: string;
      name: string;
    };
    expect(d.slug).toBe(NEW_SLUG);
    expect(d.name).toBe("test-新群種");
    expect(d.group_id).toBe(body.group_id);
  });

  it("defaults: available defaults true, display_order defaults 0", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, { slug: NEW_SLUG, name: "test-預設群" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { group_id: number };

    const rows = d1Execute(
      `SELECT available, display_order FROM product_groups WHERE id = ${body.group_id}`,
    ) as Array<{ available: number; display_order: number }>;
    expect(rows[0]!.available).toBe(1);
    expect(rows[0]!.display_order).toBe(0);
  });

  it("SLUG_TAKEN: duplicate slug in same season is rejected (409)", async () => {
    if (SKIP) return;
    seedScenario(); // GROUP_SLUG already exists in this season
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, { slug: GROUP_SLUG, name: "test-重複" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("SLUG_TAKEN");

    // No second row created.
    const rows = d1Execute(
      `SELECT COUNT(*) AS n FROM product_groups
        WHERE season_id = ${seasonId} AND slug = '${GROUP_SLUG}'`,
    ) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it("validation: bad slug (uppercase/space) rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const r1 = await createGroup(cookie, { slug: "TEST-BadSlug", name: "test-x" });
    expect(r1.status).toBe(400);

    const r2 = await createGroup(cookie, { slug: "test bad slug", name: "test-x" });
    expect(r2.status).toBe(400);
  });

  it("validation: missing name rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, { slug: NEW_SLUG, name: "" });
    expect(res.status).toBe(400);
  });

  it("auth: no cookie returns 401", async () => {
    if (SKIP) return;
    seedScenario();
    const res = await fetch(`${STAGE_URL}/api/admin/product-groups/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL },
      body: JSON.stringify({ slug: NEW_SLUG, name: "test-x" }),
    });
    expect(res.status).toBe(401);
  });

  it("csrf: missing Origin returns 403", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await createGroup(
      cookie,
      { slug: NEW_SLUG, name: "test-x" },
      { origin: null },
    );
    expect(res.status).toBe(403);
  });
});

describe("V6 P6 product-groups update (PATCH)", () => {
  it("happy path: updates name + available + display_order + audit group_update", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await updateGroup(cookie, existingGroupId, {
      name: "test-改後名",
      available: false,
      display_order: 9,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = d1Execute(
      `SELECT name, available, display_order FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; available: number; display_order: number }>;
    expect(rows[0]!.name).toBe("test-改後名");
    expect(rows[0]!.available).toBe(0);
    expect(rows[0]!.display_order).toBe(9);

    const audit = d1Execute(
      `SELECT details FROM audit_log
        WHERE action = 'group_update' AND season_id = ${seasonId}
        ORDER BY ts DESC LIMIT 1`,
    ) as Array<{ details: string }>;
    expect(audit.length).toBe(1);
    const d = JSON.parse(audit[0]!.details) as { group_id: number; changed: string[] };
    expect(d.group_id).toBe(existingGroupId);
    expect(d.changed).toContain("name");
    expect(d.changed).toContain("available");
    expect(d.changed).toContain("display_order");
  });

  it("partial: updating only available leaves name/display_order untouched", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const before = d1Execute(
      `SELECT name, display_order FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; display_order: number }>;

    const res = await updateGroup(cookie, existingGroupId, { available: false });
    expect(res.status).toBe(200);

    const after = d1Execute(
      `SELECT name, available, display_order FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; available: number; display_order: number }>;
    expect(after[0]!.available).toBe(0);
    expect(after[0]!.name).toBe(before[0]!.name);
    expect(after[0]!.display_order).toBe(before[0]!.display_order);
  });

  it("STOCK_FORBIDDEN: body containing stock_fen is rejected 400 and pool unchanged", async () => {
    if (SKIP) return;
    seedScenario();
    // give the group some stock so we can prove it didn't move
    d1Execute(`UPDATE product_groups SET stock_fen = 777 WHERE id = ${existingGroupId}`);
    const cookie = createTestAdminSession();

    const res = await updateGroup(cookie, existingGroupId, {
      name: "test-想偷改庫存",
      stock_fen: 0,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("STOCK_FORBIDDEN");

    // Neither stock nor name changed (whole request rejected before any write).
    const rows = d1Execute(
      `SELECT name, stock_fen FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; stock_fen: number }>;
    expect(rows[0]!.stock_fen).toBe(777);
    expect(rows[0]!.name).not.toBe("test-想偷改庫存");
  });

  it("NO_FIELDS: empty patch (no editable field) rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(cookie, existingGroupId, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("NO_FIELDS");
  });

  it("STALE_STATE: optimistic lock mismatch rejected 409, no write", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await updateGroup(cookie, existingGroupId, {
      name: "test-樂觀鎖測",
      expected: { name: "WRONG-OLD-NAME", available: true, display_order: 0 },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("STALE_STATE");

    const rows = d1Execute(
      `SELECT name FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string }>;
    expect(rows[0]!.name).not.toBe("test-樂觀鎖測");
  });

  it("validation: bad name (too long) rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const longName = "x".repeat(60); // > 50
    const res = await updateGroup(cookie, existingGroupId, { name: longName });
    expect(res.status).toBe(400);
  });

  it("404: non-existent group id", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(cookie, 99999999, { name: "test-nope" });
    expect(res.status).toBe(404);
  });

  it("validation: non-integer id returns 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(cookie, "abc", { name: "test-x" });
    expect(res.status).toBe(400);
  });

  it("auth: no cookie returns 401", async () => {
    if (SKIP) return;
    seedScenario();
    const res = await fetch(`${STAGE_URL}/api/admin/product-groups/${existingGroupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL },
      body: JSON.stringify({ name: "test-x" }),
    });
    expect(res.status).toBe(401);
  });

  it("csrf: missing Origin returns 403", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(
      cookie,
      existingGroupId,
      { name: "test-x" },
      { origin: null },
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] 1.2 確認 TypeScript 能編譯此測試檔（route 雖未建，測試檔本身不直接 import route，只打 HTTP，所以 type-check 應通過；若 stage env 缺，跑測試會全 skip）：
  ```bash
  bun run build 2>&1 | tail -20
  ```
  **預期**：build/type-check 成功（測試檔不被 build 納入，但確保沒有語法錯誤可先用下一步）。

- [ ] 1.3 跑測試，觀察 TDD 紅燈訊號：
  ```bash
  bun test tests/group-crud.test.ts 2>&1 | tail -30
  ```
  **預期（有 stage env 時）FAIL**：route 不存在，stage 對 `POST /api/admin/product-groups/create` 與 `PATCH /api/admin/product-groups/:id` 回 404。failing assertions 例如 `expect(res.status).toBe(200)` 收到 `404`、`SLUG_TAKEN` 測試 `expect(res.status).toBe(409)` 收到 404。
  **預期（無 stage env 時）**：印出 `⚠️ V5.2 tests need MANGO_STAGE_URL + TEST_TOKEN env ... Skipping`，所有 `it` 因 `if (SKIP) return;` 變成 pass（0 失敗）。此時「紅燈」改由 Task 2/3 建完 route 後、實際打 stage 驗證；若本機完全無 stage env，請在 Task 7 的 stage QA 階段補跑此檔確認由紅轉綠。

- [ ] 1.4 Commit 測試骨架（先讓測試進版控，符合 TDD「先紅」）：
  ```bash
  git checkout -b feat/v6-p6-groups
  git add tests/group-crud.test.ts docs/superpowers/plans/v6/P6-groups.md
  git commit -m "test(groups): add failing CRUD integration tests for product-groups (V6 P6)

Covers create (slug validation, season-unique, audit), update (name/
available/display_order, stock_fen rejection, optimistic lock), auth+CSRF.
Routes not implemented yet — these fail against stage until Task 2/3.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2：`POST /api/admin/product-groups/create`

最小實作讓 create 那組測試轉綠：驗 `slug [a-z0-9-]+`、`name` 必填、查當季 active season、同季 slug 唯一（回 `SLUG_TAKEN`）、`stock_fen` 固定 0、同 batch 寫 `group_create` audit。

**Files**
- Create：`src/pages/api/admin/product-groups/create.ts`

**Steps**

- [ ] 2.1 建立 `src/pages/api/admin/product-groups/create.ts`，完整內容如下：

```ts
import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { product_groups, seasons } from "../../../../db/schema";
import { env } from "../../../../lib/env";

// V6 P6 (spec §5.2): create a product_group within the active season.
//
// Contract:
//   - slug: required, /^[a-z0-9-]+$/, <= 40 chars, unique within the season.
//   - name: required Chinese/display name, <= 50 chars.
//   - display_order: optional int (default 0).
//   - available: optional boolean (default true).
//   - stock_fen is NEVER set here — new groups start at 0 and only change via
//     POST /api/admin/product-groups/:id/intake. (Audit invariant lives there.)
//
// Auth: authorizeAdmin(..., "admin") — also runs requireSameOrigin for non-GET.
// Audit: action='group_create' (written right after the INSERT; see design note below
//        for why this path is INSERT-then-read-id rather than a batch/RETURNING).
export const POST: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: {
    slug?: string;
    name?: string;
    display_order?: number;
    available?: boolean;
    stock_fen?: number;
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  // Stock can never be set through this path.
  if (body.stock_fen !== undefined) {
    return json(
      { ok: false, error_code: "STOCK_FORBIDDEN", message: "stock is set via intake only" },
      400,
    );
  }

  const slug = (body.slug ?? "").trim();
  const name = (body.name ?? "").trim();
  const display_order = Number.isFinite(body.display_order) ? Number(body.display_order) : 0;
  const available = body.available === undefined ? true : Boolean(body.available);

  if (!slug || !/^[a-z0-9-]+$/.test(slug) || slug.length > 40) {
    return text("bad slug (lowercase a-z0-9- , up to 40 chars)", 400);
  }
  if (!name || name.length > 50) return text("bad name (1-50 chars)", 400);
  if (!Number.isInteger(display_order) || display_order < 0 || display_order > 100_000) {
    return text("bad display_order", 400);
  }

  const db = makeDb(env);

  // Resolve active season.
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  if (seasonRow.length === 0) {
    return json({ ok: false, error_code: "NO_ACTIVE_SEASON" }, 409);
  }
  const seasonId = seasonRow[0]!.id;

  // App-level uniqueness check (the partial unique index on (season_id, slug) is the
  // real guard, but checking first lets us return a clean SLUG_TAKEN instead of a
  // raw constraint error).
  const dup = await db
    .select({ id: product_groups.id })
    .from(product_groups)
    .where(and(eq(product_groups.season_id, seasonId), eq(product_groups.slug, slug)))
    .limit(1);
  if (dup.length > 0) {
    return json(
      { ok: false, error_code: "SLUG_TAKEN", slug, season_id: seasonId },
      409,
    );
  }

  const now = new Date().toISOString();
  // INSERT the group, then resolve its id by (season_id, slug) — the same
  // insert-then-select pattern the test helper seedGroup uses. We deliberately
  // avoid `RETURNING` (no existing precedent in this codebase) to stay on the
  // already-proven `.run()` / `.first<>()` D1 surface used by intake.ts/stock.ts.
  await env.DB.prepare(
    `INSERT INTO product_groups (season_id, slug, name, stock_fen, available, display_order, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(seasonId, slug, name, available ? 1 : 0, display_order, now)
    .run();

  const created = await env.DB.prepare(
    `SELECT id FROM product_groups WHERE season_id = ? AND slug = ?`,
  )
    .bind(seasonId, slug)
    .first<{ id: number }>();
  if (!created || typeof created.id !== "number") {
    // Should be impossible (we just inserted), but never trust a null read.
    return json({ ok: false, error_code: "CREATE_FAILED" }, 500);
  }
  const groupId = created.id;

  await env.DB.prepare(
    `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now,
      auth.session.email,
      "group_create",
      null,
      seasonId,
      JSON.stringify({
        group_id: groupId,
        slug,
        name,
        display_order,
        available,
      }),
    )
    .run();

  return json({ ok: true, group_id: groupId, slug });
};
```

> **設計註記（為什麼 INSERT solo + 讀 id + audit solo，不 batch，不用 RETURNING）**：
> - **不用 `RETURNING`**：此 codebase 全無 `RETURNING` 先例（grep 確認為 0 處），既有 D1 寫入一律 `.run()` / 讀取 `.first<>()`。為與既有風格一致並降風險，改採「INSERT → 以 `(season_id, slug)` 唯一鍵 SELECT 回 id」——與 `tests/_setup.ts` 的 `seedGroup` 完全相同模式。`(season_id, slug)` 有唯一索引，SELECT 必定取回剛插入的那一列（同一 worker request 內、INSERT 已 commit）。
> - **不 batch**：要先拿到新 id 才能填 audit `details.group_id`，而 batch 的語句須一次組好、無法用前一句回傳值。create 不像 intake/cancel 有「0-row CAS 幻影 audit」風險——INSERT 要嘛成功產生一列、要嘛因 unique 索引整句丟錯（被外層 runtime 接住回 500；下方並發風險已由前面的 app 層 `SLUG_TAKEN` 預檢 + 唯一索引兜底）。
> - **並發 SLUG_TAKEN**：兩個 admin 同時建同一 slug 時，app 層預檢可能都看到「不存在」而都進到 INSERT；第二個 INSERT 會撞唯一索引丟錯 → 該請求回 500（少數邊界，可接受；店主場景幾乎不會同秒建同 slug）。若日後要把它也轉成乾淨的 `SLUG_TAKEN`，可在 INSERT 外包 try/catch 偵測 unique 違反字串——本版不過度設計（YAGNI）。
> - **reconcile 不受影響**：群組建立沒有 `stock_fen` 變動，新群組 `stock_fen=0` 永遠對帳；即使「INSERT 成功但 audit 失敗」也只是多一個沒 audit 的群組，不影響 `reconcile-stock.ts`（它只比對 `stock_fen` 與 `group_stock_change` 加總）。

- [ ] 2.2 跑 create 那組測試（過濾 describe）：
  ```bash
  bun test tests/group-crud.test.ts -t "create" 2>&1 | tail -30
  ```
  **預期（有 stage env）PASS**：`happy path`、`defaults`、`SLUG_TAKEN`、`bad slug`、`missing name`、`auth no cookie`、`csrf missing Origin` 全綠。
  **預期（無 stage env）**：全 skip（pass）。

- [ ] 2.3 type-check 整包確保 route 無型別錯：
  ```bash
  bun run build 2>&1 | tail -15
  ```
  **預期**：成功（無 TS 錯）。`astro build` 會把新 route 納入。

- [ ] 2.4 Commit：
  ```bash
  git add src/pages/api/admin/product-groups/create.ts
  git commit -m "feat(groups): POST /api/admin/product-groups/create (V6 P6 §5.2)

Creates a product_group in the active season: slug [a-z0-9-]+ unique per
season (SLUG_TAKEN), name required, optional display_order/available,
stock_fen forced to 0 (intake owns stock). Audit group_create. Auth+CSRF
via authorizeAdmin.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3：`PATCH /api/admin/product-groups/[id]`

改 `name`/`available`/`display_order`；**明確拒絕任何含 `stock_fen` 的請求**（庫存只走 intake）；可選 `expected` 樂觀鎖（沿用 cancel.ts 的 gate-first：先 SELECT 比對 → 再單句 UPDATE + audit batch）。

**Files**
- Create：`src/pages/api/admin/product-groups/[id].ts`

**Steps**

- [ ] 3.1 建立 `src/pages/api/admin/product-groups/[id].ts`，完整內容如下：

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { product_groups } from "../../../../db/schema";
import { env } from "../../../../lib/env";

// V6 P6 (spec §5.2): edit a product_group's display fields.
//
// Editable: name, available, display_order. ANY of the three may be present;
// at least one must be (NO_FIELDS otherwise).
//
// Hard rule: a body containing `stock_fen` is rejected (STOCK_FORBIDDEN, 400) —
// stock is owned by product_groups.stock_fen and may ONLY change via
// POST /api/admin/product-groups/:id/intake (two-sided CAS + same-batch audit).
// This endpoint never touches stock_fen.
//
// Optional optimistic lock: body.expected {name, available, display_order} is
// compared against the current row before writing (STALE_STATE on mismatch),
// mirroring the gate-first pattern in cancel.ts — SELECT-validate, then a single
// env.DB.batch([UPDATE, INSERT audit]).
//
// Auth: authorizeAdmin(..., "admin") (also runs requireSameOrigin for PATCH).
// Audit: action='group_update', details {group_id, changed[], before, after}.
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const groupId = Number(params.id);
  if (!Number.isInteger(groupId) || groupId <= 0) return text("bad id", 400);

  let body: {
    name?: string;
    available?: boolean;
    display_order?: number;
    stock_fen?: number;
    expected?: { name: string; available: boolean; display_order: number };
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  // Stock is never editable here.
  if (body.stock_fen !== undefined) {
    return json(
      { ok: false, error_code: "STOCK_FORBIDDEN", message: "stock is set via intake only" },
      400,
    );
  }

  // Collect the editable fields actually present, with validation.
  const updates: { name?: string; available?: boolean; display_order?: number } = {};
  const changed: string[] = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 50) return text("bad name (1-50 chars)", 400);
    updates.name = name;
    changed.push("name");
  }
  if (body.available !== undefined) {
    updates.available = Boolean(body.available);
    changed.push("available");
  }
  if (body.display_order !== undefined) {
    const do_ = Number(body.display_order);
    if (!Number.isInteger(do_) || do_ < 0 || do_ > 100_000) {
      return text("bad display_order", 400);
    }
    updates.display_order = do_;
    changed.push("display_order");
  }

  if (changed.length === 0) {
    return json({ ok: false, error_code: "NO_FIELDS", message: "nothing to update" }, 400);
  }

  const db = makeDb(env);
  const rows = await db
    .select()
    .from(product_groups)
    .where(eq(product_groups.id, groupId))
    .limit(1);
  const group = rows[0];
  if (!group) return text("group not found", 404);

  // Optional optimistic lock (gate-first, like cancel.ts): compare expected vs current.
  if (body.expected) {
    if (
      group.name !== body.expected.name ||
      group.available !== body.expected.available ||
      group.display_order !== body.expected.display_order
    ) {
      return json(
        {
          ok: false,
          error_code: "STALE_STATE",
          current: {
            name: group.name,
            available: group.available,
            display_order: group.display_order,
          },
        },
        409,
      );
    }
  }

  const before = {
    name: group.name,
    available: group.available,
    display_order: group.display_order,
  };
  const after = {
    name: updates.name ?? group.name,
    available: updates.available ?? group.available,
    display_order: updates.display_order ?? group.display_order,
  };
  const now = new Date().toISOString();

  // Single batch: UPDATE the three columns (untouched ones keep current value via
  // the `after` snapshot) + INSERT the audit row. No stock_fen in the UPDATE.
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE product_groups
            SET name = ?, available = ?, display_order = ?
          WHERE id = ?`,
      )
      .bind(after.name, after.available ? 1 : 0, after.display_order, groupId),
    env.DB
      .prepare(
        `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        now,
        auth.session.email,
        "group_update",
        null,
        group.season_id,
        JSON.stringify({ group_id: groupId, changed, before, after }),
      ),
  ]);

  return json({ ok: true, group_id: groupId, changed });
};
```

> **設計註記**：
> - **為什麼這裡可以 batch（不像 intake）**：本 UPDATE 用 `WHERE id = ?`（主鍵），群組存在就一定改到 1 列；不像 intake/mark-paid 用條件式 CAS（`WHERE ... AND stock_fen = ?`）會出現「0-row 仍算成功 stmt」的幻影 audit 陷阱。樂觀鎖在 batch 前用 SELECT 比對（gate-first），不靠 UPDATE 的 changes 數，因此 batch 安全。
> - **UPDATE 寫三欄但用 `after` 快照**：未在請求中的欄位填回原值（`updates.x ?? group.x`），等同 no-op，避免動態組 SQL；`changed[]` 仍只記真正變動的欄位，供 audit 與 UI 顯示。
> - **`stock_fen` 完全不在 UPDATE 子句**：即使有人想偷塞也已在開頭 400 擋掉；雙重保險。

- [ ] 3.2 跑 update 那組測試：
  ```bash
  bun test tests/group-crud.test.ts -t "update" 2>&1 | tail -40
  ```
  **預期（有 stage env）PASS**：`happy path`、`partial`、`STOCK_FORBIDDEN`、`NO_FIELDS`、`STALE_STATE`、`bad name`、`404`、`non-integer id`、`auth`、`csrf` 全綠。
  **預期（無 stage env）**：全 skip。

- [ ] 3.3 跑整個檔確認 create+update 同時綠：
  ```bash
  bun test tests/group-crud.test.ts 2>&1 | tail -15
  ```
  **預期**：全綠（或全 skip）。

- [ ] 3.4 type-check：
  ```bash
  bun run build 2>&1 | tail -15
  ```
  **預期**：成功。

- [ ] 3.5 Commit：
  ```bash
  git add "src/pages/api/admin/product-groups/[id].ts"
  git commit -m "feat(groups): PATCH /api/admin/product-groups/[id] (V6 P6 §5.2)

Edits name/available/display_order with gate-first optimistic lock
(STALE_STATE). Rejects any body with stock_fen (STOCK_FORBIDDEN) — stock
stays intake-only. NO_FIELDS on empty patch. Audit group_update with
changed[]/before/after. Single batch UPDATE+audit. Auth+CSRF.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4：庫存池頁 UI — 「＋新增群組」表單

在 `src/pages/admin/product-groups/index.astro` 既有 server 區塊與 markup 上，加一個「＋新增群組」摺疊表單（呼叫 Task 2 的 create API），沿用既有 toast（`showToast`/`flashToast`/`consumeFlash`）與 reload-after-mutation 模式。

> 先複習目前檔案：server frontmatter（行 1-87）查 `activeSeason`、`groupRows`、`skusByGroup`、`recentIntake`；`<main>`（行 90-234）依序是說明、當季 banner、`<section>` 群組卡列表（行 114-194）、最近 20 筆變動。`<script>`（行 236-357）是 intake 表單處理 + `consumeFlash()`。

**Files**
- Modify：`src/pages/admin/product-groups/index.astro`（在群組列表 `<section>` 前插入新增表單；在 `<script>` 內加處理）

**Steps**

- [ ] 4.1 在當季 banner 之後、群組列表 `<section class="space-y-4">`（行 114）之前，插入「新增群組」卡片。用 Edit 把現有的這段：

```astro
    {activeSeason ? (
      <p class="mb-6 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        當季：<strong>{activeSeason.name}</strong>（{activeSeason.code}）
      </p>
    ) : (
      <p class="mb-6 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
        ⚠️ 找不到 status='active' 的 seasons 紀錄。請先設定當季。
      </p>
    )}

    <section class="space-y-4">
```

替換為（在中間插入新增群組區塊；保留前後原樣）：

```astro
    {activeSeason ? (
      <p class="mb-6 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        當季：<strong>{activeSeason.name}</strong>（{activeSeason.code}）
      </p>
    ) : (
      <p class="mb-6 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
        ⚠️ 找不到 status='active' 的 seasons 紀錄。請先設定當季。
      </p>
    )}

    {activeSeason && (
      <section class="mb-6 rounded border border-emerald-200 bg-emerald-50 p-4">
        <details data-new-group-details>
          <summary class="cursor-pointer text-sm font-medium text-emerald-800 select-none">
            ＋ 新增品種（群組）
          </summary>
          <form id="new-group-form" class="mt-3 space-y-3">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_5rem]">
              <label class="block">
                <span class="mb-1 block text-xs text-emerald-800">品種名稱（顯示用）</span>
                <input
                  type="text"
                  name="name"
                  required
                  maxlength="50"
                  aria-label="新群組品種名稱"
                  class="w-full rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500"
                  placeholder="例：愛文芒果乾"
                />
              </label>
              <label class="block">
                <span class="mb-1 block text-xs text-emerald-800">品種代碼（英數小寫、連字號）</span>
                <input
                  type="text"
                  name="slug"
                  required
                  pattern="[a-z0-9-]+"
                  maxlength="40"
                  aria-label="新群組品種代碼"
                  class="w-full rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm font-mono focus-visible:outline-2 focus-visible:outline-mango-500"
                  placeholder="例：irwin-dried"
                />
              </label>
              <label class="block">
                <span class="mb-1 block text-xs text-emerald-800">排序</span>
                <input
                  type="number"
                  name="display_order"
                  value="0"
                  min="0"
                  aria-label="新群組排序"
                  class="w-full rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500"
                />
              </label>
            </div>
            <div class="flex items-center justify-between gap-3">
              <label class="flex items-center gap-1 text-sm text-emerald-800">
                <input type="checkbox" name="available" checked />
                <span>立即上架</span>
              </label>
              <button
                type="submit"
                class="inline-flex items-center justify-center rounded bg-emerald-600 px-6 py-2 min-h-[44px] text-sm font-medium text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed"
              >
                建立品種
              </button>
            </div>
            <div
              data-new-group-error
              class="hidden rounded bg-red-50 px-3 py-2 text-xs text-red-800"
            ></div>
          </form>
        </details>
      </section>
    )}

    <section class="space-y-4">
```

- [ ] 4.2 在 `<script>` 區塊內、`consumeFlash();`（行 356）**之前**插入「新增群組」表單處理。用 Edit 把現有結尾：

```astro
    consumeFlash();
  </script>
```

替換為：

```astro
    // ============ Create new product_group (V6 P6 §5.2) ============
    interface GroupCreateOk {
      ok: true;
      group_id: number;
      slug: string;
    }
    interface GroupCreateFail {
      ok: false;
      error_code: string;
      message?: string;
      slug?: string;
    }

    const newGroupForm = document.getElementById("new-group-form") as HTMLFormElement | null;
    if (newGroupForm) {
      const ngErr = newGroupForm.querySelector<HTMLElement>("[data-new-group-error]")!;
      const ngBtn = newGroupForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;

      function ngShowErr(msg: string): void {
        ngErr.textContent = msg;
        ngErr.classList.remove("hidden");
      }
      function ngClearErr(): void {
        ngErr.textContent = "";
        ngErr.classList.add("hidden");
      }

      newGroupForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        ngClearErr();

        const fd = new FormData(newGroupForm);
        const name = String(fd.get("name") ?? "").trim();
        const slug = String(fd.get("slug") ?? "").trim();
        const displayOrder = Number(fd.get("display_order") ?? 0);
        const available = fd.get("available") === "on";

        if (!name) {
          ngShowErr("請填品種名稱");
          return;
        }
        if (!/^[a-z0-9-]+$/.test(slug)) {
          ngShowErr("品種代碼只能小寫英數與連字號（例：irwin-dried）");
          return;
        }

        ngBtn.disabled = true;
        const original = ngBtn.textContent;
        ngBtn.textContent = "建立中...";

        try {
          const res = await fetch("/api/admin/product-groups/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              name,
              slug,
              display_order: Number.isFinite(displayOrder) ? displayOrder : 0,
              available,
            }),
          });

          const ct = res.headers.get("content-type") ?? "";
          if (!ct.includes("application/json")) {
            ngShowErr(`伺服器回應異常 (${res.status})：${await res.text()}`);
            ngBtn.disabled = false;
            ngBtn.textContent = original;
            return;
          }

          const data = (await res.json()) as GroupCreateOk | GroupCreateFail;
          if (res.ok && "ok" in data && data.ok) {
            flashToast(`已新增品種：${name}`, { kind: "success" });
            location.reload();
            return;
          }

          const fail = data as GroupCreateFail;
          if (fail.error_code === "SLUG_TAKEN") {
            ngShowErr(`品種代碼「${fail.slug ?? slug}」當季已存在，請換一個。`);
          } else if (fail.error_code === "NO_ACTIVE_SEASON") {
            ngShowErr("目前沒有啟用中的年度季節，請先到「年度設定」啟用當季。");
          } else {
            ngShowErr(`新增失敗 (${fail.error_code})：${fail.message ?? "?"}`);
          }
          ngBtn.disabled = false;
          ngBtn.textContent = original;
        } catch {
          ngShowErr("網路錯誤，請稍後再試。");
          ngBtn.disabled = false;
          ngBtn.textContent = original;
        }
      });
    }

    consumeFlash();
  </script>
```

- [ ] 4.3 type-check（Astro 會編譯頁面內 client script）：
  ```bash
  bun run build 2>&1 | tail -20
  ```
  **預期**：成功，無 TS 錯。

- [ ] 4.4 手動冒煙（dev server；需 `.env` 有 stage/local 設定才能登入後台，否則略過視覺檢查，靠 Task 1 整合測試覆蓋邏輯）：
  ```bash
  bun run dev
  ```
  在瀏覽器 `http://localhost:4321/admin/product-groups` 展開「＋ 新增品種」，填「test-視覺-愛文 / test-visual-irwin」送出，應 toast「已新增品種」並 reload 後在列表看到新群組（`stock_fen=0` 顯示「0.00 斤」）。**驗後請手動刪除這筆測試群組**（或在 stage 上用 cleanupTestData 前綴）。停止 dev server（Ctrl-C）。
  > 若本機無法登入後台，跳過此步——Task 1 的整合測試已覆蓋 create API 行為，UI 串接由 Task 7 stage QA 驗。

- [ ] 4.5 Commit：
  ```bash
  git add src/pages/admin/product-groups/index.astro
  git commit -m "feat(groups): add '+ new group' form to stock pool page (V6 P6 §5.2)

Collapsible create form on /admin/product-groups posting to the create
API; reuses toast + reload-after-mutation. Friendly SLUG_TAKEN /
NO_ACTIVE_SEASON messages. Terminology: slug shown as 品種代碼.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5：庫存池頁 UI — 每群組「編輯（改名/排序）+ 上下架」

在每張群組卡（行 115-187 的 `groupRows.map`）的 header 加「編輯」按鈕展開 inline 編輯表單（改 name/display_order）+「上架/下架」切換按鈕，皆呼叫 Task 3 的 PATCH API，帶 `expected` 樂觀鎖。

**Files**
- Modify：`src/pages/admin/product-groups/index.astro`（群組卡 header + script）

**Steps**

- [ ] 5.1 在群組卡 header 加上「目前 available 狀態 badge + 編輯/上下架按鈕」。用 Edit 把現有 header（行 124-137）：

```astro
            <header class="mb-3 flex items-baseline justify-between">
              <div>
                <h2 class="text-lg font-bold">{g.name}</h2>
                <div class="font-mono text-xs text-gray-500">{g.slug}</div>
              </div>
              <div class="text-right">
                <div class="text-2xl font-bold text-mango-700" data-current-jin>
                  {fenToJin(g.stock_fen)} 斤
                </div>
                <div class="text-xs text-gray-500" data-current-fen-label>
                  ({g.stock_fen} fen)
                </div>
              </div>
            </header>
```

替換為（保留庫存顯示；新增狀態 badge + 操作列 + 隱藏的 inline 編輯表單。注意 `data-group-card` 上補了 `data-group-name`/`data-group-available`/`data-group-display-order` 供樂觀鎖 `expected` 用）：

```astro
            <header class="mb-3 flex items-baseline justify-between">
              <div>
                <div class="flex items-center gap-2">
                  <h2 class="text-lg font-bold" data-group-name-display>{g.name}</h2>
                  {g.available ? (
                    <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      上架中
                    </span>
                  ) : (
                    <span class="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                      已下架
                    </span>
                  )}
                </div>
                <div class="font-mono text-xs text-gray-500">品種代碼：{g.slug}</div>
              </div>
              <div class="text-right">
                <div class="text-2xl font-bold text-mango-700" data-current-jin>
                  {fenToJin(g.stock_fen)} 斤
                </div>
              </div>
            </header>

            <div class="mb-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-edit-toggle
                class="inline-flex items-center justify-center rounded border border-gray-300 px-3 py-1.5 min-h-[36px] text-xs text-gray-700 hover:bg-gray-50"
              >
                編輯名稱／排序
              </button>
              <button
                type="button"
                data-toggle-available
                data-available={g.available ? "1" : "0"}
                class="inline-flex items-center justify-center rounded border px-3 py-1.5 min-h-[36px] text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                class:list={[
                  g.available
                    ? "border-amber-300 text-amber-700 hover:bg-amber-50"
                    : "border-emerald-300 text-emerald-700 hover:bg-emerald-50",
                ]}
              >
                {g.available ? "下架此品種" : "重新上架"}
              </button>
            </div>

            <form data-edit-form class="mb-3 hidden space-y-2 rounded bg-gray-50 p-3">
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_5rem]">
                <label class="block">
                  <span class="mb-1 block text-[11px] text-gray-600">品種名稱</span>
                  <input
                    type="text"
                    name="name"
                    required
                    maxlength="50"
                    value={g.name}
                    aria-label={`${g.name} 改名`}
                    class="w-full rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500"
                  />
                </label>
                <label class="block">
                  <span class="mb-1 block text-[11px] text-gray-600">排序</span>
                  <input
                    type="number"
                    name="display_order"
                    min="0"
                    value={g.display_order}
                    aria-label={`${g.name} 排序`}
                    class="w-full rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500"
                  />
                </label>
              </div>
              <div class="flex items-center justify-end gap-2">
                <button
                  type="button"
                  data-edit-cancel
                  class="inline-flex items-center justify-center rounded px-3 py-1.5 min-h-[36px] text-xs text-gray-600 hover:bg-gray-100"
                >
                  取消
                </button>
                <button
                  type="submit"
                  class="inline-flex items-center justify-center rounded bg-mango-600 px-4 py-1.5 min-h-[36px] text-xs text-white hover:bg-mango-700 disabled:bg-mango-300 disabled:cursor-not-allowed"
                >
                  儲存
                </button>
              </div>
              <div data-edit-error class="hidden rounded bg-red-50 px-3 py-2 text-[11px] text-red-800"></div>
            </form>
```

- [ ] 5.2 在 `<article>` 開頭的 data 屬性補上樂觀鎖所需的當前值。用 Edit 把現有（行 118-123）：

```astro
          <article
            class="rounded border border-gray-200 bg-white p-4"
            data-group-card
            data-group-id={g.id}
            data-current-fen={g.stock_fen}
          >
```

替換為：

```astro
          <article
            class="rounded border border-gray-200 bg-white p-4"
            data-group-card
            data-group-id={g.id}
            data-current-fen={g.stock_fen}
            data-group-name={g.name}
            data-group-available={g.available ? "1" : "0"}
            data-group-display-order={g.display_order}
          >
```

- [ ] 5.3 在 `<script>` 內、`consumeFlash();` 之前（即 Task 4 已加的新增群組處理之後）插入每群組編輯/上下架處理。用 Edit 把：

```astro
    consumeFlash();
  </script>
```

替換為：

```astro
    // ============ Edit / toggle-available per group (V6 P6 §5.2) ============
    interface GroupUpdateOk {
      ok: true;
      group_id: number;
      changed: string[];
    }
    interface GroupUpdateFail {
      ok: false;
      error_code: string;
      message?: string;
      current?: { name: string; available: boolean; display_order: number };
    }

    async function patchGroup(
      groupId: number,
      payload: {
        name?: string;
        available?: boolean;
        display_order?: number;
        expected: { name: string; available: boolean; display_order: number };
      },
    ): Promise<{ res: Response; data: GroupUpdateOk | GroupUpdateFail | null }> {
      const res = await fetch(`/api/admin/product-groups/${groupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const ct = res.headers.get("content-type") ?? "";
      const data = ct.includes("application/json")
        ? ((await res.json()) as GroupUpdateOk | GroupUpdateFail)
        : null;
      return { res, data };
    }

    document.querySelectorAll<HTMLElement>("[data-group-card]").forEach((card) => {
      const groupId = Number(card.dataset.groupId);
      const expected = {
        name: card.dataset.groupName ?? "",
        available: card.dataset.groupAvailable === "1",
        display_order: Number(card.dataset.groupDisplayOrder ?? 0),
      };

      // --- inline edit (name / display_order) ---
      const editToggle = card.querySelector<HTMLButtonElement>("[data-edit-toggle]");
      const editForm = card.querySelector<HTMLFormElement>("[data-edit-form]");
      const editCancel = card.querySelector<HTMLButtonElement>("[data-edit-cancel]");
      const editErr = card.querySelector<HTMLElement>("[data-edit-error]");

      function editShowErr(msg: string): void {
        if (!editErr) return;
        editErr.textContent = msg;
        editErr.classList.remove("hidden");
      }
      function editClearErr(): void {
        if (!editErr) return;
        editErr.textContent = "";
        editErr.classList.add("hidden");
      }

      editToggle?.addEventListener("click", () => {
        editForm?.classList.toggle("hidden");
        editClearErr();
      });
      editCancel?.addEventListener("click", () => {
        editForm?.classList.add("hidden");
        editClearErr();
      });

      editForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        editClearErr();
        const fd = new FormData(editForm);
        const name = String(fd.get("name") ?? "").trim();
        const displayOrder = Number(fd.get("display_order") ?? 0);
        if (!name) {
          editShowErr("請填品種名稱");
          return;
        }
        const submitBtn = editForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        submitBtn.disabled = true;
        const original = submitBtn.textContent;
        submitBtn.textContent = "儲存中...";
        try {
          const { res, data } = await patchGroup(groupId, {
            name,
            display_order: Number.isFinite(displayOrder) ? displayOrder : 0,
            expected,
          });
          if (res.ok && data && "ok" in data && data.ok) {
            flashToast(`已更新「${name}」`, { kind: "success" });
            location.reload();
            return;
          }
          const fail = data as GroupUpdateFail | null;
          if (fail?.error_code === "STALE_STATE") {
            editShowErr("此品種在你載入後被其他人改過，請重新整理頁面再試。");
          } else {
            editShowErr(`儲存失敗 (${fail?.error_code ?? res.status})：${fail?.message ?? "?"}`);
          }
          submitBtn.disabled = false;
          submitBtn.textContent = original;
        } catch {
          editShowErr("網路錯誤，請稍後再試。");
          submitBtn.disabled = false;
          submitBtn.textContent = original;
        }
      });

      // --- toggle available (上架/下架) ---
      const toggleBtn = card.querySelector<HTMLButtonElement>("[data-toggle-available]");
      toggleBtn?.addEventListener("click", async () => {
        const currentlyAvailable = toggleBtn.dataset.available === "1";
        const next = !currentlyAvailable;
        if (!confirm(next ? `確定要重新上架「${expected.name}」？` : `確定要下架「${expected.name}」？下架後顧客端不會看到此品種。`)) {
          return;
        }
        toggleBtn.disabled = true;
        const original = toggleBtn.textContent;
        toggleBtn.textContent = "處理中...";
        try {
          const { res, data } = await patchGroup(groupId, { available: next, expected });
          if (res.ok && data && "ok" in data && data.ok) {
            flashToast(next ? `已重新上架「${expected.name}」` : `已下架「${expected.name}」`, {
              kind: "success",
            });
            location.reload();
            return;
          }
          const fail = data as GroupUpdateFail | null;
          if (fail?.error_code === "STALE_STATE") {
            showToast("此品種在你載入後被其他人改過，請重新整理後再試。", { kind: "error" });
          } else {
            showToast(`操作失敗 (${fail?.error_code ?? res.status})`, { kind: "error" });
          }
          toggleBtn.disabled = false;
          toggleBtn.textContent = original;
        } catch {
          showToast("網路錯誤，請稍後再試。", { kind: "error" });
          toggleBtn.disabled = false;
          toggleBtn.textContent = original;
        }
      });
    });

    consumeFlash();
  </script>
```

> **註記**：`showToast` 已在 `<script>` 第一行 import（行 237：`import { showToast, flashToast, consumeFlash } from "../../../lib/toast";`），可直接用。`confirm()` 是瀏覽器原生，CSP 不擋。

- [ ] 5.4 type-check：
  ```bash
  bun run build 2>&1 | tail -20
  ```
  **預期**：成功，無 TS 錯。

- [ ] 5.5 手動冒煙（同 Task 4.4 條件；可選）：dev server 上對既有測試群組點「下架此品種」→ 確認 badge 變「已下架」、按鈕變「重新上架」；點「編輯名稱／排序」改名儲存 → toast + reload 後名稱更新。停 dev server。
  > 無法登入則跳過，靠 Task 1 PATCH 測試 + Task 7 stage QA。

- [ ] 5.6 Commit：
  ```bash
  git add src/pages/admin/product-groups/index.astro
  git commit -m "feat(groups): per-group edit + list/unlist controls on pool page (V6 P6 §5.2)

Each group card gets an availability badge, inline edit (name/display_
order) and a list/unlist toggle, all PATCHing with an expected-state
optimistic lock (STALE_STATE → friendly refresh prompt). Confirm dialog
before unlisting.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6：一條龍導引（建群組 → 進貨 → 建品項）

把三步串成可發現的流程（spec §5.5）：
1. **空狀態升級**：當季尚無群組時，目前文案是「請先到『商品管理』建立 SKU（會自動建立 group）」（行 189-193）——但 V5.2 已不再自動建 group，且本模組已提供建群組入口。改為引導「先建品種（群組）→ 再進貨 → 再建品項」。
2. **每群組「新增此品種的品項」連結**：在每張群組卡底部加一個連到 `/admin/products?group=<slug>` 的連結，讓店主建完群組、進完貨後一鍵跳去建該品種的 SKU（並預選群組）。
3. **products 頁接收 `?group=<slug>`**：在 `src/pages/admin/products/index.astro` 的新增表單，若 URL 帶 `?group=<slug>` 則把「所屬群組」下拉預選該 slug。

> **Coordination note（與 §5.3 地基修復模組的邊界）**：spec §5.3 指出 products 新增表單目前**缺** `group_slug` + `package_fen` 兩個欄位，導致新增必失敗，由「地基修復」模組負責補齊群組下拉與包裝大小下拉。本 Task 6 的 products 頁改動**只負責**：(a) 確保新增表單有「所屬群組」下拉且其 option 來自當季 `product_groups`；(b) 讀 `?group=` query 預選。
>
> 執行順序判斷：
> - **若地基修復模組已先落地**（products 頁已有 `group_slug` 下拉 + `package_fen` 下拉，且 readForm/fetch 已送這兩欄）：本 Task 只需做 6.3「讀 query 預選下拉」一處小改 + 6.1/6.2 群組頁改動。
> - **若尚未落地**（products 頁仍是行 131-159 那個缺欄位的舊表單）：本 Task 6 額外提供「群組下拉 + package_fen 下拉 + readForm/fetch 補欄位」的完整 code（6.4，標為 conditional），避免一條龍連結跳過去卻仍無法建品項。實作時先 `grep -n "group_slug\|package_fen" src/pages/admin/products/index.astro` 判斷，已存在則跳過 6.4。

**Files**
- Modify：`src/pages/admin/product-groups/index.astro`（空狀態文案 + 每群組「新增品項」連結）
- Modify：`src/pages/admin/products/index.astro`（群組下拉預選 `?group=`；conditional：補 group_slug + package_fen 欄位）

**Steps**

- [ ] 6.1 升級空狀態文案。用 Edit 把群組頁現有（行 189-193）：

```astro
      {groupRows.length === 0 && activeSeason && (
        <p class="rounded border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          當季尚無品種。請先到「商品管理」建立 SKU（會自動建立 group）。
        </p>
      )}
```

替換為：

```astro
      {groupRows.length === 0 && activeSeason && (
        <div class="rounded border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-600">
          <p class="mb-2 font-medium">當季還沒有任何品種</p>
          <p class="mb-4 text-gray-500">
            建立年度芒果販賣的三步驟：
            <br />① 在上方「＋ 新增品種」建立品種（如金煌芒果乾）
            <br />② 在品種卡片填「斤數」進貨
            <br />③ 進貨後到品種卡的「新增此品種的品項」建立各包裝 SKU（半斤／1 斤…）
          </p>
        </div>
      )}
```

- [ ] 6.2 在每張群組卡底部、intake 表單 `</form>`（行 184）之後、`</article>`（行 185）之前，加「新增此品種的品項」連結。用 Edit 把：

```astro
              <div
                class="intake-error hidden sm:col-span-3 rounded bg-red-50 px-3 py-2 text-xs text-red-800"
              ></div>
            </form>
          </article>
```

替換為：

```astro
              <div
                class="intake-error hidden sm:col-span-3 rounded bg-red-50 px-3 py-2 text-xs text-red-800"
              ></div>
            </form>

            <div class="mt-3 border-t border-gray-100 pt-3">
              <a
                href={`/admin/products?group=${g.slug}`}
                class="inline-flex items-center gap-1 text-xs text-mango-700 underline hover:text-mango-800"
              >
                ＋ 新增此品種的品項（半斤／1 斤…）
              </a>
              {(skusByGroup.get(g.id) ?? []).length === 0 && (
                <span class="ml-2 text-[11px] text-gray-400">此品種尚無品項</span>
              )}
            </div>
          </article>
```

- [ ] 6.3 products 頁：讀 `?group=<slug>` 預選群組下拉。**前提**：products 頁新增表單已有 `name="group_slug"` 的 `<select>`（地基修復模組已加，或由 6.4 加）。在 `src/pages/admin/products/index.astro` 的 frontmatter 取 query，並在下拉 option 上加 `selected`。

  先確認下拉是否存在與其 server 變數名：
  ```bash
  grep -n "group_slug\|groupRows\|<select" /Users/rayhsu/Projects/Github/mango-hsu/src/pages/admin/products/index.astro
  ```

  - **若下拉已存在**：在 frontmatter 加一行取 query（放在 frontmatter 結尾 `---` 前）：
    ```ts
    const preselectGroup = Astro.url.searchParams.get("group") ?? "";
    ```
    並在群組 `<option>` 的 map 內把判斷式改為帶 `selected`（示意，依該下拉實際 option 變數調整；下拉每個 option 形如 `<option value={grp.slug}>...`）：
    ```astro
    <option value={grp.slug} selected={grp.slug === preselectGroup}>{grp.name}</option>
    ```
  - **若下拉不存在**：先做 6.4 建立下拉（其中已內含 `preselectGroup` 預選），本步驟併入 6.4，跳過。

- [ ] 6.4 **（Conditional：僅當 6.3 grep 顯示 products 頁尚無 `group_slug` 下拉時執行）** 在 products 頁新增表單補「所屬群組」下拉 + 「包裝大小」下拉，並讓 readForm/fetch 帶上 `group_slug` + `package_fen`。

  > 此步驟與 §5.3 地基修復重疊。**若地基修復模組將獨立負責此破洞，請與總編確認由誰落地，避免雙寫衝突**（見本檔末 open_concerns）。以下提供可獨立運作的完整 code。

  6.4a frontmatter：確保有當季群組清單與 query。products 頁 frontmatter 應已查 `activeSeason`；補查群組（若已有 `groupRows` 變數則複用，不要重複宣告）。在 frontmatter 結尾加：
  ```ts
  // V6 P6 一條龍：當季群組清單供新增表單下拉用 + ?group= 預選。
  const groupOptions = activeSeason
    ? await db
        .select({ slug: product_groups.slug, name: product_groups.name })
        .from(product_groups)
        .where(eq(product_groups.season_id, activeSeason.id))
        .orderBy(asc(product_groups.display_order), asc(product_groups.slug))
    : [];
  const preselectGroup = Astro.url.searchParams.get("group") ?? "";
  ```
  > 確認 frontmatter 已 import `product_groups`、`asc`、`eq`（products 頁通常已 import 多數；若缺，於 import 區補上對應符號）。實作前 `grep -n "import" src/pages/admin/products/index.astro | head` 核對。

  6.4b 新增表單欄位：在新增表單（products 頁的 `#create-form`，目前 grid 行 132-150）內，於 `sku` input 之後加兩個欄位——所屬群組下拉與包裝大小下拉。在現有 `<input ... name="sku" ... />` 區塊之後插入：
  ```astro
          <label class="flex flex-col gap-1 text-xs text-amber-800">
            <span class="sm:hidden">所屬品種</span>
            <select
              name="group_slug"
              required
              aria-label="所屬品種（群組）"
              class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm"
            >
              <option value="" disabled selected={preselectGroup === ""}>選擇品種…</option>
              {groupOptions.map((grp) => (
                <option value={grp.slug} selected={grp.slug === preselectGroup}>
                  {grp.name}
                </option>
              ))}
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-amber-800">
            <span class="sm:hidden">包裝大小</span>
            <select
              name="package_fen"
              required
              aria-label="包裝大小"
              class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm"
            >
              <option value="50">半斤（50）</option>
              <option value="100" selected>1 斤（100）</option>
              <option value="1000">10 斤（1000）</option>
            </select>
          </label>
  ```
  > 注意：新增這兩欄會讓桌面版 grid 欄數變多。若要對齊表頭（行 123 的 `sm:grid-cols-[...]`），可不嚴格對齊（手機版為主），桌面版多兩欄換行可接受；如需精修交給 §5.7 後台 UX 模組。本步驟以「功能可用」為準。

  6.4c readForm/fetch 帶上新欄位。products 頁的 create 提交 handler（行 346-370）目前 `data` 只含 `sku + readForm(...)`。用 Edit 把：
  ```astro
      const fd = new FormData(createForm);
      const data = {
        sku: String(fd.get("sku") ?? "").trim(),
        ...readForm(createForm),
      };
      if (!/^[A-Z0-9_-]+$/.test(data.sku)) {
        showToast("SKU 只能大寫英數、底線、連字號", { kind: "error" });
        return;
      }
  ```
  替換為：
  ```astro
      const fd = new FormData(createForm);
      const groupSlug = String(fd.get("group_slug") ?? "").trim();
      const packageFen = Number(fd.get("package_fen") ?? 0);
      const data = {
        sku: String(fd.get("sku") ?? "").trim(),
        group_slug: groupSlug,
        package_fen: packageFen,
        ...readForm(createForm),
      };
      if (!/^[A-Z0-9_-]+$/.test(data.sku)) {
        showToast("SKU 只能大寫英數、底線、連字號", { kind: "error" });
        return;
      }
      if (!/^[a-z0-9-]+$/.test(groupSlug)) {
        showToast("請選擇所屬品種（群組）", { kind: "error" });
        return;
      }
      if (!Number.isInteger(packageFen) || packageFen <= 0) {
        showToast("請選擇包裝大小", { kind: "error" });
        return;
      }
  ```

- [ ] 6.5 type-check：
  ```bash
  bun run build 2>&1 | tail -20
  ```
  **預期**：成功，無 TS 錯。

- [ ] 6.6 一條龍冒煙（可選，需可登入後台）：dev server 上 `/admin/product-groups`，對一個有庫存的測試群組點「＋ 新增此品種的品項」→ 應跳到 `/admin/products?group=<slug>` 且群組下拉已預選該品種；填 SKU（`TEST-視覺-X`，大寫）、選 1 斤、價格、送出 → toast「已新增商品」。回 `/admin/product-groups` 該群組底部不再顯示「此品種尚無品項」。**驗後刪除測試資料**。停 dev server。
  > 無法登入則跳過；一條龍邏輯由「create API（已測）+ products create API（地基修復模組測）」覆蓋，整段在 Task 7 stage QA 串驗。

- [ ] 6.7 Commit：
  ```bash
  git add src/pages/admin/product-groups/index.astro src/pages/admin/products/index.astro
  git commit -m "feat(groups): wire build-flow (group -> intake -> SKU) one-stop (V6 P6 §5.5)

Empty-state now teaches the 3-step flow; each group card links to
/admin/products?group=<slug> to create that flavour's SKUs; products
create form preselects the group from the query (and gains group_slug +
package_fen fields if not already present — §5.3 fix overlap noted).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7：全量驗證 + 收尾

**Files**：無（驗證 only）

**Steps**

- [ ] 7.1 全量 type-check + build：
  ```bash
  bun run build 2>&1 | tail -25
  ```
  **預期**：`astro build` 成功，0 TS 錯誤，新增 2 route + 2 頁面改動全部編譯。

- [ ] 7.2 跑本模組整合測試（有 stage env 時）：
  ```bash
  bun test tests/group-crud.test.ts 2>&1 | tail -25
  ```
  **預期**：全綠（create 7 例 + update 11 例）。若本機無 stage env → 全 skip；此時**必須**在 stage 部署後補跑（見 7.4）。

- [ ] 7.3 跑既有相關測試確認沒回歸（intake / group-stock 不該受影響，因為本模組未碰 intake API 與 stock 路徑）：
  ```bash
  bun test tests/intake-endpoint.test.ts tests/group-stock.test.ts 2>&1 | tail -20
  ```
  **預期**：全綠（或全 skip）。本模組未改 `intake.ts` 與 `src/lib/stock.ts`，預期零回歸。

- [ ] 7.4 （部署到 stage 後，於 Task 7 收尾或交由 ship 流程）stage QA：登入 stage 後台 `/admin/product-groups`，實機走一遍：新增群組 → 進貨 → 編輯/下架/上架 → 一條龍建品項。並跑 reconcile 確認庫存對帳未被本模組破壞：
  ```bash
  bun run scripts/reconcile-stock.ts --env stage 2>&1 | tail -15
  ```
  **預期**：reconcile exit 0、0 drift（本模組不動 `stock_fen`，新群組 `stock_fen=0` 必對帳）。

- [ ] 7.5 最終確認 commit 串乾淨（不在此 push，等使用者要求 ship）：
  ```bash
  git log --oneline -8
  git status
  ```
  **預期**：6 個 feature/test commit（Task 1、2、3、4、5、6）在 `feat/v6-p6-groups` 分支，working tree clean。

---

## 附錄 A：共用契約對照（本模組實際採用）

| 契約 | 本模組用法 |
|---|---|
| audit action | `group_create`（create.ts）、`group_update`（[id].ts），`details` 為 JSON blob（create：`{group_id,slug,name,display_order,available}`；update：`{group_id,changed[],before,after}`） |
| 授權 | 兩支 API 皆 `authorizeAdmin(request, env, "admin")`；`requireSameOrigin` 由 authorizeAdmin 對非 GET 自動執行 |
| 庫存 | **不碰** intake API / products/batch；create 把 `stock_fen` 固定 0；PATCH 對含 `stock_fen` 的請求回 400 `STOCK_FORBIDDEN` |
| 時間戳 | `new Date().toISOString()`（UTC `Z`） |
| 樂觀鎖 | PATCH 用 `expected{name,available,display_order}` gate-first 比對 → `STALE_STATE`（沿用 cancel.ts pattern） |
| 並發/batch | PATCH 用單一 `env.DB.batch([UPDATE(by PK), audit INSERT])`（PK UPDATE 不會 0-row 幻影，安全）；create 用 INSERT solo → 以 `(season_id, slug)` SELECT 回 id → audit solo（同 `seedGroup` 模式，不用 RETURNING；無 stock 對帳風險） |

## 附錄 B：錯誤碼一覽（本模組新增）

| API | error_code | HTTP | 觸發 |
|---|---|---|---|
| create | `STOCK_FORBIDDEN` | 400 | body 含 `stock_fen` |
| create | `NO_ACTIVE_SEASON` | 409 | 無 `status='active'` 季節 |
| create | `SLUG_TAKEN` | 409 | 同季 slug 已存在（app 層預檢；極少數同秒並發改由 unique index 兜底→500） |
| create | `CREATE_FAILED` | 500 | INSERT 後讀不回 id（理論上不可達；防 null 讀） |
| create | （`text` 純文字） | 400 | bad slug / bad name / bad display_order / bad json |
| PATCH | `STOCK_FORBIDDEN` | 400 | body 含 `stock_fen` |
| PATCH | `NO_FIELDS` | 400 | 無任何可編輯欄位 |
| PATCH | `STALE_STATE` | 409 | `expected` 與當前列不符 |
| PATCH | （`text` 純文字） | 400 | bad id / bad name / bad display_order / bad json |
| PATCH | （`text "group not found"`） | 404 | id 不存在 |
