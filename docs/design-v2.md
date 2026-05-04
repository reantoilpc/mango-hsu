# Design: mango-hsu V2 — 自有後台 + Cloudflare D1

Successor to `design-v1.md`.
Status: SHIPPED (V2 + V3 LIFF binding)

## V1 → V2 動機

V1 跑了一季，痛點集中在三件事：

1. **家人在 Sheet 上操作太累** — 滑鼠在 Excel-like 介面找訂單、checkbox 打勾、
   填 tracking_no — 手機上幾乎不能用。產季尖峰一天十幾筆，操作很慢。
2. **Apps Script cold start + LockService**最差感知延遲 ~13 秒，客人下訂時
   loading 體感差。
3. **Sheet 是業餘者的 DB** — `errors` 分頁手動翻、PDPA 自動清理寫在 Apps Script
   的 trigger 裡（脆弱）、無 audit trail、PII 可能洩漏（Sheet 共享範圍出錯）。

**V2 目標：** 把資料層搬出 Google，給家人一個能在手機用的後台。

## Recommended Approach — Astro SSR + Cloudflare Workers + D1

### 技術組成
- **前端 + 後端**：Astro 6 (`output: 'server'`) + `@astrojs/cloudflare` adapter
- **資料庫**：Cloudflare D1（SQLite），透過 Drizzle ORM
- **快取/Session**：Cloudflare KV（rate-limit、session — V2 已搬 D1，KV 留作 rate-limit）
- **CSS**：Tailwind v4
- **部署**：兩個 Worker，同一個 repo
  - 主 Worker：客人站 + admin 後台 + `/api/*`
  - Cron Worker：`src/cron-worker.ts`，每週日 18:00 UTC 跑 PDPA 6 個月清理

### 為什麼選 Cloudflare 而不是 Vercel / Pages Functions
- D1 跟 Worker 同一個 PoP，latency 低
- 免費額度足夠（家庭規模 < 100k req/day）
- LIFF 整合需要 stable URL；`*.workers.dev` 就有
- Cron worker 在 Workers 平台一行 trigger 寫好

### 為什麼選 Astro 而不是 Next.js
- V1 已經是 Astro 靜態站，遷移成本低
- Astro 6 的 SSR 模式 + Cloudflare adapter 非常乾淨；不需要 Edge / Node 兩套 runtime 觀念
- File-based routing 對 admin pages 寫起來簡單

## 主要資料模型（`src/db/schema.ts`）

| Table | 用途 |
|---|---|
| `products` | SKU、名稱、規格、價格、上架旗標、顯示順序 |
| `orders` | 訂單主檔；包含 `paid`/`shipped` 旗標、tracking_no、PDPA 欄位、LINE userId |
| `order_items` | 訂單品項（pricing 快照，不靠 products join 還原） |
| `admin_users` | email、PBKDF2 密碼 hash、role（admin/operator）、`must_change_password` |
| `sessions` | 32-byte token → user_email + expires_at |
| `audit_log` | 所有 mutation 的 trail（誰、何時、做了什麼、訂單） |

**時間慣例：** 所有 timestamp 欄位是 UTC ISO-8601 + `Z`。**唯一例外**是 `order_id` 的
`M-YYYYMMDD-NNN`，沿用 V1 慣例使用 **Asia/Taipei** 行事曆日（避免半夜 23:59 跨日訂單編號跳天）。

**FK 設計：**
- `audit_log.user_email` 故意**不是** FK — admin 退休刪掉時，audit history 必須留
- `audit_log.order_id` **是** FK 且 cascade delete — PDPA 6 個月清訂單時，連帶刪 audit
- `order_items.order_id` cascade delete 同理

## Admin 後台

V1 直接讓家人編 Sheet；V2 蓋了一個專屬後台（`/admin`），家人改用瀏覽器。

### 路由
- `/admin/login` — email + 密碼
- `/admin` — 三項統計（total / pending paid / pending ship）+ 最近 5 筆訂單
- `/admin/orders` — 列表 + filter（all / unpaid / paid_unship / shipped）+ 批次操作
- `/admin/orders/[id]` — 詳情、標已付款 / 標已出貨 / admin-only 編輯/取消
- `/admin/batches/new?ids=...` — 揀貨單列印頁（A4 print stylesheet）
- `/admin/products` — admin-only，CRUD
- `/admin/audit` — read-only audit log
- `/admin/change-password`

### 角色
- `admin`：全權限
- `operator`：只能標 paid / shipped、印揀貨單；不能改商品、不能編訂單

操作層權限檢查在每個 API endpoint；UI 層也會根據 role 隱藏按鈕（縱深防禦）。

## 認證

**密碼：** PBKDF2-SHA256，20k iterations，per-user salt。pinning 在 20k 是因為 Workers
free tier 免費 isolate ~3x 慢於本機 Bun，跑出來 ~6ms/req，在 10ms CPU cap 內留 30%
餘裕。OWASP 2026 建議 600k，家庭 5 人規模這個 trade-off 可以接受。

格式：`pbkdf2$<iters>$<base64-salt>$<base64-hash>`

**Session：** 32-byte hex token，存在 D1 `sessions` 表。Cookie `mh_session` 是
`HttpOnly; Secure; SameSite=Strict; Path=/`，TTL 7 天。Middleware 在每個請求驗證並把
`session` 注入 `Astro.locals`。

**CSRF：** SameSite=Strict 是第一線；`requireSameOrigin()`（Origin/Referer 同主機檢查）
是第二線，套在所有 mutation API。

**Login 速率限制：** KV `RATELIMIT` namespace，per-IP 計數。

## 安全 Headers

`src/middleware.ts` 對所有 response 加：
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`
- HTML response 加 `Content-Security-Policy`，`'unsafe-inline'` 開給 LIFF SDK +
  Astro hydration（內容皆 server-controlled）。將來若引入 user-generated HTML 必須改 nonce。

## V3 增量：LINE OA + LIFF 綁定

V2 ship 後加了一個功能：客人在 `/status` 頁可以「綁定 LINE 帳號」，
之後 paid/shipped 狀態變更會自動推 LINE 訊息。

**設計：**
- 客人 `/status?id=...` 看到「接收 LINE 通知」按鈕，產生 HMAC-signed bind URL
- payload `${order_id}:${phoneLast4}:${exp}`，sig = HMAC-SHA256(secret, payload)，30 分鐘 TTL
- 把客人帶進 LIFF（LINE 內瀏覽器），LINE Login 後拿到 `userId`，連同 sig + exp + phoneLast4
  POST 回 `/api/liff/bind`
- Server 重新計算 sig 比對 — payload 包含 phone-last-4 是 cso 2026-05-03 finding：
  「URL 截圖外流時，攻擊者沒有 phone 也綁不了」

**為什麼不只用 expiry：** URL 進到客人手機後可能被 LINE chat 截圖、qrserver
side-channel 之類的洩漏。phone-last-4 是客人額外掌握的因子。

**Push 月度上限：** LINE Messaging API 免費 200 則/月（在 `src/lib/line.ts` 計數）；
160 則時送告警。

## 部署 — Astro 6 + Cloudflare adapter 的坑

`@astrojs/cloudflare` 13.x 在 build 時產生 `dist/server/wrangler.json`，但會
**flatten 並忽略** `wrangler.jsonc` 根層級的 `env.*` overrides。直接 `wrangler deploy`
打 stage / prod 會用錯設定。

**workaround：** `scripts/deploy.mjs` 在 build 之後 patch
`dist/server/wrangler.json`，根據 target（stage/prod）改寫 worker name、D1 / KV id、
`BANK_ACCOUNT_DISPLAY`，然後才 `wrangler deploy`。

⚠️ 加新 per-env binding 必須**同時更新** `wrangler.jsonc` AND `scripts/deploy.mjs`。

## Astro 6 env quirk

Astro 6 拿掉了 `Astro.locals.runtime.env`。`src/lib/env.ts` 包了一層
`cloudflare:workers` 的 request-scoped env import 並轉成 `AppEnv` 型別，
所有 page / API 都從這裡 import `env`。不要直接 cast `Astro.locals`。

## PDPA 自動清理

V1 是 Apps Script time-driven trigger（脆弱、無告警）。V2 改成獨立的 Cron Worker：

- `wrangler.jsonc` 的 `env.cron` 區塊，`main: ./src/cron-worker.ts`
- Schedule `0 18 * * 0`（每週日 UTC 18:00 = 台灣 02:00）
- 跑 `purgeOldOrders`：刪除 `created_at < now - 6 個月` 的 orders；audit_log 透過 FK cascade 一併刪除

之所以另開 worker 而非 Astro 的 `scheduled()`：adapter 對 cron handler 的支援版本浮動，
獨立 worker 更穩。

## 未做 / 未來

- **季節開關搬到後台 UI**：目前 `ACCEPTING_DRY` 是 worker var，要改要重 deploy。後台一個按鈕會更好。
- **線上付款（LINE Pay / 綠界）**：V1 design doc 列為 V2 範圍，但實際 V2 沒做 — 對帳痛點先用 LINE OA push 緩解。
- **客人自助修改訂單**：目前只能 admin 改。
- **多管道分析**：哪些客人是 LINE 來、哪些是分享連結，目前無紀錄。

## 參考

- 程式碼地圖：`CLAUDE.md`
- 家人操作手冊：`family-runbook.md`
- V1 原始設計：`design-v1.md`
