# P5 — 季節管理（V6 §5.1）實作計畫

> 對應 spec：`docs/superpowers/specs/2026-06-06-v6-admin-selfservice-design.md` §5.1（含 §6 跨切面安全/並發/稽核、§7 測試計畫）。
> 模組範圍：年度季節（season）的「建立 / 啟用（原子切換）/ 封存（檢查未出貨訂單）」三支後台 mutation API + 一頁後台 UI + 導航/首頁入口。
>
> **此計畫面向「對本 codebase 零 context 的工程師」**：每個 Task 標出精確檔案路徑與行號、完整 code、精確指令與預期輸出。照順序做即可。

---

## 0. 前置知識（必讀，5 分鐘）

這些是寫 code 前你必須先知道的事實，全部已從 codebase 核對過：

1. **季節資料表 `seasons`**（`src/db/schema.ts:21-32`）欄位：
   - `id` INTEGER PK autoincrement
   - `code` TEXT NOT NULL UNIQUE（如 `"2026"`、`"2027"`）
   - `name` TEXT NOT NULL（如 `"2026 芒果季"`）
   - `status` TEXT NOT NULL DEFAULT `'draft'`，enum `["draft","active","archived"]`
   - `starts_at` TEXT（nullable，UTC ISO + Z）
   - `ended_at` TEXT（nullable，UTC ISO + Z；**目前全 codebase 無人讀寫**，封存時由本模組首次寫入）
   - `cloned_from_season_id` INTEGER（nullable，FK 自參考；本模組不碰）
   - `created_at` TEXT NOT NULL（UTC ISO + Z）
   - **沒有 `updated_at`、沒有 `shipping_config`**（`shipping_config` 由 P3 運費模組新增；本模組僅在 POST 建立時「若欄位已存在則一併寫入」，見 Task 6 的 open concern 處理）。

2. **partial unique index `seasons_active_singleton`**（`drizzle/0003_*.sql:29`）：
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS `seasons_active_singleton`
     ON `seasons` (`status`) WHERE `status` = 'active';
   ```
   保證「**同時最多一個 `status='active'`**」。啟用新季時，若先 INSERT/UPDATE 新季為 active 而舊季仍 active，會撞此唯一約束。**對策（本模組關鍵點）**：在**同一個 `env.DB.batch([...])`** 內，**先**把舊 active 降為 `archived`、**再**把新季升為 `active`。D1 batch 是 all-or-nothing，且 statement 在 batch 內依序執行，所以降檔語句先生效，升檔時已無第二個 active。

3. **授權契約**（§6）：所有 mutation 走 `authorizeAdmin(request, env, "admin")`（`src/lib/admin-api.ts:9`）。該函式內部對非 GET 請求**已呼叫** `requireSameOrigin(request)`（`src/lib/admin-api.ts:14`，CSRF 第二道防線），失敗回 `{ ok:false, status:403, reason:"csrf" }`。因此 endpoint 端**只需呼叫 `authorizeAdmin` 並在 `!auth.ok` 時 `return text(auth.reason, auth.status)`** 即可同時滿足「authorizeAdmin + requireSameOrigin」契約，**不需**在 endpoint 再額外 import/呼叫 `requireSameOrigin`。季節寫入需 admin role，故第三參數固定傳 `"admin"`。

4. **gate-first batch 模式**（範本 `src/pages/api/admin/orders/[id]/mark-paid.ts`、`cancel.ts`）：
   - 先做一個獨立 SELECT 驗 `expected_state`（client 對資料的認知），不符回 `409 STALE_STATE`。
   - 真正寫入用單一 `env.DB.batch([...])`（資料列 + audit 列一起），靠每列 `result[i].meta.changes` 判斷成敗。
   - **絕不**在 batch 中間 gate（mark-paid 曾因此產生 0-row UPDATE bug）。

5. **audit_log 寫法**（`src/db/schema.ts:177-197`）：欄位 `(ts, user_email, action, order_id, season_id, details)`。
   - `user_email` 不是 FK；`order_id` 是 FK（season 事件無 order，傳 `null`）。
   - `season_id` 可帶（讓季節事件帶上下文）。
   - `details` 是自由 JSON 字串。
   - **本模組新增 action（共用契約，務必照字面用）**：`season_create`、`season_activate`、`season_archive`。

6. **回應 helper**（`src/lib/admin-api.ts:44-54`）：`json(body, status=200)`、`text(body, status=200)`。沿用。

7. **頁面取 session**：page frontmatter 用 `Astro.locals.session`（由 `src/middleware.ts:46` 注入），型別 `{ email, role }`。非 admin 回 403（範本 `src/pages/admin/product-groups/index.astro:13-17`）。

8. **取 D1 env**：API/page 都 `import { env } from "../../../lib/env"`（路徑深度依檔案位置調整），`env.DB` 是 `D1Database`，`makeDb(env)` 取 Drizzle。

9. **測試基礎建設**（`tests/_setup.ts`）：
   - 整合測試 import `_setup.ts` → 需要 stage env（`MANGO_STAGE_URL` + `TEST_TOKEN`），缺則 `skipIfNoIntegration()` 回 `true`，每個 `it` 開頭 `if (SKIP) return;` 跳過。
   - `d1Execute(sql)`：直接對 stage D1 跑 SQL（回 results 陣列）。
   - `seedSeason({code, name?, status?})`：插一筆 season（code 須 `test-` 開頭），回 id。**注意**：若 `status:'active'` 但已有別的 active，partial index 會讓 `INSERT OR IGNORE` 靜默 no-op，`seedSeason` 偵測不到列會 throw。要先 archive 既有 active。
   - `seedActiveSeasonScenario({...})`：一鍵建 active season + group + SKUs；內部會先 `UPDATE seasons SET status='archived' WHERE status='active'`。
   - `seedGroup({season_id, slug, ...})`、`seedProductInSeason({...})`：slug/sku 須 `test-`/`TEST-` 前綴。
   - `createTestAdminSession(email?)`：插一筆 admin + session，回 `mh_session=<token>` cookie 字串（role=admin）。
   - `cleanupTestData()` / `cleanupTestAdmin()`：只刪 `test-`/`TEST-`/`@local` 前綴資料；**`cleanupTestData()` 結尾會 `UPDATE seasons SET status='active' WHERE code='2026'`** 還原 stage 真實 active 季。
   - 整合測試打 admin API 要帶 `Origin: STAGE_URL` + `Cookie`（範本 `tests/products-batch.test.ts:70-80`）。
   - 測試 SQL 字串內若含中文/特殊字元用單引號包；數值直接內插。

10. **未出貨訂單定義**（封存檢查用）：一筆訂單對某季「未出貨且仍有效」= `season_id = ? AND shipped = 0 AND cancelled_at IS NULL`。（已取消的軟刪訂單 `cancelled_at IS NOT NULL` 不算；已出貨 `shipped = 1` 不算。`paid` 與否不影響「是否還欠出貨」。）

---

## 1. 模組產出檔案總覽

**Create（production）**
- `src/pages/api/admin/seasons/create.ts` — `POST /api/admin/seasons`
- `src/pages/api/admin/seasons/[id]/activate.ts` — `PATCH /api/admin/seasons/[id]/activate`
- `src/pages/api/admin/seasons/[id]/archive.ts` — `PATCH /api/admin/seasons/[id]/archive`
- `src/pages/admin/seasons/index.astro` — 季節管理頁

**Create（test）**
- `tests/seasons-endpoints.test.ts` — 三支 API 的 stage 整合測試

**Modify（production）**
- `src/pages/admin/index.astro` — 首頁 admin 區塊加「年度設定」入口（約 `:99-114` 的 `session.role === "admin"` 區塊內）
- `src/layouts/Layout.astro` — admin header nav 加「年度」入口（約 `:53-66` 的 admin nav）

> **路由說明**：spec 寫 `POST /api/admin/seasons`。Astro 檔案路由中，`src/pages/api/admin/seasons/create.ts` 匯出 `POST` → 對應 URL `/api/admin/seasons/create`。為精確符合 spec 的 `POST /api/admin/seasons`（無 `/create` 後綴），本計畫採 **`src/pages/api/admin/seasons/index.ts` 匯出 `POST`** 來命中 `/api/admin/seasons`。（已核對：`src/pages/api/admin/orders.ts` 即以 `orders.ts` 命中 `/api/admin/orders`；同理 `seasons/index.ts` 命中 `/api/admin/seasons`。）→ **最終 Create 路徑修正為 `src/pages/api/admin/seasons/index.ts`**，下方 Task 一律以此為準。

---

## Task 1 — 季節 API：失敗測試骨架（TDD red）

先寫整合測試檔，涵蓋「建立 / 啟用原子切換 / 封存阻擋」三大行為。此時 endpoint 尚未存在，測試應因 404 / 連線失敗而 FAIL。

**Files**
- Create(Test): `tests/seasons-endpoints.test.ts`

**Steps**
- [ ] 建立測試檔，完整內容如下（先寫「建立」相關案例，啟用/封存案例在 Task 3、5 補；本 Task 先讓檔案能跑且紅）：

```ts
// tests/seasons-endpoints.test.ts
//
// V6 §5.1 季節管理 API 整合測試（stage worker over HTTP）。
//
// 覆蓋：
//   POST /api/admin/seasons            — 建立（draft），audit season_create
//   PATCH /api/admin/seasons/:id/activate — 原子切換（舊 active 降 archived、新季升 active）
//   PATCH /api/admin/seasons/:id/archive  — 封存；有未出貨訂單時阻擋
//
// 全部需要 stage env（MANGO_STAGE_URL + TEST_TOKEN）；缺則整檔 skip。

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedActiveSeasonScenario,
  seedSeason,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();

const SEASON_NEW = "test-se-new"; // POST target code
const SEASON_OLD_ACTIVE = "test-se-oldactive";
const SEASON_TO_ACTIVATE = "test-se-toactivate";
const SEASON_ARCH = "test-se-arch";

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

// --- HTTP helpers ---------------------------------------------------------

async function postSeason(
  cookie: string,
  body: Record<string, unknown>,
  opts: { origin?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== false) headers.Origin = STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/seasons`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function patchSeason(
  cookie: string,
  id: number,
  action: "activate" | "archive",
  body: Record<string, unknown> = {},
  opts: { origin?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== false) headers.Origin = STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/seasons/${id}/${action}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

function seasonRow(code: string): { id: number; status: string } | null {
  const rows = d1Execute(
    `SELECT id, status FROM seasons WHERE code = '${code}'`,
  ) as Array<{ id: number; status: string }>;
  return rows[0] ?? null;
}

// --- POST /api/admin/seasons ---------------------------------------------

describe("POST /api/admin/seasons", () => {
  it("creates a draft season + audit season_create", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();

    const res = await postSeason(cookie, {
      code: SEASON_NEW,
      name: "test 新年度",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(body.id).toBeGreaterThan(0);

    const row = seasonRow(SEASON_NEW);
    expect(row?.status).toBe("draft");

    const audit = d1Execute(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'season_create' AND season_id = ${body.id}`,
    ) as Array<{ n: number }>;
    expect(audit[0]!.n).toBe(1);
  });

  it("rejects duplicate code (409)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    seedSeason({ code: SEASON_NEW, status: "draft" });

    const res = await postSeason(cookie, { code: SEASON_NEW, name: "dup" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("CODE_EXISTS");
  });

  it("rejects bad code (400)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const res = await postSeason(cookie, { code: "白白白", name: "x" });
    expect(res.status).toBe(400);
  });

  it("CSRF: missing Origin rejected (403)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const res = await postSeason(
      cookie,
      { code: SEASON_NEW, name: "x" },
      { origin: false },
    );
    expect(res.status).toBe(403);
  });

  it("no session rejected (401)", async () => {
    if (SKIP) return;
    const res = await postSeason("mh_session=bogus", {
      code: SEASON_NEW,
      name: "x",
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] 跑測試，確認 POST 案例 FAIL（endpoint 不存在 → 404，斷言 `toBe(200)` 失敗）：
  ```bash
  bun test tests/seasons-endpoints.test.ts
  ```
  **預期輸出（節錄）**：若 stage env 已設，"creates a draft season..." 應 fail，訊息類似 `expect(received).toBe(expected)  Expected: 200  Received: 404`。若 stage env 未設，全部 skip（印出 `⚠️  V5.2 tests need MANGO_STAGE_URL...`，0 fail）— 這種情況下，TDD 的「紅」改於 Task 8 的本機 `bun run build` type-check 與部署到 stage 後驗證（見 Task 8）。

> 注意：本檔測試需要實際 stage worker 已部署新 endpoint 才會由紅轉綠（它們打 HTTP）。因此「red→green」的真實切換點是 Task 8（部署 stage 後重跑）。在無 stage 的開發機，以 `bun run build`（type-check）作為每個實作 Task 的本機驗證關卡。

---

## Task 2 — 實作 `POST /api/admin/seasons`（建立 draft）

**Files**
- Create: `src/pages/api/admin/seasons/index.ts`

**Steps**
- [ ] 建立 `src/pages/api/admin/seasons/index.ts`，完整內容：

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { seasons } from "../../../../db/schema";
import { env } from "../../../../lib/env";

// V6 §5.1: create a new season in `draft` status.
// Required: code (matches /^[A-Za-z0-9_-]{1,20}$/, globally unique).
// Required: name (1-50 chars).
// Optional: starts_at (UTC ISO string, stored as-is).
//
// Does NOT activate. Activation is a separate atomic transition (activate.ts).
// audit: season_create.
export const POST: APIRoute = async ({ request }) => {
  // authorizeAdmin runs requireSameOrigin internally for non-GET (CSRF 2nd line).
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: {
    code?: string;
    name?: string;
    starts_at?: string;
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  const code = (body.code ?? "").trim();
  const name = (body.name ?? "").trim();
  const startsAt =
    typeof body.starts_at === "string" && body.starts_at.trim().length > 0
      ? body.starts_at.trim()
      : null;

  if (!code || !/^[A-Za-z0-9_-]{1,20}$/.test(code)) {
    return text("bad code (1-20 chars, [A-Za-z0-9_-])", 400);
  }
  if (!name || name.length > 50) return text("bad name (1-50 chars)", 400);
  if (startsAt !== null && (startsAt.length > 40 || Number.isNaN(Date.parse(startsAt)))) {
    return text("bad starts_at (UTC ISO-8601)", 400);
  }

  const db = makeDb(env);

  // Pre-check duplicate code → clean 409 (UNIQUE index would also catch it, but
  // we want a typed error_code, not a raw constraint exception).
  const dup = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.code, code))
    .limit(1);
  if (dup.length > 0) {
    return json({ ok: false, error_code: "CODE_EXISTS", code }, 409);
  }

  const now = new Date().toISOString();

  const result = await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO seasons (code, name, status, starts_at, created_at) VALUES (?, ?, 'draft', ?, ?)",
      )
      .bind(code, name, startsAt, now),
    env.DB
      .prepare(
        // season_id is backfilled below via a correlated subquery so the audit
        // row carries the new season's id without a round-trip.
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) " +
          "VALUES (?, ?, 'season_create', (SELECT id FROM seasons WHERE code = ?), ?)",
      )
      .bind(
        now,
        auth.session.email,
        code,
        JSON.stringify({ code, name, starts_at: startsAt }),
      ),
  ]);

  const inserted = result[0]?.meta?.changes ?? 0;
  if (inserted === 0) {
    // Extremely unlikely (we pre-checked dup) — concurrent insert raced us.
    return json({ ok: false, error_code: "CODE_EXISTS", code }, 409);
  }

  // Resolve the new id for the response.
  const row = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.code, code))
    .limit(1);

  return json({ ok: true, id: row[0]?.id ?? null, code, status: "draft" });
};
```

- [ ] 本機 type-check + build 驗證：
  ```bash
  bun run build
  ```
  **預期輸出**：`astro check` 0 errors、build 成功（`Complete!` / 無紅字）。若報「Cannot find module」檢查相對路徑深度：本檔在 `src/pages/api/admin/seasons/index.ts`，到 `src/lib` 是 `../../../../lib`，到 `src/db` 是 `../../../../db`（四層 `..`：seasons→admin→api→pages→src）。

- [ ] commit：
  ```bash
  git add src/pages/api/admin/seasons/index.ts tests/seasons-endpoints.test.ts
  git commit -m "feat(seasons): POST /api/admin/seasons creates draft + audit season_create

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3 — 啟用原子切換：失敗測試（TDD red）

在 `tests/seasons-endpoints.test.ts` 末端追加 `describe("PATCH .../activate")`，覆蓋「原子切換」核心不變式：舊 active 降 archived、新季升 active、partial unique 不衝突。

**Files**
- Modify(Test): `tests/seasons-endpoints.test.ts`（在最後一個 `describe` 之後追加）

**Steps**
- [ ] 在檔案末端（最後一個 `});` 之後）追加以下 block：

```ts
// --- PATCH /api/admin/seasons/:id/activate --------------------------------

describe("PATCH /api/admin/seasons/:id/activate", () => {
  it("atomically demotes old active → archived and promotes target → active", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();

    // Arrange: one active season + one draft target. seedActiveSeasonScenario
    // archives stage's real 2026 first, then makes SEASON_OLD_ACTIVE active.
    seedActiveSeasonScenario({
      season_code: SEASON_OLD_ACTIVE,
      group_slug: "test-se-grp",
      initial_stock_fen: 0,
      skus: [],
    });
    const targetId = seedSeason({ code: SEASON_TO_ACTIVATE, status: "draft" });

    const res = await patchSeason(cookie, targetId, "activate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Old active is now archived; target is now active; still exactly one active.
    expect(seasonRow(SEASON_OLD_ACTIVE)?.status).toBe("archived");
    expect(seasonRow(SEASON_TO_ACTIVATE)?.status).toBe("active");

    const activeCount = d1Execute(
      `SELECT count(*) AS n FROM seasons WHERE status = 'active'`,
    ) as Array<{ n: number }>;
    expect(activeCount[0]!.n).toBe(1);

    // audit season_activate written for the target.
    const audit = d1Execute(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'season_activate' AND season_id = ${targetId}`,
    ) as Array<{ n: number }>;
    expect(audit[0]!.n).toBe(1);
  });

  it("activating an already-active season is idempotent (ok)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const { season_id } = seedActiveSeasonScenario({
      season_code: SEASON_OLD_ACTIVE,
      group_slug: "test-se-grp",
      initial_stock_fen: 0,
      skus: [],
    });

    const res = await patchSeason(cookie, season_id, "activate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; already_active?: boolean };
    expect(body.ok).toBe(true);
    expect(body.already_active).toBe(true);
    expect(seasonRow(SEASON_OLD_ACTIVE)?.status).toBe("active");
  });

  it("activating an archived season works (archived → active, no old active exists)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    // No active season at all: archive stage's 2026 so the slot is free.
    d1Execute(`UPDATE seasons SET status = 'archived' WHERE status = 'active'`);
    const id = seedSeason({ code: SEASON_TO_ACTIVATE, status: "archived" });

    const res = await patchSeason(cookie, id, "activate");
    expect(res.status).toBe(200);
    expect(seasonRow(SEASON_TO_ACTIVATE)?.status).toBe("active");
  });

  it("404 for unknown season id", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const res = await patchSeason(cookie, 999999999, "activate");
    expect(res.status).toBe(404);
  });

  it("CSRF: missing Origin rejected (403)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const id = seedSeason({ code: SEASON_TO_ACTIVATE, status: "draft" });
    const res = await patchSeason(cookie, id, "activate", {}, { origin: false });
    expect(res.status).toBe(403);
  });
});
```

- [ ] 本機 type-check（測試檔語法）：
  ```bash
  bun run build
  ```
  **預期輸出**：build 通過（測試檔不參與 astro build，但 `bun` 會在 Task 8 編譯；此處主要確保未破壞 production code）。實際 red 驗證在 Task 8。

- [ ] commit（測試先行）：
  ```bash
  git add tests/seasons-endpoints.test.ts
  git commit -m "test(seasons): activate atomic-switch + idempotent + 404 + csrf cases

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4 — 實作 `PATCH /api/admin/seasons/[id]/activate`（原子切換）

**Files**
- Create: `src/pages/api/admin/seasons/[id]/activate.ts`

**Steps**
- [ ] 建立 `src/pages/api/admin/seasons/[id]/activate.ts`，完整內容：

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { makeDb } from "../../../../../db/client";
import { seasons } from "../../../../../db/schema";
import { env } from "../../../../../lib/env";

// V6 §5.1: atomically make a season the single active one.
//
// CRITICAL — partial unique index `seasons_active_singleton` (drizzle/0003:29)
// forbids two rows with status='active'. We therefore run, in ONE D1 batch:
//   1. UPDATE seasons SET status='archived' WHERE status='active' AND id != target
//   2. UPDATE seasons SET status='active'   WHERE id = target AND status != 'active'
//   3. INSERT audit_log season_activate
// Statement 1 demotes the previous active FIRST, so statement 2 never collides.
// D1 batch is all-or-nothing → no window with two actives, no torn state.
//
// Idempotent: activating an already-active season returns ok+already_active
// without touching anything (stmt 2's `status != 'active'` guard makes it a no-op,
// and we short-circuit before writing audit).
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return text("bad id", 400);

  const db = makeDb(env);

  // Gate-first: read the target so we can 404 / detect already-active before writing.
  const rows = await db
    .select({ id: seasons.id, code: seasons.code, status: seasons.status })
    .from(seasons)
    .where(eq(seasons.id, id))
    .limit(1);
  const target = rows[0];
  if (!target) return text("not_found", 404);

  if (target.status === "active") {
    return json({ ok: true, already_active: true, id, code: target.code });
  }

  const now = new Date().toISOString();

  // Atomic switch in one batch. Order matters: demote the old active BEFORE
  // promoting the target, so the partial unique index never sees two actives.
  const result = await env.DB.batch([
    env.DB
      .prepare(
        "UPDATE seasons SET status = 'archived', ended_at = ? WHERE status = 'active' AND id != ?",
      )
      .bind(now, id),
    env.DB
      .prepare(
        "UPDATE seasons SET status = 'active' WHERE id = ? AND status != 'active'",
      )
      .bind(id),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'season_activate', ?, ?)",
      )
      .bind(
        now,
        auth.session.email,
        id,
        JSON.stringify({ activated_id: id, code: target.code, from_status: target.status }),
      ),
  ]);

  const promoted = result[1]?.meta?.changes ?? 0;
  if (promoted === 0) {
    // The target wasn't promoted — most likely a concurrent request already
    // activated it between our SELECT and batch. Treat as success/idempotent.
    return json({ ok: true, already_active: true, id, code: target.code });
  }

  const demoted = result[0]?.meta?.changes ?? 0;
  return json({ ok: true, id, code: target.code, demoted_previous: demoted });
};
```

- [ ] 本機 build：
  ```bash
  bun run build
  ```
  **預期輸出**：0 errors。相對路徑檢查：本檔在 `src/pages/api/admin/seasons/[id]/activate.ts`，五層到 `src`（`[id]`→seasons→admin→api→pages），故 `../../../../../lib`、`../../../../../db`。

- [ ] commit：
  ```bash
  git add src/pages/api/admin/seasons/[id]/activate.ts
  git commit -m "feat(seasons): PATCH activate — atomic demote-old + promote-new in one batch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5 — 封存（檢查未出貨訂單）：失敗測試（TDD red）

在 `tests/seasons-endpoints.test.ts` 末端追加 `describe("PATCH .../archive")`，覆蓋「有未出貨訂單時阻擋」「無未出貨訂單時成功」。

> **建單方式**：本測試需要一筆「屬於某季、未出貨、未取消」的訂單。直接用 `d1Execute` INSERT 一筆最小 `orders` 列（避開走 `/api/orders` 的庫存/運費複雜度）。訂單 `name` 用 `test-` 前綴、`idempotency_key` 用 `test-` 前綴，才會被 `cleanupTestData()` 清掉（`_setup.ts:286`）。`order_id` 用 `M-YYYYMMDD-NNN` 格式但用一個不可能與真實衝突的日期（如 `M-29991231-001`）。

**Files**
- Modify(Test): `tests/seasons-endpoints.test.ts`

**Steps**
- [ ] 在檔案末端追加 helper + describe：

```ts
// --- PATCH /api/admin/seasons/:id/archive ---------------------------------

// Insert a minimal order tied to a season. Uses test- prefixes so cleanupTestData
// removes it. Far-future order_id avoids any collision with real M-YYYYMMDD-NNN.
function seedOrder(opts: {
  order_id: string;
  season_id: number;
  shipped: 0 | 1;
  cancelled: boolean;
}): void {
  const now = new Date().toISOString();
  const cancelledAt = opts.cancelled ? `'${now}'` : "NULL";
  d1Execute(
    `INSERT INTO orders
       (order_id, season_id, created_at, name, phone, address, subtotal, shipping, total,
        expected_memo, pdpa_accepted, paid, shipped, idempotency_key, cancelled_at)
     VALUES
       ('${opts.order_id}', ${opts.season_id}, '${now}', 'test-buyer', '0900000000',
        'test addr', 100, 0, 100, '0000', 1, 0, ${opts.shipped},
        'test-${opts.order_id}', ${cancelledAt})`,
  );
}

describe("PATCH /api/admin/seasons/:id/archive", () => {
  it("blocks archive when season has unshipped active orders (409)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const { season_id } = seedActiveSeasonScenario({
      season_code: SEASON_ARCH,
      group_slug: "test-se-grp",
      initial_stock_fen: 0,
      skus: [],
    });
    seedOrder({
      order_id: "M-29991231-001",
      season_id,
      shipped: 0,
      cancelled: false,
    });

    const res = await patchSeason(cookie, season_id, "archive");
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_code: string;
      unshipped_count: number;
    };
    expect(body.error_code).toBe("UNSHIPPED_ORDERS");
    expect(body.unshipped_count).toBeGreaterThanOrEqual(1);

    // Season is NOT archived.
    expect(seasonRow(SEASON_ARCH)?.status).toBe("active");
  });

  it("archives when all orders shipped or cancelled (200)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const { season_id } = seedActiveSeasonScenario({
      season_code: SEASON_ARCH,
      group_slug: "test-se-grp",
      initial_stock_fen: 0,
      skus: [],
    });
    // One shipped, one cancelled — neither blocks archive.
    seedOrder({ order_id: "M-29991231-002", season_id, shipped: 1, cancelled: false });
    seedOrder({ order_id: "M-29991231-003", season_id, shipped: 0, cancelled: true });

    const res = await patchSeason(cookie, season_id, "archive");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(seasonRow(SEASON_ARCH)?.status).toBe("archived");

    const audit = d1Execute(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'season_archive' AND season_id = ${season_id}`,
    ) as Array<{ n: number }>;
    expect(audit[0]!.n).toBe(1);
  });

  it("force=true archives despite unshipped orders (200)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const { season_id } = seedActiveSeasonScenario({
      season_code: SEASON_ARCH,
      group_slug: "test-se-grp",
      initial_stock_fen: 0,
      skus: [],
    });
    seedOrder({ order_id: "M-29991231-004", season_id, shipped: 0, cancelled: false });

    const res = await patchSeason(cookie, season_id, "archive", { force: true });
    expect(res.status).toBe(200);
    expect(seasonRow(SEASON_ARCH)?.status).toBe("archived");
  });

  it("404 for unknown season id", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const res = await patchSeason(cookie, 999999999, "archive");
    expect(res.status).toBe(404);
  });

  it("CSRF: missing Origin rejected (403)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const id = seedSeason({ code: SEASON_ARCH, status: "draft" });
    const res = await patchSeason(cookie, id, "archive", {}, { origin: false });
    expect(res.status).toBe(403);
  });
});
```

- [ ] 本機 build：
  ```bash
  bun run build
  ```
  **預期輸出**：0 errors（未動 production）。

- [ ] commit：
  ```bash
  git add tests/seasons-endpoints.test.ts
  git commit -m "test(seasons): archive blocks on unshipped orders, allows when clear, force flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6 — 實作 `PATCH /api/admin/seasons/[id]/archive`（封存前檢查未出貨訂單）

**Files**
- Create: `src/pages/api/admin/seasons/[id]/archive.ts`

**Steps**
- [ ] 建立 `src/pages/api/admin/seasons/[id]/archive.ts`，完整內容：

```ts
import type { APIRoute } from "astro";
import { and, eq, isNull, sql } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { makeDb } from "../../../../../db/client";
import { seasons, orders } from "../../../../../db/schema";
import { env } from "../../../../../lib/env";

// V6 §5.1: archive a season (active|draft → archived).
//
// Safety gate: refuse to archive while the season still has UNSHIPPED, NON-CANCELLED
// orders (shipped = 0 AND cancelled_at IS NULL) — archiving would orphan work the shop
// still owes the customer. Caller can override with { force: true } once they've
// confirmed (the UI surfaces the count + a confirm dialog).
//
// audit: season_archive (details record the unshipped_count seen + whether forced).
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return text("bad id", 400);

  let body: { force?: boolean } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return text("bad json", 400);
  }
  const force = body.force === true;

  const db = makeDb(env);

  const rows = await db
    .select({ id: seasons.id, code: seasons.code, status: seasons.status })
    .from(seasons)
    .where(eq(seasons.id, id))
    .limit(1);
  const target = rows[0];
  if (!target) return text("not_found", 404);

  if (target.status === "archived") {
    return json({ ok: true, already_archived: true, id, code: target.code });
  }

  // Count unshipped, non-cancelled orders tied to this season.
  const countRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.season_id, id),
        eq(orders.shipped, false),
        isNull(orders.cancelled_at),
      ),
    );
  const unshippedCount = countRows[0]?.n ?? 0;

  if (unshippedCount > 0 && !force) {
    return json(
      {
        ok: false,
        error_code: "UNSHIPPED_ORDERS",
        unshipped_count: unshippedCount,
        message: "此季仍有未出貨訂單；確認後可加 force 強制封存",
      },
      409,
    );
  }

  const now = new Date().toISOString();

  const result = await env.DB.batch([
    env.DB
      .prepare(
        "UPDATE seasons SET status = 'archived', ended_at = ? WHERE id = ? AND status != 'archived'",
      )
      .bind(now, id),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'season_archive', ?, ?)",
      )
      .bind(
        now,
        auth.session.email,
        id,
        JSON.stringify({
          archived_id: id,
          code: target.code,
          from_status: target.status,
          unshipped_count: unshippedCount,
          forced: force,
        }),
      ),
  ]);

  const archived = result[0]?.meta?.changes ?? 0;
  if (archived === 0) {
    // Raced — someone archived it between our SELECT and batch.
    return json({ ok: true, already_archived: true, id, code: target.code });
  }

  return json({ ok: true, id, code: target.code, unshipped_count: unshippedCount, forced: force });
};
```

- [ ] 本機 build：
  ```bash
  bun run build
  ```
  **預期輸出**：0 errors。

- [ ] commit：
  ```bash
  git add src/pages/api/admin/seasons/[id]/archive.ts
  git commit -m "feat(seasons): PATCH archive — gate on unshipped orders, force override, audit season_archive

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7 — 季節管理頁 `src/pages/admin/seasons/index.astro`

列出歷年季節（標當季），提供「建立新年度 / 啟用 / 封存」操作。沿用 product-groups 頁的 toast + fetch + `location.reload()` 模式。

**Files**
- Create: `src/pages/admin/seasons/index.astro`

**Steps**
- [ ] 建立 `src/pages/admin/seasons/index.astro`，完整內容：

```astro
---
import Layout from "../../../layouts/Layout.astro";
import { makeDb } from "../../../db/client";
import { seasons, orders } from "../../../db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { env } from "../../../lib/env";

const session = Astro.locals.session;
if (!session) return Astro.redirect("/admin/login");
if (session.role !== "admin") {
  return new Response("admin only", { status: 403 });
}

const db = makeDb(env);

const seasonRows = await db
  .select()
  .from(seasons)
  .orderBy(desc(seasons.created_at));

// For each season, count unshipped non-cancelled orders so the UI can warn before
// archive. One grouped query keyed by season_id.
const unshippedRows = await db
  .select({
    season_id: orders.season_id,
    n: sql<number>`count(*)`,
  })
  .from(orders)
  .where(and(eq(orders.shipped, false), isNull(orders.cancelled_at)))
  .groupBy(orders.season_id);

const unshippedBySeason = new Map<number, number>();
for (const r of unshippedRows) unshippedBySeason.set(r.season_id, r.n);

const statusLabel: Record<string, string> = {
  draft: "草稿",
  active: "當季",
  archived: "已封存",
};
const statusClass: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  active: "bg-emerald-100 text-emerald-800",
  archived: "bg-gray-100 text-gray-500",
};
---

<Layout title="年度設定">
  <main class="mx-auto max-w-3xl px-4 py-6 pb-12">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold">年度設定</h1>
      <a href="/admin" class="text-sm text-gray-600 underline">← 後台首頁</a>
    </header>

    <p class="mb-6 text-sm text-gray-600">
      每一年的芒果季是一個「年度」。同時只能有一個「當季」。
      建立新年度 → 設定商品與庫存 → 開賣時「啟用」（會自動把上一個當季封存）→ 季末「封存」。
    </p>

    <!-- 建立新年度 -->
    <section class="mb-8 rounded border border-gray-200 bg-white p-4">
      <h2 class="mb-3 text-lg font-bold">建立新年度</h2>
      <form id="create-season-form" class="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr_5rem]">
        <input
          type="text"
          name="code"
          required
          maxlength="20"
          pattern="[A-Za-z0-9_\-]+"
          aria-label="年度代碼（英數，例 2027）"
          class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500"
          placeholder="代碼：例 2027"
        />
        <input
          type="text"
          name="name"
          required
          maxlength="50"
          aria-label="年度名稱（例 2027 芒果季）"
          class="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus-visible:outline-2 focus-visible:outline-mango-500"
          placeholder="名稱：例 2027 芒果季"
        />
        <button
          type="submit"
          class="inline-flex items-center justify-center rounded bg-mango-600 px-3 py-2 min-h-[44px] text-sm text-white hover:bg-mango-700 disabled:bg-mango-300 disabled:cursor-not-allowed"
        >
          建立
        </button>
        <div class="create-error hidden sm:col-span-3 rounded bg-red-50 px-3 py-2 text-xs text-red-800"></div>
      </form>
      <p class="mt-2 text-xs text-gray-500">
        新年度建立後為「草稿」，不影響目前販售。設定好商品/庫存再按「啟用」。
      </p>
    </section>

    <!-- 歷年列表 -->
    <section class="space-y-3">
      <h2 class="text-lg font-bold">歷年</h2>
      {seasonRows.length === 0 && (
        <p class="rounded border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          尚無任何年度。請先用上方表單建立第一個年度。
        </p>
      )}
      {seasonRows.map((s) => {
        const unshipped = unshippedBySeason.get(s.id) ?? 0;
        return (
          <article
            class="rounded border border-gray-200 bg-white p-4"
            data-season-card
            data-season-id={s.id}
            data-season-code={s.code}
            data-season-status={s.status}
            data-unshipped={unshipped}
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span class="text-lg font-bold">{s.name}</span>
                <span class="ml-2 font-mono text-xs text-gray-500">{s.code}</span>
                <span class={`ml-2 inline-block rounded px-2 py-0.5 text-xs ${statusClass[s.status] ?? ""}`}>
                  {statusLabel[s.status] ?? s.status}
                </span>
              </div>
              <div class="flex gap-2">
                {s.status !== "active" && (
                  <button
                    type="button"
                    data-action="activate"
                    class="inline-flex items-center min-h-[44px] rounded border border-emerald-600 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50"
                  >
                    啟用為當季
                  </button>
                )}
                {s.status !== "archived" && (
                  <button
                    type="button"
                    data-action="archive"
                    class="inline-flex items-center min-h-[44px] rounded border border-gray-400 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    封存
                  </button>
                )}
              </div>
            </div>
            {unshipped > 0 && (
              <p class="mt-2 text-xs text-amber-700">
                ⚠️ 此年度尚有 {unshipped} 筆未出貨訂單，封存前請先處理（或確認後強制封存）。
              </p>
            )}
          </article>
        );
      })}
    </section>
  </main>

  <script>
    import { showToast, flashToast, consumeFlash } from "../../../lib/toast";

    interface ApiOk {
      ok: true;
      [k: string]: unknown;
    }
    interface ApiFail {
      ok: false;
      error_code: string;
      message?: string;
      unshipped_count?: number;
    }

    async function callJson(
      url: string,
      method: "POST" | "PATCH",
      body: Record<string, unknown>,
    ): Promise<{ status: number; data: ApiOk | ApiFail | null; raw: string }> {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return { status: res.status, data: null, raw: await res.text() };
      }
      return { status: res.status, data: (await res.json()) as ApiOk | ApiFail, raw: "" };
    }

    // --- 建立新年度 ---
    const createForm = document.getElementById("create-season-form") as HTMLFormElement | null;
    if (createForm) {
      const errEl = createForm.querySelector<HTMLElement>(".create-error")!;
      const submitBtn = createForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      createForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        errEl.classList.add("hidden");
        const fd = new FormData(createForm);
        const code = String(fd.get("code") ?? "").trim();
        const name = String(fd.get("name") ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) {
          errEl.textContent = "代碼需為 1-20 字英數（例 2027）。";
          errEl.classList.remove("hidden");
          return;
        }
        if (name.length === 0 || name.length > 50) {
          errEl.textContent = "名稱需 1-50 字。";
          errEl.classList.remove("hidden");
          return;
        }
        submitBtn.disabled = true;
        const orig = submitBtn.textContent;
        submitBtn.textContent = "建立中...";
        try {
          const { status, data, raw } = await callJson("/api/admin/seasons", "POST", {
            code,
            name,
          });
          if (status === 200 && data && data.ok) {
            flashToast(`已建立年度「${name}」（草稿）`, { kind: "success" });
            location.reload();
            return;
          }
          const fail = data as ApiFail | null;
          if (fail?.error_code === "CODE_EXISTS") {
            errEl.textContent = `代碼「${code}」已存在，請換一個。`;
          } else {
            errEl.textContent = `建立失敗：${fail?.message ?? fail?.error_code ?? raw ?? status}`;
          }
          errEl.classList.remove("hidden");
        } catch {
          errEl.textContent = "網路錯誤，請稍後再試。";
          errEl.classList.remove("hidden");
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = orig;
        }
      });
    }

    // --- 啟用 / 封存 ---
    document.querySelectorAll<HTMLElement>("[data-season-card]").forEach((card) => {
      const id = Number(card.dataset.seasonId);
      const code = card.dataset.seasonCode ?? "";
      const unshipped = Number(card.dataset.unshipped ?? "0");

      card.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const action = btn.dataset.action as "activate" | "archive";

          if (action === "activate") {
            if (!confirm(`確定把「${code}」設為當季嗎？目前的當季會自動封存。`)) return;
          }

          let force = false;
          if (action === "archive") {
            if (unshipped > 0) {
              if (
                !confirm(
                  `「${code}」還有 ${unshipped} 筆未出貨訂單。仍要強制封存嗎？（建議先出完貨）`,
                )
              ) {
                return;
              }
              force = true;
            } else if (!confirm(`確定封存「${code}」嗎？`)) {
              return;
            }
          }

          btn.disabled = true;
          const orig = btn.textContent;
          btn.textContent = "處理中...";
          try {
            const url = `/api/admin/seasons/${id}/${action}`;
            const { status, data, raw } = await callJson(url, "PATCH", force ? { force: true } : {});
            if (status === 200 && data && data.ok) {
              flashToast(
                action === "activate" ? `已啟用「${code}」為當季` : `已封存「${code}」`,
                { kind: "success" },
              );
              location.reload();
              return;
            }
            const fail = data as ApiFail | null;
            if (fail?.error_code === "UNSHIPPED_ORDERS") {
              showToast(
                `此年度尚有 ${fail.unshipped_count ?? "?"} 筆未出貨訂單，無法封存。`,
                { kind: "error" },
              );
            } else {
              showToast(`操作失敗：${fail?.message ?? fail?.error_code ?? raw ?? status}`, {
                kind: "error",
              });
            }
            btn.disabled = false;
            btn.textContent = orig;
          } catch {
            showToast("網路錯誤，請稍後再試。", { kind: "error" });
            btn.disabled = false;
            btn.textContent = orig;
          }
        });
      });
    });

    consumeFlash();
  </script>
</Layout>
```

- [ ] **驗證 toast helper 的 import 路徑與 API**。product-groups 頁用 `import { showToast, flashToast, consumeFlash } from "../../../lib/toast";`（`src/pages/admin/product-groups/index.astro:237`），本頁同層 `src/pages/admin/seasons/index.astro` → 路徑相同 `../../../lib/toast`。先確認這三個 export 存在：
  ```bash
  grep -n "export function showToast\|export function flashToast\|export function consumeFlash" src/lib/toast.ts
  ```
  **預期輸出**：三行皆命中。**若 `flashToast`/`consumeFlash`/`showToast` 任一不存在或簽名不同**（例如沒有 `{ kind }` 選項），改用 product-groups 頁實際用到的同款呼叫即可（該頁已證實可編譯）。此為 open concern，見文末。

- [ ] 本機 build：
  ```bash
  bun run build
  ```
  **預期輸出**：0 errors、build 成功。

- [ ] commit：
  ```bash
  git add src/pages/admin/seasons/index.astro
  git commit -m "feat(seasons): admin 年度設定 page — list/create/activate/archive

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 8 — 導航與首頁入口

在後台首頁 admin 區塊與全域 header nav 加「年度」入口。

**Files**
- Modify: `src/pages/admin/index.astro:99-114`（admin-only 入口區塊）
- Modify: `src/layouts/Layout.astro:53-66`（admin header nav）

**Steps**
- [ ] **首頁入口**：在 `src/pages/admin/index.astro` 的 `session.role === "admin"` 的 `<>...</>` fragment 內，於「商品管理」連結**之前**插入「年度設定」連結。找到這段（`:99-113`）：

```astro
      {session.role === "admin" && (
        <>
          <a
            href="/admin/products"
            class="rounded border border-gray-300 px-4 py-2 hover:bg-gray-50"
          >
            商品管理
          </a>
```

  將其改為（在 `/admin/products` 連結前插入年度設定）：

```astro
      {session.role === "admin" && (
        <>
          <a
            href="/admin/seasons"
            class="rounded border border-gray-300 px-4 py-2 hover:bg-gray-50"
          >
            年度設定
          </a>
          <a
            href="/admin/products"
            class="rounded border border-gray-300 px-4 py-2 hover:bg-gray-50"
          >
            商品管理
          </a>
```

- [ ] **header nav 入口**：在 `src/layouts/Layout.astro` 的 admin nav（`:52-67`）內，於「商品」連結**之前**插入「年度」。找到這行（`:54`）：

```astro
            <a href="/admin/products" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">商品</a>
```

  在它上面插入一行：

```astro
            <a href="/admin/seasons" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">年度</a>
```

  使其變成：

```astro
            <a href="/admin/orders" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">訂單</a>
            <a href="/admin/seasons" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">年度</a>
            <a href="/admin/products" class="inline-flex items-center min-h-[44px] px-2 sm:px-3 py-2 rounded hover:bg-mango-100 hover:text-mango-700">商品</a>
```

> 注意：header nav 對 admin/operator 都顯示（Layout 不分 role）。「年度設定」頁本身對非 admin 回 403，operator 點進去會看到 403 — 與既有「商品/庫存」連結行為一致（那兩頁也是 admin-only 卻顯示在 nav），故沿用此既有慣例，不在 nav 端做 role 分流。

> ⚠️ **跨模組協調（總編加註）**：`src/layouts/Layout.astro` 的 admin nav **同時被 P8（後台 UX）Task 4 改動**——P8 會把這整段 5 連結 nav **整段重寫**成由 `src/lib/admin-nav.ts` 驅動（含 active 標示 + 手機 drawer），且該 data-driven nav **已內含「年度設定 → /admin/seasons」項目**。因此合併順序固定為 **P5 先、P8 後**：若 P8 已落地，本步對 Layout.astro 的 nav Edit 之 `old_string` 將比對不到（已被 P8 重寫），屬**預期**——此時 P8 的 nav 已涵蓋「年度」入口，本步**只需保留 `src/pages/admin/index.astro` 首頁入口的改動，跳過 Layout.astro 那筆 Edit**（首頁入口 P8 Task 5 不重寫，兩者相容）。反之若本模組先落地，P8 Task 4 會以其完整 `old_string` 取代本步加的 `年度` 連結，亦為預期。詳見 master 計畫「跨模組檔案爭用」表。

- [ ] 本機 build：
  ```bash
  bun run build
  ```
  **預期輸出**：0 errors。

- [ ] commit：
  ```bash
  git add src/pages/admin/index.astro src/layouts/Layout.astro
  git commit -m "feat(seasons): nav + home entry points for 年度設定

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 9 — 部署 stage + 跑整合測試（TDD red→green 真實切換點）

前面 Task 的整合測試打的是 stage worker HTTP；endpoint 要先部署到 stage 才會由紅轉綠。

**Steps**
- [ ] 確認 stage 測試 env 變數已設（依 CLAUDE.md「Testing」）：
  ```bash
  echo "MANGO_STAGE_URL=$MANGO_STAGE_URL"; echo "TEST_TOKEN set? ${TEST_TOKEN:+yes}"
  ```
  **預期輸出**：`MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev`、`TEST_TOKEN set? yes`。若為空，先 `export MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev` 並設 `TEST_TOKEN=<stage ORDER_TOKEN>`（NEVER prod）。

- [ ] **（紅）先跑一次測試確認尚未部署的 endpoint 為紅**（若上一輪已部署可略）：
  ```bash
  bun test tests/seasons-endpoints.test.ts
  ```
  **預期輸出**：多個 case fail，因 stage 上 `/api/admin/seasons*` 仍 404（`Expected: 200 Received: 404` / `Expected: 409 Received: 404`）。

- [ ] 部署 stage（會 clean-build + 部署 main worker；季節 endpoint 屬 main worker `src/pages/**`，無新 binding，**不需**改 `wrangler.jsonc`/`scripts/deploy.mjs`）。**跨環境部署前須確認 active `PUBLIC_ORDER_TOKEN` 等於 stage 的 `ORDER_TOKEN`**（見 CLAUDE.md / MEMORY：token 在 `.env`）：
  ```bash
  bun run deploy:stage
  ```
  **預期輸出**：clean-build → `astro build` → `scripts/deploy.mjs` 三道 token guard 通過 → `wrangler deploy` 成功，印出 stage worker URL。

- [ ] **（綠）重跑整合測試**：
  ```bash
  bun test tests/seasons-endpoints.test.ts
  ```
  **預期輸出**：全綠（POST 建立 + dup 409 + bad 400 + csrf 403 + 啟用原子切換 + idempotent + archived→active + 404 + 封存阻擋 409 + 封存成功 200 + force 200 + 各 csrf）。例如尾端 `N pass / 0 fail`。

- [ ] **跑全測試套件確認無回歸**（season 模組未碰庫存/訂單寫入路徑，既有測試應全綠）：
  ```bash
  bun test
  ```
  **預期輸出**：所有既有測試 + 新 `seasons-endpoints` 皆通過，0 fail。

- [ ] **手動 smoke（瀏覽器）**：登入 stage 後台 → 開 `https://mango-hsu-stage.rhsu.workers.dev/admin/seasons` → 應看到歷年列表（含 stage 的 `2026` 標「當季」）+「建立新年度」表單；header 有「年度」入口；首頁有「年度設定」按鈕。建立一個 `test-smoke` 草稿、按「啟用」（確認 dialog → 2026 變封存、test-smoke 變當季）、再把 `2026` 重新啟用復原。**收尾**：在 stage D1 刪除 smoke 資料並還原 2026：
  ```bash
  bunx wrangler d1 execute mango-hsu-stage --env stage --remote --command \
    "UPDATE seasons SET status='archived' WHERE status='active'; UPDATE seasons SET status='active' WHERE code='2026'; DELETE FROM audit_log WHERE season_id IN (SELECT id FROM seasons WHERE code LIKE 'test-%'); DELETE FROM seasons WHERE code LIKE 'test-%';"
  ```
  **預期輸出**：執行成功，2026 回到 active。

> 不需跑 `scripts/reconcile-stock.ts`（本模組不動 `stock_fen`），但部署 stage 後若想保險可跑 `bun run scripts/reconcile-stock.ts --env stage`，預期 0 drift。

---

## Task 10 — 收尾檢查清單（self-review）

**Steps**
- [ ] 三支 API 都以 `authorizeAdmin(request, env, "admin")` 起手，`!auth.ok` 立即 `return text(auth.reason, auth.status)`（滿足 authorizeAdmin + requireSameOrigin 契約）。✅ 已在 Task 2/4/6 code 內。
- [ ] 啟用走「同一 batch：先降舊 active、再升新季、最後 audit」三 statement。✅ Task 4。
- [ ] audit action 字面正確：`season_create` / `season_activate` / `season_archive`。✅
- [ ] 所有時間戳 `new Date().toISOString()`（UTC ISO + Z）。✅
- [ ] 封存未出貨判定 = `season_id=? AND shipped=0 AND cancelled_at IS NULL`，前端頁與後端 archive.ts 一致。✅ Task 6/7。
- [ ] 無觸碰 production 庫存路徑（intake / products/batch / stock.ts）。✅
- [ ] 確認本模組未改 `wrangler.jsonc` / `scripts/deploy.mjs` / `package.json` / `src/db/schema.ts` / `drizzle/**`（季節欄位本就存在；`shipping_config` 由 P3 負責）。✅
- [ ] 最終 commit log 檢視：
  ```bash
  git log --oneline -8
  ```
  **預期輸出**：看到本模組 7 個 commit（POST、activate test、activate impl、archive test、archive impl、page、nav）依序排列。

---

## 與其他模組的依賴 / 交接

- **依賴 P3（運費）**：spec §4.1 會在 `seasons` 加 `shipping_config` 欄位，§5.5/§5.1 要求「運費設定區放在季節管理頁的當季區塊」。**本計畫的季節 CRUD 與 P3 解耦**：建立 API 不寫 `shipping_config`（讓 DB 預設值生效），季節頁不渲染運費設定。待 P3 落地後，由 P3（或整合 PR）在 `seasons/index.astro` 當季卡片內掛上運費設定區、並在 `seasons/index.ts` 的 INSERT 視需要帶入預設 `shipping_config`。**若先合本模組**：`seasons` 表此刻尚無 `shipping_config` 欄位，故本模組 INSERT 語句**刻意不含**該欄位（只插 `code,name,status,starts_at,created_at`），與當前 schema 完全相容。
- **不依賴 P1/P2/P4**：季節是其他模組（群組/品項都帶 `season_id`）的上游，但本模組只操作 `seasons` 與唯讀 `orders` 計數，無反向依賴。
- **共用契約使用**：audit actions（`season_create`/`season_activate`/`season_archive`）、`authorizeAdmin`+`requireSameOrigin`、UTC ISO 時戳、`order_id` 計數不重用（封存不刪訂單）。

---

## Open concerns（提請總編注意）

1. **`shipping_config` 欄位時序**：本模組 INSERT 不寫 `shipping_config`（避免與「P3 是否已加欄位」耦合）。若合併順序是「先 P3 後本模組」，DB 已有該欄位且有 DEFAULT，本模組 INSERT 省略它仍正確（取 DEFAULT）。若「先本模組後 P3」，欄位尚不存在，省略它也正確。兩種順序皆安全 — 但**「季節頁顯示/編輯運費」這塊明確不在本模組**，需在整合階段確認由 P3 補上，否則店主在季節頁看不到運費設定（spec §5.5 要求它在此頁）。
2. **toast helper 簽名**：本頁 `import { showToast, flashToast, consumeFlash } ... { kind: "success" | "error" }` 是比照 `product-groups/index.astro:237,324-328` 推得。Task 7 已加一步 `grep` 驗證；若實際 export 名稱/選項不同，以 product-groups 頁實際可編譯的呼叫為準（該頁是 ground truth）。
3. **operator 看得到「年度」nav 但點進去 403**：沿用既有「商品/庫存」連結對 operator 的相同行為（Layout nav 不分 role）。若總編希望對 operator 隱藏，需另外在 `Layout.astro` 包 `session.role === "admin"` 條件 — 但那會與既有 nav 風格不一致（既有 admin-only 連結也沒隱藏），故本計畫維持現狀。
4. **`force` 強制封存語意**：spec §5.1 只說「封存前建議檢查未出貨訂單並提示」。本計畫做成「預設阻擋 + `force:true` 覆寫」，比純提示更安全（避免誤封存）。若總編偏好「只提示、永遠放行」，把 archive.ts 的 `if (unshippedCount > 0 && !force)` 改為純記錄、移除 409 分支即可（測試對應案例同步調整）。
5. **整合測試的真實 red 時點在 Task 9（部署後）**：因測試走 stage HTTP，開發機若無 stage env 全 skip。每個實作 Task 以 `bun run build`（type-check）作本機把關，最終 red→green 在 Task 9 部署 stage 後驗證。此為本 repo 既有整合測試的固有特性（見 CLAUDE.md「Testing」），非本計畫缺陷。
