> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

# V6 主實作計畫：後台年度販賣自助管理 + 門檻運費 + 忘記密碼 + 後台 UX 整頓

- **日期**：2026-06-06
- **分支**：`feature/v6-admin-selfservice`
- **設計 spec**：[`../specs/2026-06-06-v6-admin-selfservice-design.md`](../specs/2026-06-06-v6-admin-selfservice-design.md)
- **上線策略**：一次到位（內部分 9 個模組各自開發 + 測試，最終一次合併、一次 prod 上線；spec §9 第 8 步）
- **角色**：本檔是 9 份模組 plan 的**總編 / 編排層**。它**不重述**各模組的逐步 code，而是給出：依賴排序的總執行順序、跨模組共用契約一覽、**跨模組檔案爭用與合併順序**、spec 覆蓋對照、以及待總編裁定的決策清單。每個模組的逐步實作請點進對應的 `./v6/PN-*.md`。

---

## Goal

讓非技術背景的店主能**全程自助**跑完一個年度的芒果販賣營運（建年度 → 建群組 → 進貨 → 建品項 → 販賣中調整 → 季末封存），並補上運費彈性（門檻運費）、後台忘記密碼（Telegram 管道）、以及全面的後台易用性與既有訂單 UX 整頓。**核心衡量標準**：店主能不靠工程師，獨立完成「2026 年度的設定 → 販賣中調整 → 季末封存」全程。

## Architecture

- **技術棧**：Astro 6 SSR on Cloudflare Workers + D1（SQLite）/ Drizzle + KV + Tailwind v4。執行器 Bun（`bun test`、`bun run …`）。兩個 worker：main（`src/pages/**`）＋ cron（`src/cron-worker.ts`，本版不動）。
- **既有底層（V5.2，已完備）**：三層庫存模型「季節 `seasons` → 品種群組 `product_groups.stock_fen` 重量池（單位 `fen`，1 斤=100 fen）→ 品項 `product`/SKU（各帶 `package_fen`）」。每 SKU 可售數量是**推導**（`floor(group.stock_fen / sku.package_fen)`），不另存。`seasons` 最多一列 `status='active'`（partial unique index `seasons_active_singleton`）。
- **V6 資料模型變動（最小化，只動 2 表 + 4 個 schema 物件，全部非破壞性 `ADD COLUMN`）**：`seasons.shipping_config`（TEXT，預設 flat-150）、`admin_users.reset_token` / `reset_token_expires_at`（nullable）+ partial unique index `admin_users_reset_token_unique`。由 **P3** 一支手寫遷移 `drizzle/0007_*.sql` 落地（**絕不可跑 `db:generate`**——drizzle metadata 凍結在 0002，generate 會產出重做整個 V5.2 的災難 SQL；理由見 P3 §0.2）。
- **權威性原則**：庫存只走 `intake` API（兩段式 CAS + 同 batch 寫 `group_stock_change` audit）；運費計算後端權威、前端僅預覽；訂單狀態機由既有 server SQL guard 把關，P9 只加可發現性提示。**本版完全不碰**：intake / `products/batch.ts` / `group_stock_change` 稽核路徑 / `orders.shipping` 快照語意 / cron worker。
- **稽核不變式**：任何 `stock_fen` 變動仍須同 batch 寫 `group_stock_change` audit；新 mutation 一律 `authorizeAdmin()` + `requireSameOrigin()`（忘記密碼端點刻意例外，見 P7）。

## Tech Stack

Astro 6、Cloudflare Workers + D1 + Drizzle、KV、Tailwind v4、Bun（`bun test` 純單元 + stage HTTP 整合）。整合測試打**已部署的 stage worker**（`MANGO_STAGE_URL` + `TEST_TOKEN`=stage `ORDER_TOKEN` + `wrangler login`），故「改 endpoint → `bun run deploy:stage` → 跑整合測試」是固有節奏（deploy 前須確認 active `PUBLIC_ORDER_TOKEN` == 目標環境 `ORDER_TOKEN`，token 在 `.env`，見 CLAUDE.md）。

---

## 模組總覽（9 份 plan）

| 模組 | 連結 | 一句摘要 | tasks |
|---|---|---|---|
| **P1** 品項破洞修復 + 分組顯示 | [./v6/P1-products-fix-and-grouping.md](./v6/P1-products-fix-and-grouping.md) | 修好新增商品表單（補送 `group_slug`+`package_fen`，目前從 UI 新增必失敗），清單改依品種群組分組。 | 6 |
| **P2** SKU/術語中文化 | [./v6/P2-terminology-zhtw.md](./v6/P2-terminology-zhtw.md) | 後台兩頁面向店主文案中文化（SKU→商品編碼、slug→品種代碼、移除 fen 明文）；後端零改。 | 5 |
| **P3** 資料庫遷移 | [./v6/P3-migrations.md](./v6/P3-migrations.md) | 手寫 `0007`：`seasons.shipping_config` + `admin_users.reset_token*` + partial unique index。**地基，運費/忘記密碼依賴它**。 | 6 |
| **P4** 門檻運費 | [./v6/P4-shipping-threshold.md](./v6/P4-shipping-threshold.md) | 抽純算 `src/lib/shipping.ts`，前後台下單依 `shipping_config` 算斤數運費；PATCH 設定 API；文案。**依賴 P3**。 | 10 |
| **P5** 季節管理 | [./v6/P5-seasons.md](./v6/P5-seasons.md) | 季節 CRUD（建立/原子啟用/封存檢查未出貨）+ 年度設定頁 + 導航入口。**群組/運費 UI 掛靠點**。 | 10 |
| **P6** 群組管理 + 一條龍 | [./v6/P6-groups.md](./v6/P6-groups.md) | 群組 create/update（拒 `stock_fen`）+ 庫存池頁 CRUD UI + 建群組→進貨→建品項串接。**依賴 P5（active season）**。 | 7 |
| **P7** 後台忘記密碼 | [./v6/P7-password-reset.md](./v6/P7-password-reset.md) | request-reset / reset-password 端點（Telegram 管道、列舉一致、token 存雜湊）+ 兩頁 + middleware 白名單。**依賴 P3**。 | 7 |
| **P8** 後台易用性/可發現性 | [./v6/P8-admin-ux.md](./v6/P8-admin-ux.md) | data-driven 導航（active + 手機 drawer）+ 首頁營運儀表板（當季+各品種剩餘庫存）+ 麵包屑 + 友善 403 + 空狀態。 | 11 |
| **P9** 既有訂單 UX 整頓 | [./v6/P9-orders-ux.md](./v6/P9-orders-ux.md) | 訂單詳情狀態流程卡（下一步永遠可見）+ 編輯提示 + 批次選取/確認 UX。純前端，**不碰 API**。 | 8 |

**總 task 數：70**（6+5+6+10+10+7+7+11+8）。

---

## 依賴關係圖

```
                         ┌─────────────────────────────┐
   (無依賴，可最先平行)   │  P1 地基修復(§5.3)            │
                         │  P2 術語中文化(§5.4)          │   ← 純前端/前端，互不依賴
                         │  P3 遷移(§4)  ★地基           │   ← 純 DDL + schema
                         │  P9 訂單UX(§5.8)              │   ← 純前端，零依賴
                         └─────────────────────────────┘
                                      │
              P3 落地後 ┌─────────────┴───────────────┐
                       ▼                              ▼
                ┌────────────┐                 ┌──────────────┐
                │ P4 運費(§5.5)│                 │ P7 忘記密碼(§5.6)│   ← 兩者皆 runtime 依賴 P3 欄位
                │  依賴 P3    │                 │  依賴 P3      │
                └─────┬──────┘                 └──────────────┘
                      │ (P4 交付 shipping-config PATCH API；UI 掛在季節頁)
                      ▼
                ┌────────────┐
                │ P5 季節(§5.1)│  ← 建 /admin/seasons 頁（P4 的運費設定 UI 掛此頁當季卡片）
                └─────┬──────┘
                      │ (P5 建立 active season 機制；P6 API 自查 active season)
                      ▼
                ┌────────────┐
                │ P6 群組(§5.2)│  ← 群組 CRUD 掛在當季底下；一條龍連到 P1 修好的 products 頁
                └─────┬──────┘
                      │
                      ▼
                ┌──────────────────────────────┐
                │ P8 後台UX(§5.7)  ★UX 收尾      │  ← 導航/儀表板/麵包屑/403 跨多頁；須在 P1/P2/P5/P6 後
                └──────────────────────────────┘
                      │
                      ▼
              全量整合測試 + stage QA + reconcile-stock → 一次合併 → prod 套 0007 → prod 上線
```

**依賴規則（硬性）**
- **P3 先於 P4、P7**：兩者 runtime 讀 `seasons.shipping_config` / `admin_users.reset_token*`。P4/P7 的 TS 型別與 stage 整合測試都要欄位先存在。
- **P5 先於 P6**：P6 所有群組掛在 `status='active'` 季節下（P6 API 自查 active season，測試用 `seedActiveSeasonScenario` 自備，故**可平行開發**；但**合併/上線**時 P5 須先讓 active-season 機制與年度設定頁存在）。
- **P4 ↔ P5 交界**：spec §5.5 要求運費設定 UI 放「季節管理頁當季區塊」。該頁由 P5 建，PATCH API 由 P4 建。**整合階段須有人把 P4 的設定 UI 片段掛進 P5 的 `seasons/index.astro`**（見「待總編裁定」#1）。
- **P1 先於 P6 的一條龍**：P6 的「新增此品種品項」連結跳到 P1 修好的 products 新增表單（含 `group_slug`/`package_fen` 下拉）。**§5.3 破洞修復由 P1 獨佔**；P6 Task 6.4（補同樣兩個下拉）標為 conditional，**P1 先落地後 P6 只做 6.3「讀 `?group=` 預選」一行**（見「待總編裁定」#2）。
- **P8 最後（UX 收尾）**：P8 改的導航/儀表板/麵包屑/403 散落多頁，與 P1/P2/P5/P6 改同檔。排在它們之後，降低 Edit `old_string` 比對衝突。

---

## 建議總執行順序（依賴拓撲排序）

> 開發期可多模組平行（各自分支 + stage 自測）；下表是**合併進主幹 / 上線編排**的順序。`execution_order` 結構化輸出與此一致。

1. **P3**（遷移）— 地基。先 schema.ts + 手寫 `0007` + stage 套用 + 驗證。**prod 套用延到第 10 步**。
2. **P1**（品項破洞修復 + 分組）— 小、低風險、立即可驗；§5.3 表單修復的唯一擁有者。
3. **P2**（術語中文化）— 純文字；排在 P1 之後（兩者同改 `products/index.astro`、`product-groups/index.astro`，P1 先動結構、P2 再改文案，衝突面較小）。
4. **P9**（訂單 UX）— 零依賴、零 API、僅 3 個 `orders/*.astro`，與其他模組無檔案爭用，可任意早做；排此處便於與 P8 一起做 UX QA。
5. **P4**（門檻運費）— 依賴 P3。交付 `shipping.ts` + 3 呼叫點 + `shipping-config` PATCH API + 前端預覽 + 文案。
6. **P5**（季節管理）— 建 `/admin/seasons` 頁 + 季節 CRUD + 導航/首頁入口。
7. **P6**（群組管理 + 一條龍）— 依賴 P5 的 active-season 機制 + P1 的 products 表單。
8. **P7**（忘記密碼）— 依賴 P3。與 P4/P5/P6 無檔案爭用（除 `middleware.ts`，見爭用表）。
9. **P8**（後台 UX）— 收尾，須在 P1/P2/P5/P6 之後（同改 `Layout.astro` / `admin/index.astro` / `products/index.astro` / `product-groups/index.astro`）。
10. **整合收尾**：P4 運費 UI 掛進 P5 季節頁（交界補完）→ 全量 `bun test`（stage）→ stage QA（瀏覽器走完整自助流程）→ `bun run scripts/reconcile-stock.ts --env stage`（0 drift）→ 一次合併 → **prod 套 `0007`（先 `db:export:prod` 備份）** → prod 部署 main worker → prod reconcile。

---

## 跨模組共用契約一覽

> 所有模組**必須照字面**使用。下表已對照 spec §6 與既有 codebase 核對；各模組的 audit INSERT 欄位列允許省略不需要的欄（`order_id` / `season_id` 省略即 NULL，皆為既有合法寫法，見 `change-password.ts` vs `cancel.ts`）。

### 1. 新 audit actions（spec §6；details 為自由 JSON 字串）

| action | 寫入模組 | `details` 形狀 |
|---|---|---|
| `season_create` | P5 | `{code, name, starts_at}` |
| `season_activate` | P5 | `{activated_id, code, from_status}` |
| `season_archive` | P5 | `{archived_id, code, from_status, unshipped_count, forced}` |
| `group_create` | P6 | `{group_id, slug, name, display_order, available}` |
| `group_update` | P6 | `{group_id, changed[], before, after}` |
| `shipping_config_change` | P4 | `{before, after}`（兩者皆 `ShippingConfig` 物件） |
| `password_reset_requested` | P7 | `{email}` |
| `password_reset_failed` | P7 | `{reason, email?}`，`reason ∈ {missing_email, rate_limited, unknown_email, invalid_token, expired_token, weak_password}` |
| `password_reset_success` | P7 | `{email, rotated:true}` |

既有 action 不變、不重用：`product_create`（P1 沿用，**不新增**）、`group_stock_change`（庫存路徑，本版不碰）、`order_*`、`mark_paid`/`mark_shipped`/`order_cancelled`/`bulk_mark_shipped`、`password_changed` 等。
**`audit_log` 欄位**：`(ts, user_email, action, order_id, season_id, details)`；`user_email` 非 FK；`order_id` 是 FK（cascade）；季節/群組/帳號事件 `order_id` 傳 `null`。時間戳一律 `new Date().toISOString()`（UTC ISO-8601 `Z`）。

### 2. `shipping_config` JSON 契約（P3 生欄位 / P4 消費 / P5 預設）

```jsonc
{ "type": "flat", "fee_twd": 150 }                                  // 預設，等同舊固定運費
{ "type": "threshold_jin", "free_over_fen": 1000, "fee_twd": 150 }  // 滿 10 斤免運，未滿收 150
```
- **單位**：`free_over_fen`、`totalFen` 皆 fen（整數，1 斤=100 fen）；`fee_twd` 台幣整數元。
- **DB 預設**：`seasons.shipping_config` 欄位 `NOT NULL DEFAULT '{"type":"flat","fee_twd":150}'`（既有 row 回填，不改既有訂單金額）。
- **算法**（P4 `computeShipping`）：`totalFen<=0 → 0`；`flat → fee_twd`；`threshold_jin → totalFen >= free_over_fen ? 0 : fee_twd`（門檻**含等於**免運）。
- **容錯**：`parseShippingConfig`（讀取側）對壞 JSON/缺欄回退 `DEFAULT_SHIPPING_CONFIG`（fail-safe，顧客下單不因壞 config 中斷）；**設定寫入側**（P4 PATCH `validateConfig`）對壞形狀回 400（不靜默回退，店主要看到錯誤）。

### 3. 授權 / CSRF

- 所有新 `/api/admin/**` mutation：`authorizeAdmin(request, env, "admin")`；`!auth.ok` 即 `return text(auth.reason, auth.status)`。`authorizeAdmin` 對非 GET **內部已呼叫** `requireSameOrigin`（CSRF 第二道），故端點端**不需**再手動呼叫（P5/P6 採此）。
- **刻意例外**：P7 的 `request-reset` / `reset-password` **不要求 session**（忘記密碼者沒登入），改 `requireSameOrigin(request)` 為唯一 CSRF 防線 + rate limit。
- 季節/群組/運費寫入需 **admin role**（第三參數 `"admin"`）。頁面（`.astro`）授權用 `Astro.locals.session`（非 `authorizeAdmin`）。

### 4. 新 helper / 路徑 / 命名（跨模組引用點）

| 物件 | 來源 | 簽章 / 形狀 |
|---|---|---|
| `parseShippingConfig` / `computeShipping` / `totalFenOf` / `describeShipping` / `DEFAULT_SHIPPING_CONFIG` / `ShippingConfig` | P4 `src/lib/shipping.ts`（新） | 純函式（無 env/DB） |
| `shippingFor(items, config)` | P4 改 `src/lib/order-response.ts` | 簽章由 `(items, env)` 改為 `(items:{package_fen,qty}[], config: ShippingConfig)` |
| `SiteSettings.shipping_config` | P4 改 `site-settings.ts` + `types.ts` | active season 的 `ShippingConfig`；`shipping_fee_twd` 改由它衍生 |
| `sha256Hex` / `generateResetToken` | P7 改 `src/lib/auth.ts` | 純函式；token 存 SHA-256 雜湊不存明文 |
| `checkResetRequestRate(env, email)` | P7 改 `src/lib/rate-limit.ts` | KV bucket `rl:reset:<email>`，3/hr |
| `sendTelegramMessage(env, text)` | P7 改 `src/lib/telegram.ts` | 通用推送；**不動** `notifyOrder` |
| `ADMIN_NAV_ITEMS` / `navItemsForRole` / `activeNavKey` | P8 `src/lib/admin-nav.ts`（新） | 純函式，導航模型 |
| `groupStockSummary` / `fenToJinLabel` / `LOW_STOCK_THRESHOLD_FEN`(=500) | P8 `src/lib/admin-dashboard.ts`（新） | 純函式，儀表板 |
| `AdminBreadcrumb.astro` / `AdminForbidden.astro` | P8（新元件） | 純展示 |

**API 路徑（新）**：`POST /api/admin/seasons`（P5，`seasons/index.ts`）、`PATCH /api/admin/seasons/[id]/activate`（P5）、`PATCH /api/admin/seasons/[id]/archive`（P5）、`PATCH /api/admin/seasons/[id]/shipping-config`（**P4**）、`POST /api/admin/product-groups/create`（P6）、`PATCH /api/admin/product-groups/[id]`（P6）、`POST /api/admin/auth/request-reset`（P7）、`POST /api/admin/auth/reset-password`（P7）。**無路徑衝突**：P4 只在 `seasons/[id]/` 加 `shipping-config.ts`，與 P5 的 `index.ts`/`activate.ts`/`archive.ts` 共存。

**error_code 慣例**：成功 `{ok:true,…}`；失敗 `{ok:false, error_code:"…", …}` 配對 HTTP status。已用：`CODE_EXISTS`(409)、`SLUG_TAKEN`(409)、`NO_ACTIVE_SEASON`(409)、`STOCK_FORBIDDEN`(400)、`NO_FIELDS`(400)、`STALE_STATE`(409)、`UNSHIPPED_ORDERS`(409)、`GROUP_NOT_FOUND`(404，既有)。

### 5. 測試慣例

- 純單元（無 env）：`shipping`、`order-response-shipping`、`auth-reset-helper`、`admin-nav`、`admin-dashboard`、`terminology-zhtw`（讀 `.astro` 字串）、`stock-helper`、`items-hash`、`csp`、`deploy-token-guard`。
- stage 整合（import `tests/_setup.ts`）：`products-create`、`group-crud`、`seasons-endpoints`、`shipping-config-endpoint`、`shipping-e2e`、`password-reset`、`admin-ux-html`。需 `MANGO_STAGE_URL` + `TEST_TOKEN`（**NEVER prod**）+ `wrangler login`，且**該分支已部署 stage**。
- 測試資料前綴：SKU `TEST-`（大寫）、客名 `test-`、season/group code+slug `test-`、admin email `@local`。`cleanupTestData()`/`cleanupTestAdmin()` 只刪這些。
- 既有 `_setup.ts` helper（已存在，勿重造）：`seedActiveSeasonScenario`（回 `{season_id, group_id, product_ids}`）、`seedSeason`/`seedGroup`/`seedProductInSeason`、`createTestAdminSession`、`d1Execute`、`stageFetch`、`STAGE_URL`、`getGroupStockFen`/`setGroupStockFen`、`skipIfNoIntegration`。P7 會**新增** `seedAdminUser`/`getResetTokenRow`/`setResetToken`/`countSessions`/`seedSessionFor`/`clearResetRateLimit`（純增量，不改既有 export）。

---

## 跨模組檔案爭用與合併順序（總編核心職責，務必遵守）

> 以下 production 檔被 **2 個以上模組**改動。**同一檔的多筆 Edit 以「內容 `old_string` 精確比對」為準**：若前一模組已改動使後一模組的 `old_string` 比對不到，後者**先 `Read` 該檔當前內容再據實調整 `old_string`**（各模組 plan 都有此提醒）。合併順序固定如下。

| 檔案 | 改動模組 | 合併順序 & 處置 |
|---|---|---|
| `src/db/schema.ts` | **P3 獨佔** | 只有 P3 改（加 4 欄位）。P5/P6/P7 明文「不再動 schema.ts」。✅ 無爭用。 |
| `src/layouts/Layout.astro` | **P5**(插「年度」連結) + **P8**(整段重寫 nav) | **P5 先、P8 後**。P8 Task 4 的 data-driven nav **已含「年度設定」**，**取代** P5 那筆。執行 P8 時若 P5 已落地，P8 的 `old_string` 需含 P5 加的「年度」連結（先 Read）。已在 P5 Task 8 / P8 Task 4 各加協調註。最終結果一致。 |
| `src/pages/admin/index.astro` | **P5**(加年度設定首頁入口) + **P8**(加營運儀表板) | **P5 先、P8 後**。兩者都在 `session.role==='admin'` 區塊內插入，**互不重疊**（P5 插連結、P8 插 KPI 後儀表板）。相容，但 P8 須在 P5 後以正確 `old_string` 比對。 |
| `src/pages/admin/products/index.astro` | **P1**(表單修復+分組) + **P2**(文案) + **P6 6.4**(conditional) + **P8**(403 包覆 6.6 / 麵包屑 7.1 / 空狀態 8.1) | 順序 **P1 → P2 → P6 → P8**。**§5.3 表單下拉由 P1 獨佔**；P6 跳過 6.4、只做 6.3「`?group=` 預選」。P8 的 403 包覆把整個 `<Layout>…</Layout>` 包進 `{forbidden ? … : (…)}`，**必須最後做**（包覆後其他模組的 `old_string` 縮排會變）。P2 的 grep 斷言測試在 P8 包覆後仍應綠（只比對文案字串）。 |
| `src/pages/admin/product-groups/index.astro` | **P2**(文案+移除 fen 副標) + **P6**(新增群組表單/編輯/上下架/一條龍) + **P8**(403 包覆 6.4 / 麵包屑 7.2) | 順序 **P2 → P6 → P8**。⚠️ **P2 與 P6 在同一段 header 互卡**：P2 Task 4 移除 `data-current-fen-label` 的 `({g.stock_fen} fen)` 副標；P6 Task 5.1 重寫整個 header（其 `old_string` 含、`new_string` 也移除該 fen 副標）。**建議 P6 先做 header 重寫（5.1 已順帶移除 fen 副標），P2 Task 4 改為驗證該副標已不存在即可**；或 P2 先做、P6 5.1 的 `old_string` 改抓 P2 後的內容。P8 403 包覆最後做。 |
| `src/pages/admin/orders/[id].astro` | **P4**(運費預覽：frontmatter island + `recomputeTotals`) + **P9**(操作面板 + 編輯提示) | 順序 **P4 → P9** 或 **P9 → P4**皆可（**改動區域不重疊**：P4 動 frontmatter `#v5-order-state` island 與 `recomputeTotals`/`ProductInfo`/`sellableForNew`；P9 動操作 `<section>`、品項/客人資訊標題、mark-paid/shipped click handler 的 disabled 早退）。**唯一交界**：兩者都在同一 client `<script>` 內各改不同函式，後做者 `old_string` 需以前做者改後內容比對。建議 **P4 先**（運費是資料正確性）、P9 後（純展示）。 |
| `src/pages/order.astro` / `src/pages/products.astro` | **P4 獨佔** | 只有 P4 改（運費預覽 + FAQ 文案）。✅ 無爭用。 |
| `src/middleware.ts` | **P7 獨佔**（本版內） | 只有 P7 改（白名單放行 forgot/reset-password）。spec §5.7（P8）未改 middleware。若日後 §5.7 要動 middleware 須與此協調同一處。✅ 本版無爭用。 |
| `src/pages/admin/orders/index.astro` | **P8**(麵包屑 7.4) + **P9**(批次 UX) | 順序 **P9 → P8** 或 **P8 → P9**（P9 改批次工具列/列/script，P8 只在 `<main>` 後插一行麵包屑，區域不重疊）。後做者比對前者內容即可。 |
| `src/pages/admin/audit.astro` | **P8 獨佔**（麵包屑） | ✅ 無爭用。 |
| `tests/_setup.ts` | **P7 獨佔**（新增 reset helper） | 純增量 append，不改既有 export；既有測試不受影響。✅ |

**合併順序總結（同檔安全序）**：P3 → P1 → P2 → P9 → P4 → P5 → P6 → P7 → P8（與上方「建議總執行順序」一致；P8 永遠最後收尾 UI）。

---

## 全域 Self-Review

### (a) Spec 覆蓋對照（§4、§5.1–§5.8、§6）

| spec 節 | 內容 | 覆蓋模組 / Task | 狀態 |
|---|---|---|---|
| **§4.1** `seasons.shipping_config` | 加欄位 + JSON 契約 | P3 Task 1–2（schema + 0007 SQL） | ✅ |
| **§4.2** `admin_users.reset_token*` | 加欄位 + index | P3 Task 1–2 | ✅ |
| **§4.3** SKU 中文化不動 DB | — | P2（純文案，後端零改）；P3 不碰 products | ✅ |
| **§5.1** 季節管理（建立/原子啟用/封存檢查） | CRUD + 原子切換 + 未出貨檢查 + 頁面 + 入口 | P5 Task 2/4/6（API）、7（頁）、8（入口） | ✅ |
| **§5.2** 群組管理（新增/改名/上下架，拒 `stock_fen`） | create + PATCH + UI | P6 Task 2/3（API）、4/5（UI） | ✅ |
| **§5.3** 品項破洞修復 + 分組顯示 | 表單補 `group_slug`/`package_fen` + 依群組分組 | P1 Task 3（修復）、4（分組） | ✅（P1 獨佔；P6 6.4 為備援，正常跳過） |
| **§5.4** SKU/術語中文化（label only） | SKU→商品編碼、slug→品種代碼、移除 fen 明文 | P2 Task 2/3/4 | ✅ |
| **§5.5** 門檻運費 + 設定畫面（季節頁當季區塊） | 算法 + 前後台同步 + PATCH API + 文案 | P4 全 + **設定 UI 掛季節頁交界需整合補完** | ⚠️ 見 gap-1 |
| **§5.5** 一條龍（建群組→進貨→建品項） | 串接 + 空狀態引導 | P6 Task 6 | ✅ |
| **§5.6** 後台忘記密碼（Telegram） | request/reset 端點 + 兩頁 + middleware + 連結 | P7 Task 2–6 | ✅ |
| **§5.7** 後台易用性/可發現性 | 導航/儀表板/麵包屑/空狀態/友善 403/術語 | P8 Task 1–8（術語部分→P2） | ✅ |
| **§5.8** 既有訂單 UX 整頓 | 狀態流程卡/編輯提示/批次 UX/返回連結 | P9 Task 2–6 | ✅（StickyBar 浮動刻意不做，見 gap-2） |
| **§6** 跨切面（授權/並發/稽核/原子啟用/reconcile） | `authorizeAdmin`+CSRF、CAS 樂觀鎖、audit 不變式、原子切換、部署後 reconcile | P4–P7 各自落實；P5 原子啟用；各模組部署後 reconcile（P5/P6/P7 不碰 stock 故 0 drift） | ✅ |

**coverage_ok = true**（每節都有 task 覆蓋）。下列為**非缺漏、但需總編在整合階段收口的交界 / 刻意取捨**：

- **gap-1（交界，非缺漏）**：§5.5「運費設定 UI 放季節管理頁當季區塊」。P4 交付權威 `PATCH …/shipping-config` API + 下單計算 + 文案，但**明確不建** `seasons/index.astro`（P5 建）；P5 **明確不渲染運費設定 UI**（解耦）。→ **整合第 10 步須有人把 P4 的「當季運費設定」HTML 片段（P4 §0.5 提供範例）掛進 P5 的 `seasons/index.astro` 當季卡片**，否則店主在季節頁看不到運費設定。**建議指派：P4 收尾或整合 PR。**
- **gap-2（刻意取捨）**：§5.8「StickyBar 改為視線內浮動」。P9 **刻意不動** `StickyBar.astro`（跨頁共用元件，註解載明曾因浮在內容上覆蓋資料被改回 bottom-fixed），改以頁面內靜態編輯提示達成同等可發現性。**是否另開子任務動共用元件，留總編裁定。**

### (b) 跨檔型別 / 命名一致性（已核對既有 codebase）

| 檢查項 | 結論 |
|---|---|
| audit action 名 | 9 個新 action 與 spec §6 列表**逐字一致**；P5/P6/P7 的 `details` 形狀互不衝突。✅ |
| `shipping_config` JSON | `flat`/`threshold_jin`、`free_over_fen`（fen）、`fee_twd` 三模組（P3 預設 / P4 算 / P5 不寫取預設）**完全一致**。✅ |
| `shippingFor` 簽章 | P4 改 `(items, env)`→`(items:{package_fen,qty}[], config)`；3 個呼叫點（orders.ts/admin orders.ts/save.ts）+ 純測試同步改，無殘留舊簽章。✅ |
| API 路徑 | P4 `seasons/[id]/shipping-config.ts` 與 P5 `seasons/{index,activate,archive}` **不衝突**（已核 Astro 檔案路由）。✅ |
| helper 名 | `parseShippingConfig`/`computeShipping`/`totalFenOf`/`describeShipping`、`sha256Hex`/`generateResetToken`、`checkResetRequestRate`、`sendTelegramMessage`、`ADMIN_NAV_ITEMS`/`activeNavKey`、`groupStockSummary` 各模組引用**一致**。✅ |
| audit INSERT 欄位列 | P5/P6 用 `(…, order_id, season_id, details)`；P5 `create.ts`/P7 用 `(…, season_id, details)` 或 `(…, details)`——**全部是既有合法 named-column 寫法**（核對 `change-password.ts` vs `cancel.ts`），省略欄預設 NULL。**非不一致**。✅ |
| `seedActiveSeasonScenario` 回傳 | 既有回 `{season_id, group_id, product_ids}`；P1/P5/P6 測試用 `.season_id`/`.group_id` **與實際一致**。✅ |
| `create.ts` 契約（P1 對標） | `group_slug` 驗 `/^[a-z0-9-]+$/`、`package_fen` 整數 1–100000、`error_code` `NO_ACTIVE_SEASON`/`GROUP_NOT_FOUND`、audit `product_create`——P1 測試**與實際端點逐項對齊**。✅ |
| `settings.products[].package_fen` | P4 前端 `data-package-fen` 依賴此欄——`site-settings.ts` **已輸出**。✅ |

**結論：無機械式型別/命名不一致需修正。** 各模組已對齊 spec 與既有 code。本總編所做的 PN 檔修正（見下）皆為**執行協調註記**，非契約修正。

### (c) Placeholder 掃描

對 9 份 plan 全文 grep `TBD/TODO/FIXME/待補/類似上面/同上` 等 → **0 命中**。各模組每個 code/SQL/test step 均為完整可貼上內容，每個指令附預期輸出。✅ 無缺 code 的 step。

### 本總編對 PN 檔所做的修正（inconsistencies_fixed）

> 唯一在 PN 檔留下的改動是**雙向協調註記**，避免執行者在 `Layout.astro` nav 上「打架失敗的 Edit」。非契約/型別修正（那類本來就一致）。

1. **P5 Task 8** + **P8 Task 4**：加入互指的「`src/layouts/Layout.astro` admin nav 由 P5+P8 共改」協調註，明定 **P5 先、P8 後**、P8 的 data-driven nav 已涵蓋「年度設定」入口並取代 P5 那筆、後做者須先 Read 當前內容再比對 `old_string`。

---

## 待總編 / 店主裁定的決策清單（彙整自各模組 open_concerns）

1. **[交界, 高] §5.5 運費設定 UI 掛靠**：誰把 P4 的「當季運費設定」片段掛進 P5 的 `seasons/index.astro`？建議整合第 10 步由 P4 收尾或整合 PR 負責（gap-1）。
2. **[範圍, 中] §5.3 表單下拉擁有權**：確認由 **P1 獨佔**、P6 跳過 6.4 只做 6.3。本計畫已如此編排；請拍板以免雙寫。
3. **[語意, 中] P5 封存 `force`**：P5 做成「預設阻擋未出貨 + `force:true` 覆寫」，比 spec §5.1「建議檢查並提示」更嚴。若偏好「只提示永遠放行」，調 `archive.ts` 與測試。
4. **[安全, 中] P7 Telegram fire-and-forget 不 audit 失敗**：為列舉防護犧牲 push 失敗可觀測性。若要可觀測需走 `ctx.waitUntil()`（與專案「不走 `Astro.locals.runtime`」原則牴觸）。
5. **[安全, 低] P7 reset token GET vs POST 驗證**：P7 把 token 驗證放 POST（GET 只看有無 token query），與 spec §5.6 字面「GET 即驗」略異（取簡單安全版）。
6. **[元件, 低] §5.8 StickyBar 浮動**：P9 刻意不動共用 `StickyBar.astro`（gap-2）。是否另開子任務？
7. **[地基, 中] drizzle metadata 凍結在 0002**：P3 沿用手寫遷移、不更新 `drizzle/meta/`。建議 V6 後另排「metadata 重設（重新 introspect 產 baseline）」任務拆地雷——**不在本版範圍**。
8. **[地基, 低] deferred `0006_drop_old_stock_column.sql`**：本版用 `0007` 跳過；`products.stock` 物理 drop 仍 deferred（等 prod 穩定≥5 天）。`seedProductInSeason` 仍寫 `products.stock`，若該欄被 drop 會壞所有整合測試 seed——提醒勿在本版期間套用 deferred 0006。
9. **[middleware owner]** 本版 `middleware.ts` 僅 P7 動。若未來 §5.7 也要動，指定單一 owner 模組避免衝突。

---

## 上線前最終驗收清單（整合第 10 步）

- [ ] P3 `0007` 已套 stage 並驗證（欄位/型別/default/index/功能性互斥）；**prod 套用前已 `bun run db:export:prod` 備份**。
- [ ] 9 模組各自 `bun run build` / `bunx astro check` 0 error；各自純單元測試綠。
- [ ] 全分支已 `bun run deploy:stage`（token 規則），跑全量 `bun test`（stage 整合）全綠；特別確認 `save-endpoint`/`stock-d1`/`regression-cancelled-orders` 未因 `shippingFor` 簽章變更退步（stage 季節用 P3 預設 flat-150，等同舊行為）。
- [ ] §5.5 運費設定 UI 已掛進季節頁當季卡片（gap-1 收口）。
- [ ] stage QA：以 admin 帳號實機走完「建年度 → 啟用 → 建群組 → 進貨 → 建品項（一條龍）→ 下單看門檻運費 → 編輯訂單 → 封存」；忘記密碼端到端（Telegram 收連結→改密→新密碼登入）；operator 看友善 403。
- [ ] `bun run scripts/reconcile-stock.ts --env stage` → 0 drift。
- [ ] 一次合併 → **prod 套 `0007`** → prod 部署 main worker → `bun run scripts/reconcile-stock.ts --env prod` → 0 drift。

---

## 附：本檔角色與邊界

- 本檔是**編排層**，不含逐步 code；逐步實作以 `./v6/PN-*.md` 為準。
- 硬性規則（與各模組一致）：**不碰** intake / `products/batch.ts` / `group_stock_change` 稽核 / `orders.shipping` 快照語意 / cron worker；新 mutation 一律授權 + CSRF；時間戳 UTC ISO-8601 `Z`；訂單 ID `M-YYYYMMDD-NNN` 用 Asia/Taipei 日。
- 本總編僅改 `docs/superpowers/plans/` 下檔案（本 master + P5/P8 協調註），**未動任何 production code**。
