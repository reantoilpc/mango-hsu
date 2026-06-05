# P3 — 資料庫遷移：seasons.shipping_config + admin_users.reset_token*

> 模組：V6 §4 資料模型變動。
> 對應 spec：`docs/superpowers/specs/2026-06-06-v6-admin-selfservice-design.md` §4.1 / §4.2 / §6 / §8（風險表「加欄位遷移」列）。
> 性質：**非破壞性 `ADD COLUMN`**。動 2 張表、共加 4 個欄位（spec 寫 3 個；本計畫對 `reset_token` 多加一個 partial unique index，因此 schema 端等同 4 個 schema 物件變更，DB 端 4 個 DDL 語句）。
> 其他模組（運費、忘記密碼）**依賴本遷移先落地**，見文末 `depends_on` 反向說明。

---

## 0. 給「對本 codebase 零 context 的工程師」的關鍵背景（**先讀完再動手**）

這段不是廢話，搞錯會在 stage/prod 資料庫上製造災難。**讀完再開始 Task 1。**

### 0.1 本專案的遷移檔是「手寫」的，不是 `drizzle-kit generate` 產生的

雖然 `package.json` 有 `db:generate`（= `drizzle-kit generate`），但本專案的 V5.2 遷移檔 `drizzle/0003`~`drizzle/0006` **全部是人手寫的**，不是 generate 出來的。證據：

- `drizzle/meta/_journal.json` 的 `entries` 只到 `idx: 6 / tag: 0003..0006`，但 **`drizzle/meta/` 底下只有 `0000_snapshot.json`、`0001_snapshot.json`、`0002_snapshot.json` 三個 snapshot**（沒有 0003+ 的 snapshot）。
- `drizzle/meta/0002_snapshot.json` 描述的是**V5.2 之前的舊 schema**：`products` 還是以 `sku` 為識別碼、還有 `stock` 欄位、**沒有** `season_id`/`group_id`/`package_fen`/`id`；**完全沒有** `seasons` 表、**沒有** `product_groups` 表；`admin_users` 也**沒有** `reset_token`。

### 0.2 為什麼**絕對不能**在這個模組跑 `bun run db:generate`

`drizzle-kit generate` 會拿「現在的 `src/db/schema.ts`」**diff 最後一個 snapshot（= 0002，舊 schema）**，然後產生「把舊 schema 變成新 schema」的 SQL。因為 0002 snapshot 停在 V5.2 之前，generate 會嘗試產生一份「**重做整個 V5.2 遷移**」的 SQL：建 `seasons`、建 `product_groups`、重建 `products`（加 PK / season_id / group_id / package_fen、丟 stock）、對 `orders`/`audit_log` 加 `season_id`……**而這些東西在 stage/prod 上早就存在了**。把那份 SQL 套到資料庫 = 撞 table/column 已存在、或在重建 products 時搬資料 = 災難。

**結論：本模組沿用 0003~0006 的做法 —— 手寫一個 `drizzle/0007_*.sql` 遷移檔。本計畫所有步驟都不呼叫 `db:generate`。** （CLAUDE.md 把 `db:generate` 列為「編 schema 後重新生成」的標準流程，但那是在 drizzle metadata 沒漂移的專案前提下；本專案 metadata 已漂移，故本模組明確偏離，理由如上。）

### 0.3 wrangler 怎麼知道哪些遷移已套用

`wrangler d1 migrations apply <db>` 讀 `wrangler.jsonc` 的 `migrations_dir`（本專案 = `drizzle`），掃該資料夾的 `NNNN_*.sql`，比對 D1 內部一張 `d1_migrations` 追蹤表（**用檔名**記錄已套用者），只跑「檔名沒在追蹤表裡」的檔。這條路徑**和 drizzle 的 `_journal.json` 無關**——所以即使 journal 漂移，`wrangler d1 migrations apply` 仍能正確只套用新檔 `0007_*.sql`。

> **驗證點（Task 4 會做）**：套用前先 `wrangler d1 migrations list mango-hsu-stage --env stage --remote`，預期它**只列出 `0007_*.sql` 一個未套用檔**。若它列出 0003~0006，代表這台 D1 的遷移狀態異常（理論上不會，因為 V5.2 已上線），**停手回報總編**，不要硬套。

### 0.4 編號與命名

- 下一個編號是 **`0007`**（現有最大是 `0006_drop_old_stock_column.sql`，在 `drizzle/deferred/`，但 journal idx=6 已佔用 0006 這個 tag）。為避免和 deferred 的 0006 在語意上打架，**用 0007**。
- 檔名：`drizzle/0007_v6_shipping_config_and_reset_token.sql`（snake_case，描述性，比照 `0003_seasons_and_groups.sql` 風格）。
- **不要**動 `drizzle/meta/_journal.json` 或新增 snapshot。0003~0006 都沒進 journal/snapshot，保持一致；硬塞反而會讓未來某次誤跑 `db:generate` 時 diff 基準更混亂。（此決策在 `open_concerns` 留給總編覆核。）

### 0.5 環境順序與備份（硬性）

- spec §8 與 §4.2 明文：**遷移前先 `bun run db:export:prod` 備份**。雖然是非破壞性 ADD COLUMN，仍照規矩走。
- 套用順序：**先 stage 驗證 → （本計畫到 stage 為止）**。prod 套用留到 V6 整批合併上線時統一執行（spec §9 第 8 步「一次合併上線」），本計畫在 Task 6 給出 prod 套用的**現成指令與預期輸出**，但標記為「上線時才執行」，不在開發階段跑 prod。

### 0.6 SQLite `ADD COLUMN` 對 DEFAULT 的限制（為什麼 default 用「常數字串」沒問題）

SQLite `ALTER TABLE ADD COLUMN` 允許 `DEFAULT <常數>`，常數字串（如 `'{"type":"flat","fee_twd":150}'`）完全合法。本遷移的 default 是字面 JSON 字串常數，符合限制。`reset_token` / `reset_token_expires_at` 不給 default（預設即 NULL），也合法。

---

## 共用契約（與其他 V6 模組一致，本模組負責「把欄位生出來」）

- `seasons.shipping_config` 存 **JSON 字串**，兩種形狀：
  - `{"type":"flat","fee_twd":150}`（預設、向後相容現狀固定運費）
  - `{"type":"threshold_jin","free_over_fen":1000,"fee_twd":150}`（門檻運費；`free_over_fen` 單位 fen，1 斤=100 fen）
  - **DB 欄位 default = `'{"type":"flat","fee_twd":150}'`**（既有 row 自動帶此值，等同現狀 $150 固定運費，不改變既有訂單金額）。
- `admin_users.reset_token TEXT`（nullable）+ `admin_users.reset_token_expires_at TEXT`（nullable，存 UTC ISO-8601 Z）。
- `reset_token` 加 **partial unique index**：`WHERE reset_token IS NOT NULL`（多個 NULL 不互斥，但同一個非 NULL token 不可重複）。沿用 `seasons_active_singleton` 的 partial-index 寫法（已驗 D1 支援）。
- 時間戳 UTC ISO-8601 Z；本模組不寫任何 audit row（純 DDL）；新 audit action（`shipping_config_change`、`password_reset_*` 等）由消費這些欄位的模組寫入。

---

## Task 列表總覽

1. **Task 1** — 改 `src/db/schema.ts`：加 3 個欄位定義 + reset_token partial unique index（讓 drizzle 型別與 DB 對齊；不驅動 SQL）。
2. **Task 2** — 手寫 `drizzle/0007_v6_shipping_config_and_reset_token.sql`。
3. **Task 3** — 靜態自檢遷移 SQL（型別檢查 + lint 檔案結構，不碰 DB）。
4. **Task 4** — 遷移前備份（`db:export:prod`）。
5. **Task 5** — 套用到 **stage** 並驗證欄位/索引存在 + default 正確。
6. **Task 6** — （上線時才跑）prod 套用指令與預期輸出；收尾 commit。

> 每個 code/SQL step 都給完整內容；每個指令都給**預期輸出**。bite-sized：單步 2–5 分鐘。

---

## Task 1 — schema.ts 加欄位定義 + reset_token partial unique index

**Files**
- Modify: `src/db/schema.ts`
  - `seasons` 表（現 `:21-32`）：在 `created_at` 後加 `shipping_config`。
  - `admin_users` 表（現 `:76-84`）：把單純 object 形式改成 `(table) => ({...})` 形式以掛 partial unique index，並加兩個 reset 欄位。

> 為什麼先改 schema.ts：本模組雖手寫 SQL，但 schema.ts 是 drizzle 型別的單一真相來源（`typeof seasons.$inferSelect` 等被全 codebase 引用）。新欄位若不進 schema.ts，後續模組（運費讀 `season.shipping_config`、忘記密碼讀 `admin.reset_token`）的 TS 型別會缺欄位、編譯失敗。SQL 由 Task 2 手寫，schema.ts 只負責型別。

### Steps

- [ ] 1.1 在 `src/db/schema.ts` 確認 `seasons` 定義現況（行 21–32），`created_at` 是最後一個欄位、`seasons` 目前**沒有** `(t)=>({...})` 第二參數。

- [ ] 1.2 在 `seasons` 的 `created_at` 欄位後新增 `shipping_config`。把：

```ts
export const seasons = sqliteTable("seasons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(), // "2026", "2027"
  name: text("name").notNull(), // "2026 芒果季"
  status: text("status", { enum: ["draft", "active", "archived"] })
    .notNull()
    .default("draft"),
  starts_at: text("starts_at"),
  ended_at: text("ended_at"),
  cloned_from_season_id: integer("cloned_from_season_id").references((): any => seasons.id),
  created_at: text("created_at").notNull(), // UTC ISO + Z
});
```

改成：

```ts
export const seasons = sqliteTable("seasons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(), // "2026", "2027"
  name: text("name").notNull(), // "2026 芒果季"
  status: text("status", { enum: ["draft", "active", "archived"] })
    .notNull()
    .default("draft"),
  starts_at: text("starts_at"),
  ended_at: text("ended_at"),
  cloned_from_season_id: integer("cloned_from_season_id").references((): any => seasons.id),
  created_at: text("created_at").notNull(), // UTC ISO + Z
  // V6 §4.1: per-season shipping rule, JSON string.
  //   {"type":"flat","fee_twd":150}  (default — back-compat with the old flat $150 fee)
  //   {"type":"threshold_jin","free_over_fen":1000,"fee_twd":150}  (free over N 斤; free_over_fen in fen, 1斤=100fen)
  // DB column carries a literal-string DEFAULT so pre-existing rows read as flat $150.
  shipping_config: text("shipping_config")
    .notNull()
    .default('{"type":"flat","fee_twd":150}'),
});
```

> 說明：`.notNull().default(...)` 讓 TS 型別把 `shipping_config` 視為必有字串（消費端不用處理 `null`）。DB 端的 `NOT NULL DEFAULT` 在 Task 2 SQL 中以 `ADD COLUMN ... NOT NULL DEFAULT '...'` 落地——SQLite 對「帶常數 DEFAULT 的 NOT NULL ADD COLUMN」是允許的（既有 row 會回填該常數）。

- [ ] 1.3 改 `admin_users`：原本是「單一 object，無第二參數」，要改成「`(table) => ({...})` 形式」以掛 partial unique index，並加兩個欄位。把：

```ts
export const admin_users = sqliteTable("admin_users", {
  email: text("email").primaryKey(),
  password_hash: text("password_hash").notNull(), // "pbkdf2$<iters>$<base64-salt>$<base64-hash>"
  role: text("role", { enum: ["admin", "operator"] }).notNull(),
  must_change_password: integer("must_change_password", { mode: "boolean" })
    .notNull()
    .default(true),
  created_at: text("created_at").notNull(),
});
```

改成：

```ts
export const admin_users = sqliteTable(
  "admin_users",
  {
    email: text("email").primaryKey(),
    password_hash: text("password_hash").notNull(), // "pbkdf2$<iters>$<base64-salt>$<base64-hash>"
    role: text("role", { enum: ["admin", "operator"] }).notNull(),
    must_change_password: integer("must_change_password", { mode: "boolean" })
      .notNull()
      .default(true),
    created_at: text("created_at").notNull(),
    // V6 §4.2: Telegram-channel forgot-password. Both nullable; cleared after a successful reset.
    reset_token: text("reset_token"), // single-use opaque token (crypto.getRandomValues)
    reset_token_expires_at: text("reset_token_expires_at"), // UTC ISO-8601 + Z; 30-min TTL set by the request-reset endpoint
  },
  (t) => ({
    // Partial unique index: many NULLs allowed, but a non-null reset_token must be unique.
    // Same partial-index pattern as seasons_active_singleton (D1 SQLite parser support verified).
    uqResetToken: uniqueIndex("admin_users_reset_token_unique")
      .on(t.reset_token)
      .where(sql`${t.reset_token} IS NOT NULL`),
  }),
);
```

- [ ] 1.4 因為 1.3 用到 `sql` template，確認 import。檔案首行現為：

```ts
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
```

改成（多 import `sql`，它來自 `drizzle-orm` 根，不是 `drizzle-orm/sqlite-core`）：

```ts
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
```

> 註：partial index 的 `.where(sql\`...\`)` 是 drizzle 標準寫法；`sql` 必須從 `drizzle-orm` 根 import。若不加會 TS 報 `Cannot find name 'sql'`。

- [ ] 1.5 型別檢查（不碰 DB，純編譯）。**這一步同時驗證 1.2–1.4 改動語法正確、沒有破壞既有型別匯出**：

```bash
bunx astro check 2>&1 | tail -20
```

預期輸出（重點是 schema 相關 0 error；專案他處若有既存 warning 與本模組無關，可忽略，但**不得新增 error**）：

```
Result (XXX files):
- 0 errors
- N warnings (pre-existing, unrelated to src/db/schema.ts)
```

若出現 `src/db/schema.ts` 相關 error（例如 `Cannot find name 'sql'`、`Property 'where' does not exist`），回到 1.3/1.4 修正。

> 備案：若環境 `astro check` 太慢或拉起 Cloudflare proxy，可改用純 TS 編譯探針：
> ```bash
> bunx tsc --noEmit --skipLibCheck src/db/schema.ts 2>&1 | grep -i "schema.ts" || echo "schema.ts type-clean"
> ```
> 預期：`schema.ts type-clean`。

- [ ] 1.6 commit（只含 schema.ts；遷移 SQL 在下一個 commit，方便回溯）。

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git add src/db/schema.ts
git commit -m "$(cat <<'EOF'
feat(db): add seasons.shipping_config + admin_users.reset_token* to schema (V6 §4)

Drizzle type source only; the migration SQL is hand-written separately
(drizzle metadata is frozen at 0002, so db:generate would emit a destructive
redo of the whole V5.2 migration — see plan P3-migrations §0.2).

- seasons.shipping_config TEXT NOT NULL DEFAULT '{"type":"flat","fee_twd":150}'
- admin_users.reset_token TEXT (nullable) + reset_token_expires_at TEXT (nullable)
- partial unique index admin_users_reset_token_unique WHERE reset_token IS NOT NULL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

預期輸出：`1 file changed`，列出 `src/db/schema.ts`。

---

## Task 2 — 手寫遷移檔 `drizzle/0007_v6_shipping_config_and_reset_token.sql`

**Files**
- Create: `drizzle/0007_v6_shipping_config_and_reset_token.sql`

> **不要**跑 `bun run db:generate`（理由見 §0.2）。直接手寫，比照 `drizzle/0003_seasons_and_groups.sql` 的 header 註解 + `--> statement-breakpoint` 風格。

### Steps

- [ ] 2.1 重新確認既有遷移檔的「語句分隔」慣例：每個 DDL 之間用一行 `--> statement-breakpoint`（見 `drizzle/0001_modern_sway.sql`、`drizzle/0003_seasons_and_groups.sql`）。wrangler 會把整個檔當一系列語句送 D1；breakpoint 是 drizzle 慣例分隔符，wrangler/D1 容忍它（既有 0003~0005 已用此格式成功套用）。

- [ ] 2.2 建立檔案，完整內容如下（逐字）：

```sql
-- V6 Migration 0007: per-season shipping_config + admin password-reset token columns
--
-- Pure additive DDL (ADD COLUMN + one partial unique index). No table rebuild, no FK change,
-- no data movement. Non-destructive: existing rows keep working; shipping_config backfills to
-- the flat-$150 default so no existing order total changes.
--
-- HAND-WRITTEN (not `drizzle-kit generate`). Drizzle's snapshot metadata is frozen at 0002
-- (pre-V5.2); running generate here would diff against the old schema and emit a destructive
-- "redo the whole V5.2 migration". This file follows the same hand-authored pattern as
-- 0003..0006. See docs/superpowers/plans/v6/P3-migrations.md §0.2.
--
-- Apply via:  wrangler d1 migrations apply <db> --remote   (tracks applied files by filename
--             in D1's d1_migrations table — independent of drizzle/meta/_journal.json).
--
-- Idempotency note: SQLite `ALTER TABLE ADD COLUMN` is NOT guarded by IF NOT EXISTS (no such
-- syntax). If this file partially applied and you must re-run, first inspect the table with
-- `PRAGMA table_info(...)` and hand-skip the columns that already exist. The partial unique
-- index IS guarded with IF NOT EXISTS.

-- 1. seasons.shipping_config — per-season shipping rule, JSON string.
--    Default keeps pre-existing seasons on the old flat $150 fee (back-compat).
ALTER TABLE `seasons` ADD `shipping_config` text DEFAULT '{"type":"flat","fee_twd":150}' NOT NULL;
--> statement-breakpoint

-- 2. admin_users.reset_token — single-use forgot-password token (nullable).
ALTER TABLE `admin_users` ADD `reset_token` text;
--> statement-breakpoint

-- 3. admin_users.reset_token_expires_at — UTC ISO-8601 Z; 30-min TTL set by request-reset.
ALTER TABLE `admin_users` ADD `reset_token_expires_at` text;
--> statement-breakpoint

-- 4. Partial unique index: many NULLs allowed; a non-null reset_token must be unique.
--    Same partial-index shape as seasons_active_singleton (D1 SQLite parser support verified).
CREATE UNIQUE INDEX IF NOT EXISTS `admin_users_reset_token_unique` ON `admin_users` (`reset_token`) WHERE `reset_token` IS NOT NULL;
```

> 細節對齊：`ADD \`col\` text DEFAULT '...' NOT NULL` 的順序（DEFAULT 在 NOT NULL 前）比照 drizzle 生成風格（見 `0003` 表內欄位的 `DEFAULT 0 NOT NULL`）。雖然此處是 `ALTER ... ADD` 而非建表，SQLite 接受同樣的 `DEFAULT <const> NOT NULL` 子句。

- [ ] 2.3 確認檔案結尾沒有多餘尾巴（最後一行就是 `CREATE UNIQUE INDEX ... ;`，**不要**在它後面再加 `--> statement-breakpoint`，比照 `0003` 最後一句 INSERT 後不加分隔符）。

---

## Task 3 — 靜態自檢遷移 SQL（不碰任何資料庫）

**Files**
- Test（檢核，無新增測試檔）：對 `drizzle/0007_*.sql` 做結構性自檢；對全專案再跑一次型別檢查確保 Task 1+2 一致。

> 本步驟是「TDD 的驗證關卡」：在套用到任何 DB 前，先用可重複的指令確認檔案結構正確、欄位數對、語句數對。

### Steps

- [ ] 3.1 確認檔案存在且為 4 個 DDL 語句（3 個 ADD + 1 個 CREATE INDEX）。用 grep 計數（**不是** cat，符合工具規範）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
echo "ADD COLUMN count:"; grep -c '^ALTER TABLE' drizzle/0007_v6_shipping_config_and_reset_token.sql
echo "CREATE INDEX count:"; grep -c '^CREATE UNIQUE INDEX' drizzle/0007_v6_shipping_config_and_reset_token.sql
echo "statement-breakpoint count:"; grep -c 'statement-breakpoint' drizzle/0007_v6_shipping_config_and_reset_token.sql
```

預期輸出：

```
ADD COLUMN count:
3
CREATE INDEX count:
1
statement-breakpoint count:
3
```

（3 個 ALTER + 1 個 CREATE INDEX = 4 語句，語句間 3 個 breakpoint。）

- [ ] 3.2 確認三個目標欄位名與 default 字串都在檔案內（防打錯欄位名）：

```bash
grep -E 'shipping_config|reset_token_expires_at|reset_token`|admin_users_reset_token_unique' drizzle/0007_v6_shipping_config_and_reset_token.sql
```

預期：輸出**至少 4 行**，分別含 `shipping_config`、`reset_token`、`reset_token_expires_at`、`admin_users_reset_token_unique`，且 `shipping_config` 那行含 `'{"type":"flat","fee_twd":150}'` 與 `NOT NULL`。

- [ ] 3.3 確認 default JSON 字串「逐字正確」（單引號內、雙引號 key、無多餘空白），避免和共用契約不一致。精確比對：

```bash
grep -F "DEFAULT '{\"type\":\"flat\",\"fee_twd\":150}' NOT NULL" drizzle/0007_v6_shipping_config_and_reset_token.sql && echo "default-json OK"
```

預期最後一行：`default-json OK`。若無輸出，回 Task 2.2 修正 default 字串（多半是空白或引號錯）。

- [ ] 3.4 再跑一次全專案型別檢查，確認 Task 1 的 schema 改動仍乾淨（與 1.5 相同指令，作為「改完 SQL 後」的回歸關卡）：

```bash
bunx astro check 2>&1 | tail -5
```

預期：`0 errors`（warning 若為既存則可接受，不得新增）。

- [ ] 3.5 commit 遷移檔。

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git add drizzle/0007_v6_shipping_config_and_reset_token.sql
git commit -m "$(cat <<'EOF'
feat(db): hand-written migration 0007 — shipping_config + reset_token columns (V6 §4)

Additive ADD COLUMN x3 + partial unique index. Non-destructive; shipping_config
defaults to flat $150 so no existing order total changes. Hand-authored (not
db:generate) because drizzle metadata is frozen at 0002 — see plan §0.2.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

預期輸出：`1 file changed`，列出 `drizzle/0007_v6_shipping_config_and_reset_token.sql`。

---

## Task 4 — 遷移前 prod 備份（硬性，spec §8/§4.2）

**Files**
- 無檔案改動；產生 `backups/mango-YYYYMMDD.sqlite`（`backups/` 已被 gitignore 慣例排除，不進版控）。

> 即使是非破壞性 ADD COLUMN，spec 風險表明文要求遷移前備份 prod。先備份再碰任何 stage/prod 遷移狀態。

### Steps

- [ ] 4.1 確認已登入 wrangler（遷移與備份都需要）：

```bash
bunx wrangler whoami 2>&1 | tail -5
```

預期：顯示已登入的帳號 email / account（若顯示未登入，先 `bunx wrangler login` 或設 `CLOUDFLARE_API_TOKEN`，再回到本步）。

- [ ] 4.2 執行 prod 備份（用 package script，命名含日期）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bun run db:export:prod
```

預期：在 `backups/` 產生 `mango-<今天日期>.sqlite`，wrangler 輸出類似 `Database exported ... -> backups/mango-20260606.sqlite`。

- [ ] 4.3 驗證備份檔非空（>0 bytes）：

```bash
ls -la /Users/rayhsu/Projects/Github/mango-hsu/backups/mango-*.sqlite | tail -1
```

預期：列出今天的備份檔，size 明顯大於 0（prod 有資料，通常數十 KB 以上）。若 size 為 0 或檔案不存在，**停手回報**——不要在沒有有效備份的情況下繼續。

---

## Task 5 — 套用到 **stage** 並驗證

**Files**
- 無檔案改動；變更發生在 stage D1（`mango-hsu-stage`）。

> 開發階段只動 stage。prod 套用見 Task 6（上線時才執行）。

### Steps

- [ ] 5.1 **套用前**先看 wrangler 認為哪些遷移未套用（§0.3 的安全關卡）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx wrangler d1 migrations list mango-hsu-stage --env stage --remote 2>&1 | tail -20
```

預期：**只列出 `0007_v6_shipping_config_and_reset_token.sql` 一個未套用檔**（0003~0006 應顯示為已套用 / 不在未套用清單）。

> ⛔ 若清單包含 `0003`/`0004`/`0005`/`0006`，代表這台 stage D1 的遷移追蹤狀態與「V5.2 已上線」的事實不符。**停手、回報總編**，不要 apply（硬套會嘗試重做 V5.2，撞既有物件）。

- [ ] 5.2 套用遷移到 stage（用 package script）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bun run db:migrate:stage
```

（等同 `wrangler d1 migrations apply mango-hsu-stage --remote --env stage`。）
預期：wrangler 列出將套用 `0007_v6_shipping_config_and_reset_token.sql`，逐句執行成功，結尾類似 `Executed N commands / Migrations applied successfully`，**0 errors**。

> 若這裡才報 `duplicate column name: shipping_config` 之類，代表欄位已存在（曾部分套用）。此時跳到 5.3 直接驗證現況即可，不需重跑（ADD COLUMN 無 IF NOT EXISTS，重跑會炸；以驗證結果為準）。

- [ ] 5.3 驗證 `seasons.shipping_config` 欄位存在、型別 TEXT、`NOT NULL`、default 正確（用 `PRAGMA table_info`）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json \
  --command "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('seasons') WHERE name='shipping_config';" 2>&1 | tail -20
```

預期 JSON `results` 內含一列，大致：

```json
[ { "name": "shipping_config", "type": "TEXT", "notnull": 1, "dflt_value": "'{\"type\":\"flat\",\"fee_twd\":150}'" } ]
```

重點：`type` = `TEXT`、`notnull` = `1`、`dflt_value` 是那串 flat JSON（外層帶 SQLite 回傳的單引號）。

- [ ] 5.4 驗證**既有 seasons row 已回填 default**（V5.2 在 stage 種了 `2026` season，加欄位後它應自動帶 flat default，不是 NULL）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json \
  --command "SELECT code, shipping_config FROM seasons ORDER BY id;" 2>&1 | tail -20
```

預期：每一列的 `shipping_config` 都等於 `{"type":"flat","fee_twd":150}`（**非 NULL**）。特別確認 `code='2026'` 那列。

- [ ] 5.5 驗證 `admin_users` 兩個新欄位存在且 nullable（`notnull=0`、無 default）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json \
  --command "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('admin_users') WHERE name IN ('reset_token','reset_token_expires_at') ORDER BY name;" 2>&1 | tail -20
```

預期 `results` 含兩列：

```json
[
  { "name": "reset_token", "type": "TEXT", "notnull": 0, "dflt_value": null },
  { "name": "reset_token_expires_at", "type": "TEXT", "notnull": 0, "dflt_value": null }
]
```

- [ ] 5.6 驗證 partial unique index 存在：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json \
  --command "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='admin_users_reset_token_unique';" 2>&1 | tail -20
```

預期 `results` 一列，`sql` 含 `CREATE UNIQUE INDEX` 且帶 `WHERE \`reset_token\` IS NOT NULL`（或 `WHERE reset_token IS NOT NULL`，視 D1 回傳格式）。

- [ ] 5.7 **功能性驗證 partial unique index 真的生效**（多個 NULL 可共存、同一非 NULL token 互斥）。用 stage 的測試前綴帳號做最小探針，跑完即清。**完整指令序列**：

  - [ ] 5.7a 插入兩個 reset_token 為 NULL 的測試帳號 → 應成功（NULL 不受 unique 約束）：

  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu
  bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json --command \
  "INSERT INTO admin_users (email, password_hash, role, must_change_password, created_at) VALUES ('test-reset-a@example.com','x','operator',1,'2026-06-06T00:00:00.000Z'),('test-reset-b@example.com','x','operator',1,'2026-06-06T00:00:00.000Z');" 2>&1 | tail -5
  ```

  預期：成功（`"success": true`，2 rows written）。**證明多個 NULL token 不互斥。**

  - [ ] 5.7b 給 a 設一個 token → 成功；再給 b 設**同一個** token → 應**失敗（UNIQUE 約束）**：

  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu
  echo "--- set token on A (expect success) ---"
  bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json --command \
  "UPDATE admin_users SET reset_token='dup-token-xyz' WHERE email='test-reset-a@example.com';" 2>&1 | tail -3
  echo "--- set SAME token on B (expect UNIQUE failure) ---"
  bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json --command \
  "UPDATE admin_users SET reset_token='dup-token-xyz' WHERE email='test-reset-b@example.com';" 2>&1 | tail -5
  ```

  預期：第一個 UPDATE 成功；第二個 UPDATE **失敗**，錯誤訊息含 `UNIQUE constraint failed: admin_users.reset_token`（或 D1 等價訊息）。**這證明 partial unique index 對非 NULL 值生效。**

  - [ ] 5.7c 清掉探針帳號（只刪 `test-` 前綴 email，符合測試資料慣例）：

  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu
  bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json --command \
  "DELETE FROM admin_users WHERE email IN ('test-reset-a@example.com','test-reset-b@example.com');" 2>&1 | tail -3
  ```

  預期：成功，2 rows 刪除。

  - [ ] 5.7d 確認已清乾淨（防止殘留污染後續測試）：

  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu
  bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json --command \
  "SELECT COUNT(*) AS n FROM admin_users WHERE email LIKE 'test-reset-%';" 2>&1 | tail -5
  ```

  預期：`results` 顯示 `n: 0`。

- [ ] 5.8 跑既有測試套件作回歸（確認加欄位沒打到既有讀 `seasons`/`admin_users` 的路徑）。**需要 stage env**（CLAUDE.md「Testing」段）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev \
TEST_TOKEN="<stage ORDER_TOKEN，不是 prod 的>" \
bun test tests/seasons.test.ts 2>&1 | tail -25
```

預期：`tests/seasons.test.ts` 全 pass（它驗 active-singleton partial index 與 season/group 唯一性；加欄位後這些不變式不該破）。
> 若沒有 stage 整合 env，至少跑純單元確保 schema 改動沒讓任何 import 鏈崩潰：
> ```bash
> bun test tests/stock-helper.test.ts tests/items-hash.test.ts 2>&1 | tail -15
> ```
> 預期：全 pass（這些不 import `_setup.ts`，純單元，不需 stage）。

---

## Task 6 —（上線時才執行）prod 套用 + 收尾

**Files**
- 無檔案改動；變更發生在 prod D1（`mango-hsu-prod`）。

> ⚠️ **本 Task 屬 V6「一次合併上線」階段（spec §9 第 8 步）。開發/測試階段不要跑 prod。** 這裡先把現成、可照抄的指令與預期輸出寫好，上線時直接執行。執行前提：Task 4 的 prod 備份已存在於 `backups/`。

### Steps（上線日執行）

- [ ] 6.1（上線日）再次確認 prod 備份是當天的：

```bash
ls -la /Users/rayhsu/Projects/Github/mango-hsu/backups/mango-$(date +%Y%m%d).sqlite 2>&1
```

預期：列出當天備份檔且 size > 0。若不是當天的，重跑 `bun run db:export:prod`（Task 4.2）。

- [ ] 6.2（上線日）prod 套用前先看未套用清單（同 §0.3 安全關卡，prod 版）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx wrangler d1 migrations list mango-hsu-prod --remote 2>&1 | tail -20
```

預期：**只列出 `0007_v6_shipping_config_and_reset_token.sql`**。若含 0003~0006，**停手回報**。

- [ ] 6.3（上線日）套用到 prod：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bun run db:migrate:prod
```

（等同 `wrangler d1 migrations apply mango-hsu-prod --remote`。）
預期：套用 `0007_*.sql` 成功，0 errors。

- [ ] 6.4（上線日）prod 驗證（重跑 5.3/5.4/5.5/5.6 的查詢，但 DB 改成 `mango-hsu-prod`、去掉 `--env stage`）。逐一確認：
  - `seasons.shipping_config`：TEXT / notnull=1 / default 為 flat JSON。
  - 既有 prod season（如 `2026`）`shipping_config` 已回填、非 NULL。
  - `admin_users.reset_token` / `reset_token_expires_at`：TEXT / notnull=0 / default NULL。
  - `admin_users_reset_token_unique` index 存在。

  範例（shipping_config 欄位）：

  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu
  bunx wrangler d1 execute mango-hsu-prod --remote --json \
    --command "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('seasons') WHERE name='shipping_config';" 2>&1 | tail -10
  ```

  預期：同 5.3（type=TEXT、notnull=1、dflt_value 為 flat JSON）。

  > prod **不做** 5.7 的「插假帳號」破壞性探針（避免污染 prod admin_users）——index 結構驗證（5.6 等價查詢）已足夠；功能性互斥已在 stage 證明。

- [ ] 6.5（上線日，可選）prod 套用後跑庫存對帳，確認加欄位沒副作用（CLAUDE.md「部署後跑 reconcile」慣例；本遷移不碰 stock，預期 0 drift）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bun run scripts/reconcile-stock.ts --env prod 2>&1 | tail -15
```

預期：每群組 `SUM(deltas) == stock_fen`，退出碼 0、無 drift。

> 本模組到此完成。schema.ts（Task 1）與遷移檔（Task 3）的 commit 已在前面各自完成；Task 4/5/6 是執行性步驟，無新 commit（除非過程中需修正 SQL，則修正後重走 Task 3.5 commit）。

---

## 驗收清單（本模組「完成」定義）

- [ ] `src/db/schema.ts`：`seasons.shipping_config`（notNull + flat default）、`admin_users.reset_token` / `reset_token_expires_at`（nullable）、`admin_users_reset_token_unique` partial unique index 皆已定義；`bunx astro check` 0 error。
- [ ] `drizzle/0007_v6_shipping_config_and_reset_token.sql`：手寫、3 ADD COLUMN + 1 partial unique index、default JSON 逐字正確。
- [ ] 已用 `db:export:prod` 取得遷移前 prod 備份（Task 4）。
- [ ] stage 已套用且通過 5.3–5.7 全部驗證（欄位/型別/default/index/功能性互斥）；既有測試回歸 pass。
- [ ] prod 套用指令與驗證步驟已備妥（Task 6），標記為「V6 整批上線時執行」。
- [ ] 全程**未**呼叫 `db:generate`；**未**改 `drizzle/meta/`。

---

## 重要 open concerns（留給總編）

1. **`drizzle/meta/` 故意不更新**：本模組沿用 0003~0006 的做法，不把 0007 寫進 `_journal.json` 也不產 snapshot。好處是和現況一致、不需動 metadata；壞處是 drizzle 的 generate 基準持續停在 0002，未來任何人誤跑 `db:generate` 都會產出災難 SQL。**建議總編層級決定**：要不要在 V6 之後安排一個獨立「metadata 重設」任務（重新 introspect 現行 DB 產生新 baseline snapshot），把這個地雷一次拆掉。本模組不擅自做，因為那會影響全 schema、超出「加 4 欄位」範圍。
2. **prod 套用時機**：本計畫把 prod apply 鎖在「V6 整批上線」。但運費（§5.5）與忘記密碼（§5.6）模組在 prod 上線時都依賴這些欄位存在——上線編排需保證「0007 先於那兩個模組的 worker code 部署」。若 V6 決定拆批上線（spec §10 提到可能拆「地基+運費」批），0007 必須隨第一個用到欄位的批一起上 prod。
3. **編號 0007 vs deferred 0006**：deferred 的 `0006_drop_old_stock_column.sql` 尚未套用（它要等 prod 穩定 ≥5 天）。本模組用 0007 跳過 0006。若日後 deferred 0006 真的套用，兩者檔名不衝突、wrangler 各自獨立追蹤，無問題；但 reviewer 應知道「0006 是 deferred、0007 是本模組」的編號跳號是刻意的。
4. **`db:migrate:stage` 的 `--env stage` 與 migrations_dir**：stage migrate script 帶 `--env stage`，wrangler 會讀 `env.stage.d1_databases[].migrations_dir`（= `drizzle`，與頂層一致），所以 0007 會被掃到。已確認 wrangler.jsonc stage 區塊有設 `migrations_dir: "drizzle"`，無需改動 wrangler.jsonc。
