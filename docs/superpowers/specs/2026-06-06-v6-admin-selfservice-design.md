# V6 設計文件：後台年度販賣自助管理 + 門檻運費 + 忘記密碼 + 後台 UX 整頓

- **日期**：2026-06-06
- **分支**：`feature/v6-admin-selfservice`
- **狀態**：設計待 review
- **上線策略**：一次到位（開發時內部分模組逐一完成並各自測試，合併與正式上線為一次性）

---

## 1. 背景與目標

mango-hsu 是季節限定芒果預購電商（Astro 6 SSR on Cloudflare Workers + D1/Drizzle + KV + Tailwind v4）。底層庫存模型 V5.2 已採「**季節 season → 品種群組 product_group（`stock_fen` 重量池）→ 品項 product/SKU**」三層結構，資料庫層已完備，但**店主目前無法自助操作**——建立年度、建群組、建品項都得靠工程師改資料庫或跑 script。

**V6 目標**：讓非技術背景的店主能**全程自助**跑完一個年度的芒果販賣營運，並補上運費彈性、忘記密碼、以及全面的後台易用性。

**核心衡量標準**：店主能不靠工程師，獨立完成「2026 年度的設定 → 販賣中調整 → 季末封存」全程。

> 營運背景：2026 目錄已部分建立（2 群組 / 4 SKU / 已定價），庫存待 admin intake，店主正實際使用後台營運——所以易用性是**真實會卡到營運的需求**，非錦上添花。

---

## 2. 範圍

### 納入（10 塊）

| # | 模組 | 現況 |
|---|---|---|
| 1 | 年度季節管理：建立 / 啟用（原子切換）/ 封存 | 🔴 資料層備好，無 UI/API |
| 2 | 群組管理：新增 / 改名 / 上下架 | 🟡 進貨 API 完整，缺 CRUD |
| 3 | 品項管理：修復新增表單破洞 + 依群組分組顯示 | 🟡 新增表單目前是壞的 |
| 4 | SKU 介面中文化（只改畫面文字，識別碼維持英數） | 🔴 |
| 5 | 販賣中動態編輯：建群組→進貨→建品項 一條龍 | 🟡 底層支援，缺串接 |
| 6 | 季末封存（封存前檢查未出貨訂單） | 🔴 |
| 7 | 門檻運費：滿 N 斤免運 / 未滿收固定 X 元 | 🔴 目前寫死 $150 |
| 8 | 後台易用性 + 可發現性 | 🟡 有導航雛形，待強化 |
| 9 | 後台忘記密碼（Telegram 重設管道） | 🔴 安全零件齊全，待組裝 |
| 10 | 既有訂單管理 UX 整頓 | 🟡 多處可發現性問題 |

### 不納入（YAGNI，明確排除）

- SKU **不**改為中文識別碼（驗證規則、unique、顧客端 cart key、歷史快照、路由風險高且顧客看不到 SKU）。
- 運費**不**做多級距、偏遠地區加價、金額門檻（只做「滿斤數免運」單一門檻）。
- **不**做多季節同時販售（維持「同時最多一個 active 季節」）。
- 季節「複製上一年品項」列為**選配**，主線不含。
- **email 重設管道**列為未來階段；本次只做 Telegram，但結構（reset token 機制）與 email 解耦，未來加 Resend 不需重構。
- **不**新增 superadmin 跨帳號重設。

---

## 3. 設計決策摘要（已與店主拍板）

| 決策點 | 結論 | 備註 |
|---|---|---|
| 運費門檻單位 | **斤數**（非包數） | 用 `package_fen` 加總算總重量 |
| 運費規則形狀 | **滿 N 斤免運，未滿收固定 X 元**（單一門檻） | 不做級距 |
| 運費設定存放 | **季節層級**（`seasons.shipping_config`） | 每年可不同、販賣中可即時改、自動進稽核 |
| SKU 中文化 | **只改畫面文字**（label），識別碼維持英數 | 低風險，顧客本就看不到 SKU |
| 實作節奏 | **一次到位** | 內部仍分模組開發+測試 |
| 忘記密碼管道 | **Telegram**（推送到既有訂單通知聊天室） | 零新依賴；email 列未來階段 |
| 既有訂單 UX | **納入** V6 一起改 | 店主選擇整體一次變好用 |

---

## 4. 資料模型變動（最小化）

只動 2 張表、共新增 3 個欄位；庫存/群組/品項/稽核資料表**完全不動**。

### 4.1 `seasons` 表（`src/db/schema.ts:21-32`）
新增運費設定欄位：
```sql
ALTER TABLE seasons ADD COLUMN shipping_config TEXT
  DEFAULT '{"type":"flat","fee_twd":150}';
```
JSON 結構（存 fen 保持整數，與庫存單位一致）：
```jsonc
// flat（向後相容，等同現狀固定運費）
{ "type": "flat", "fee_twd": 150 }
// threshold_jin（V6 門檻運費）
{ "type": "threshold_jin", "free_over_fen": 1000, "fee_twd": 150 }
//   free_over_fen=1000 → 總重量 ≥ 10 斤免運；未滿收 fee_twd 元
```

### 4.2 `admin_users` 表（`src/db/schema.ts:76-84`）
新增密碼重設欄位：
```sql
ALTER TABLE admin_users ADD COLUMN reset_token TEXT;
ALTER TABLE admin_users ADD COLUMN reset_token_expires_at TEXT; -- UTC ISO-8601 Z
-- 視需要對 reset_token 加 unique index
```
> 遷移走 `bun run db:generate` → `db:migrate:stage`/`:prod`。屬於低風險加欄位（非破壞性）。

### 4.3 SKU 中文化
**不動資料庫**——`products` 已有 `name`（中文商品名）+ `variant`（規格），顧客/通知顯示本就優先用 `name+variant`（`formatters.ts:9,27-28`、`telegram.ts:29`），`sku` 僅內部識別碼。中文化只改 UI label 文字。

---

## 5. 各模組設計

### 5.1 季節管理（年度芒果販賣設定）

**白話**：一個「年度設定」頁，列出歷年、標示當季，能建立新年度、啟用、封存。

**後端 API（新增）**
- `POST /api/admin/seasons` — 建立新季節（`code` 唯一、`name`、`status='draft'`、可選 `starts_at`/`ended_at`/`shipping_config`）。audit `season_create`。
- `PATCH /api/admin/seasons/[id]/activate` — **原子切換**（見下）。audit `season_activate`。
- `PATCH /api/admin/seasons/[id]/archive` — 當季 → archived。audit `season_archive`。

**關鍵技術點：啟用的原子切換**
`seasons` 有 partial unique index `seasons_active_singleton`（`WHERE status='active'`，`drizzle/0003:29`）保證最多一個 active。啟用新季時**必須在同一個 `env.DB.batch()` 內先把舊 active 降為 `archived`、再把新季升為 `active`**，否則兩列同時 active 會撞 unique 約束。封存前建議檢查舊季是否仍有未出貨訂單並提示。

**畫面**：`src/pages/admin/seasons/index.astro`（新）。導航與首頁加「年度設定」入口。

### 5.2 群組管理（品種庫存池）

**白話**：在現有「庫存池」頁上，加「新增群組」「改名 / 上下架」。

**後端 API（新增）**
- `POST /api/admin/product-groups/create` — 當季建群組（`slug` 驗 `[a-z0-9-]+` 且 `(season_id,slug)` 不重複、`name` 中文名、`display_order`、`available`）。audit `group_create`。
- `PATCH /api/admin/product-groups/[id]` — 改 `name`/`available`/`display_order`；**明確拒絕含 `stock_fen` 的請求**（庫存只能走 intake）。audit `group_update`。

**不動**：進貨 API `POST /api/admin/product-groups/[id]/intake`（兩段式 CAS + 防負數 + 冪等，已極完整）。

**畫面**：擴充 `src/pages/admin/product-groups/index.astro` —— 加「＋新增群組」與每群組「編輯 / 上下架」，沿用既有 StickyBar/dirty-tracker/toast 模式。

### 5.3 品項管理（含破洞修復）

**🔧 破洞修復（必做）**：`src/pages/admin/products/index.astro` 的新增表單與 `readForm`（約 328-370 行）**目前沒送 `group_slug` 與 `package_fen`**，但後端 `create.ts:40-49` 兩者必填 → 從 UI 新增任何 SKU 必然失敗（`GROUP_NOT_FOUND`/bad slug）。**目前店主根本無法自助新增品項**。
- 修法：表單加「所屬群組」下拉（讀當季 `product_groups` 的 `slug`+`name`）+「包裝大小」選擇（半斤=50 / 1 斤=100 / 10 斤=1000 對應 `package_fen`）。

**擴充**：依群組分組顯示（金煌群組底下有哪些 SKU），呼應店主對「群組 ↔ 品項」的理解。標示當季、提示「同一 SKU 字串跨季是不同商品」「不要刪 SKU（`order_items.sku` 是歷史快照）」。

**不動**：批次編輯 API `POST /api/admin/products/batch.ts`（成熟）。

### 5.4 SKU 介面中文化（只改 label）

**範圍：純文字/label 改動，後端零改動。** 不碰欄位、驗證 `[A-Z0-9_-]+`、unique、路由、歷史訂單。

**改動位置（來自盤點）**
- `src/pages/admin/products/index.astro`：表頭 `SKU`（46、124）、新增表單 placeholder/aria-label（138-140）、驗證 toast（355）、每列 aria-label 前綴（64/75/87/98/108）→ 「**商品編碼**」。
- `src/pages/admin/product-groups/index.astro`：「包含 SKU：」→「**包含編碼：**」；**移除 `fen` 明文顯示**（97、130-135、146、287，UI 只留「斤」，fen 純內部）；`slug`（34、127）→「**品種代碼**」或隱藏。

> 詞表：SKU→商品編碼、slug→品種代碼、fen→（移除，只顯示斤）、package_fen→包裝大小、group→品種、variant→規格。

### 5.5 門檻運費（斤數）

**白話**：後台設「滿○斤免運 / 未滿收○元」；前後台下單即時用新算法預覽；已成立訂單金額不受影響（運費是當下快照存在 `orders.shipping`）。

**核心改造**：`shippingFor()`（`src/lib/order-response.ts:47-52`）目前用 `Σqty`、`totalQty>0?fee:0`。改為：
1. 算總重量 `totalFen = Σ(package_fen × qty)`（需把 cart items resolve 到各 SKU 的 `package_fen`——下單時 `resolveItemsForStock` 已做 sku→group/package_fen 映射，可共用）。
2. 讀 active season 的 `shipping_config`：
   - `flat` → 回 `fee_twd`（總量>0 時）。
   - `threshold_jin` → `totalFen >= free_over_fen ? 0 : fee_twd`。

**同步點**
- 後端：`src/pages/api/orders.ts:125-126`、`src/pages/api/admin/orders.ts:86` 改傳 `shipping_config`（取代讀 `env.SHIPPING_FEE_TWD`）。
- 設定載入：`src/lib/site-settings.ts:88` 改從 active season 讀 `shipping_config`（取代 env）。
- 前端即時預覽：`src/pages/order.astro`（309/338）、`src/pages/admin/orders/[id].astro`（376/408-410）需拿到各品項 `package_fen`（渲染時帶 `data-package-fen`）以在前端算總斤數。
- 顯示：運費行與 FAQ（`products.astro:46`）文案改為門檻說明。
- `orders.shipping` 欄位、Telegram「含運」顯示不變。

**設定畫面**：運費設定區放在**季節管理頁的當季區塊**（屬季節層級設定），允許 active 時即時改，audit `shipping_config_change`。

### 5.6 後台忘記密碼（Telegram 管道）

**白話**：登入頁加「忘記密碼？」→ 輸入 email → 系統把**重設連結推到店主的 Telegram** → 點連結設新密碼。

**流程與元件（複用既有安全零件）**
1. **新頁** `src/pages/admin/forgot-password.astro`：僅 email 輸入，POST 到 request-reset API（登出可達）。登入頁 `login.astro` 加連結。
2. **新 API** `POST /api/admin/auth/request-reset`：
   - rate limit `3/hour/email`（擴充 `src/lib/rate-limit.ts` 既有 KV 模式）。
   - 驗 email 存在後生成 reset token（複用 `auth.ts:82` `crypto.getRandomValues`），存 `reset_token` + `reset_token_expires_at`（**TTL 30 分鐘**）。
   - **Telegram push**（複用 `telegram.ts` 既有 bot/chat）：「重設連結：…/admin/reset-password?token=XXX，30 分鐘內有效」。
   - **防 email 列舉**：無論 email 是否存在都回一致訊息（「若該帳號存在，已發送連結」）。audit `password_reset_requested`。
3. **新頁** `src/pages/admin/reset-password.astro`：
   - GET `?token=` → 驗 token 存在且未過期。
   - POST → 新密碼（12+ 字，比照改密頁規則）→ PBKDF2 hash（`auth.ts:37-76`）→ 更新、清空 reset_token、**刪除該用戶所有舊 session**（複用改密 API 模式 `src/pages/api/admin/auth/change-password.ts:20-88`）→ audit `password_reset_success` → 導向登入。token 無效/過期 → 友善錯誤。
4. **audit actions（新）**：`password_reset_requested` / `password_reset_failed` / `password_reset_success`。

> 安全備註：重設連結僅出現在店主的 Telegram，攻擊者即使輸入正確 email 也收不到連結；rate limit 防騷擾。Telegram 聊天室需僅限店主/家人可見（文件提醒）。

### 5.7 後台易用性 + 可發現性

**現況**（盤點）：已有 header 導航（`Layout.astro:42-90`）+ 首頁 KPI（`admin/index.astro:51-127`）+ role（admin/operator），**無孤兒頁**。問題集中在術語外露、按鈕條件隱晦、入口權限無提示。

**V6 改善**
- **全域導航強化**：side nav 或重整 header，清楚含「訂單 / 年度設定 / 品種庫存 / 商品 / 紀錄 / 設定 / 帳號」，標示當前位置；手機 drawer。
- **首頁營運儀表板**：在既有 KPI 上加「**當季是哪一年 + 各品種剩餘庫存（斤，低量標紅）**」與快速操作。
- **麵包屑**：頁面層級導引。
- **空狀態引導**：還沒建群組/品項時顯示「下一步做什麼」。
- **術語中文化**：見 5.4 詞表，全後台一致。
- **權限提示**：無權限頁面顯示說明而非空白。

### 5.8 既有訂單管理 UX 整頓（店主指定納入）

**改善（來自盤點 `orders/index.astro`、`orders/[id].astro`）**
- **訂單詳情操作面板重組**（`[id].astro:236-286`）：把「會消失的條件按鈕」改為**狀態流程卡**（未付款→待出貨→已出貨），下一步按鈕**永遠可見**，未達條件時 disabled + 明確說明（「已付款後才可標出貨」）。
- **訂單編輯流程簡化**（`[id].astro:149-191/309-318`）：減少步驟、編輯區明確視覺提示、StickyBar 改為視線內浮動。
- **批次操作 UX**（`orders/index.astro:118-142`）：勾選後按鈕變色 +「✓ 已選 N 筆」提示；「一鍵生揀貨單」→「生成揀貨單」；「批次標已出貨」加確認框列出單號。
- **按鈕文字 / 確認框**：危險或批次操作前確認；toast 訊息具體化（「已標 3 筆為已出貨」而非「已儲存」）。
- **代客建單頁**加「← 返回訂單列表」（`orders/new.astro:49`）。

> 範圍控制：訂單整頓聚焦「可發現性與操作清晰」，**不**改訂單底層狀態機與既有 API 行為。

---

## 6. 跨切面：安全 / 並發 / 稽核

- **授權**：所有新 mutation API 走 `authorizeAdmin()`（`src/lib/admin-api.ts`）+ `requireSameOrigin()` CSRF（`src/lib/csrf.ts`）。季節/群組寫入需 admin role。
- **並發**：群組改名/上下架等沿用既有**樂觀鎖 CAS**（`STALE_STATE`）與**冪等鍵**模式；庫存只走 intake（不在 V6 改）。
- **稽核不變式**：任何 `stock_fen` 變動仍須同 `batch` 寫 `group_stock_change` audit（V6 不碰此路徑，但新流程提交要帶 idempotency_key）。新增 audit actions：`season_create`、`season_activate`、`season_archive`、`group_create`、`group_update`、`shipping_config_change`、`password_reset_*`。
- **季節啟用**：原子切換見 5.1，避免撞 active singleton index。
- **reconcile**：部署後仍跑 `scripts/reconcile-stock.ts`。

---

## 7. 測試計畫

沿用 `bun test` + stage 整合（`tests/_setup.ts`、`TEST-`/`test-` 前綴、`seedActiveSeasonScenario` 等）。

- **純單元（無 env）**：`shippingFor()` 門檻計算（flat / threshold_jin / 邊界 / 0 件 / 剛好門檻）。
- **整合（stage）**：
  - 季節 建立/啟用原子切換（驗證舊季降檔、active singleton 不衝突）/封存（未出貨訂單阻擋）。
  - 群組 create / update（拒絕 stock_fen）。
  - 品項新增**修復後**能成功（帶 group_slug + package_fen）。
  - 忘記密碼：request-reset（rate limit、email 列舉一致回應、token 生成）、reset-password（過期 token 拒絕、成功改密 + 清 session）。
  - 運費端到端：下單後 `orders.shipping` 符合門檻規則。

---

## 8. 風險與緩解

| 風險 | 緩解 |
|---|---|
| 季節啟用撞 active singleton index | 同一 batch 先降舊季再升新季；整合測試覆蓋 |
| 運費前後台算法不一致 | 抽共用計算（後端權威），前端僅預覽；端到端測試比對 |
| 品項破洞修復影響既有批次編輯 | 只動新增表單路徑，batch API 不改；回歸測試 |
| 忘記密碼被觸發騷擾店主 Telegram | rate limit 3/hr/email + email 列舉防護 |
| Telegram 聊天室非私密致連結外洩 | 文件提醒限店主/家人；未來 email 管道為更佳 |
| 範圍大（10 塊）導致工期長 | 內部分模組交付+各自測試；必要時與店主協商拆批上線 |
| 加欄位遷移 | 非破壞性 ADD COLUMN + 預設值；遷移前 `db:export:prod` 備份 |

---

## 9. 實作順序（一次到位；內部分模組，由低風險→高耦合）

1. **地基修復**：品項新增破洞（5.3）+ SKU/術語中文化（5.4/5.7 術語）—— 小、低風險、立即可驗。
2. **資料遷移**：`seasons.shipping_config` + `admin_users.reset_token*`（4.x）。
3. **運費門檻**（5.5）：`shippingFor` 改造 + 前後台同步 + 設定畫面 + 測試。
4. **季節管理**（5.1）：CRUD + 原子啟用 + 封存檢查。
5. **群組管理**（5.2）+ 一條龍串接（5.5 流程）。
6. **忘記密碼**（5.6）。
7. **後台 UX**（5.7）+ **訂單 UX 整頓**（5.8）。
8. 全量整合測試 + stage QA + reconcile → 一次合併上線。

---

## 10. 工作量估算（相對，誠實）

| 模組 | 規模 | 粗估 |
|---|---|---|
| 品項破洞修復 + 術語中文化 | 小 | 1 天 |
| 資料遷移 | 小 | 0.5 天 |
| 門檻運費（含前後台同步+測試） | 中 | 2 天 |
| 季節管理（CRUD+原子切換+封存） | 大 | 3 天 |
| 群組管理 + 一條龍 | 中 | 2 天 |
| 忘記密碼（Telegram） | 中 | 1.5 天 |
| 後台 UX（導航/儀表板/空狀態/麵包屑） | 大 | 3 天 |
| 既有訂單 UX 整頓 | 中–大 | 2.5 天 |
| 整合測試 + QA + 上線 | 中 | 2 天 |
| **合計** | | **約 17–18 人日** |

> 這是一個**大型版本**。若工期需收斂，最先建議拆出的獨立可上線批次為「地基修復+運費」與「忘記密碼」，季節/群組/UX 為主體。
