# P7 — 後台忘記密碼（Telegram 重設管道）

> 模組：V6 §5.6（後台忘記密碼）。對應 spec：`docs/superpowers/specs/2026-06-06-v6-admin-selfservice-design.md` §5.6、§6（跨切面安全/稽核）、§7（測試計畫「忘記密碼」列）。
> 依賴：**P3 遷移**（`docs/superpowers/plans/v6/P3-migrations.md`）——本模組讀寫 `admin_users.reset_token` / `admin_users.reset_token_expires_at` 兩個欄位與 `admin_users_reset_token_unique` partial unique index。**P3 的 schema 改動與 stage 遷移必須先落地**，否則本模組的 TS 型別（`AdminUser` 缺欄位）與 stage 整合測試（欄位不存在）都會炸。
> 上線：與 V6 整批一次合併（spec §9 第 8 步）。本計畫做到 stage 驗證為止；prod 套用隨整批走。

---

## 0. 給「對本 codebase 零 context 的工程師」的關鍵背景（**先讀完再動手**）

這段不是廢話。本模組碰「登入態以外可達的後台頁」與「真正會發 Telegram 的 API」，搞錯安全細節會開後門。**讀完再開始 Task 1。**

### 0.1 中介層（middleware）會把 `/admin/**` 全部擋去登入頁 —— 但只放行 `/admin/login` 一條

`src/middleware.ts:30-48` 的邏輯：

```ts
const isAdmin = url.pathname.startsWith("/admin");
const isLogin = url.pathname === "/admin/login";
if (!isAdmin || isLogin) return applySecurityHeaders(await next());
const token = ctx.cookies.get(SESSION_COOKIE)?.value;
if (!token) return applySecurityHeaders(ctx.redirect("/admin/login"));
```

→ 任何 `/admin/xxx` 在**沒有 session cookie 時會被 302 導去 `/admin/login`**，唯一例外是**完全等於** `/admin/login` 的路徑。

**本模組新增的兩頁 `src/pages/admin/forgot-password.astro` 與 `src/pages/admin/reset-password.astro` 必須在登出狀態可達**（忘記密碼的人本來就沒登入）。所以**必須改 middleware 把這兩條路徑也放行**。這是本模組唯一需要動的既有 production 檔（spec §5.6 說「登出可達」但沒明寫要改 middleware；這是落地該需求的必要動作）。Task 6 處理，並在 `open_concerns` 標給總編。

> 為什麼 API 路徑（`/api/admin/auth/request-reset`）不受影響：middleware 的 `isAdmin` 是 `startsWith("/admin")`，**`/api/admin/...` 不以 `/admin` 開頭**（以 `/api` 開頭），所以 API 路徑本來就不被 middleware 攔。`/api/admin/**` 的授權是各 endpoint 自己呼叫 `authorizeAdmin()`——而 request-reset / reset-submit **刻意不要求 session**（忘記密碼者沒 session），改用 `requireSameOrigin()` 擋跨站 + rate limit 擋濫用。詳見各 Task。

### 0.2 token 存「雜湊」不存「明文」（安全設計，務必照做）

P3 的 `admin_users.reset_token` 欄位，本模組**存 token 的 SHA-256 hex 雜湊，不存明文**。明文 token 只出現在「送進店主 Telegram 的重設連結」裡，伺服器端永不落地明文。

- request-reset：`crypto.getRandomValues` 產 32-byte 隨機 → hex 成明文 token `t`（放進 Telegram 連結 `?token=t`）；DB 只存 `sha256Hex(t)`。
- reset（GET 驗證 / POST 改密）：拿到 `?token=t`，算 `sha256Hex(t)`，用**雜湊**去 `WHERE reset_token = ?` 查 admin。
- 好處：DB 備份外洩（`db:export:prod`）或 SQL injection 讀到 `reset_token` 欄位，也無法反推明文 token 去冒用連結（SHA-256 單向）。對齊密碼本身存 PBKDF2 雜湊的既有設計理念。
- P3 的 partial unique index `admin_users_reset_token_unique`（`WHERE reset_token IS NOT NULL`）對「雜湊值」一樣生效（雜湊唯一），不需改 P3。

> 為什麼 token 雜湊用 SHA-256 而非 PBKDF2：reset token 是 **128-bit 高熵隨機值**（非人選密碼），無字典/暴力風險，單次 SHA-256 即足夠且快（避免在 Workers 10ms CPU cap 內多花 PBKDF2 的 6ms）。密碼本身仍用 PBKDF2（`auth.ts:57` `hashPassword`），因為密碼是低熵人選值。

### 0.3 Telegram 既有零件：只有「訂單通知」一個函式，要新增一個「通用推送」

`src/lib/telegram.ts` 目前只有 `notifyOrder(env, db, order, items)`——它的訊息格式寫死訂單欄位，**不能直接拿來推重設連結**。本模組**新增一個通用函式** `sendTelegramMessage(env, text)`（同一組 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env、同一個 `sendMessage` API），**不重構** `notifyOrder`（避免動到上線中的下單通知路徑）。fire-and-forget 失敗時回傳 boolean，由呼叫端決定是否寫 audit。

### 0.4 「防 email 列舉」= 無論 email 是否存在，request-reset 都回**完全一致**的回應

spec §5.6：「無論 email 是否存在都回一致訊息（『若該帳號存在，已發送連結』）」。所以 request-reset endpoint：

- email 存在 → 產 token、存 DB、推 Telegram、audit `password_reset_requested`，回 200 `{ ok: true }`。
- email 不存在 → **不**產 token、**不**推 Telegram、audit `password_reset_failed`（記 `reason: "unknown_email"`，供店主事後察覺有人亂試），但**對外回完全相同的 200 `{ ok: true }`**。
- rate limit 命中 → 一樣回 200 `{ ok: true }`（不可用 429 洩漏「這個 email 被試過很多次 = 存在」），但 audit `password_reset_failed`（`reason: "rate_limited"`）且**不**推 Telegram。

> 關鍵：對外回應與時間都不可隨「email 是否存在」而變。login.astro 已用 `DUMMY_HASH` 做時間等化（`login.astro:21-22`）；request-reset 不跑 PBKDF2（不驗密碼），時間差主要來自「有沒有發 Telegram」。為避免「存在 → 多一個 Telegram round-trip → 變慢」洩漏，**Telegram push 用 fire-and-forget（不 await 在回應路徑上）**——見 Task 4 用 `ctx.locals.runtime?.ctx?.waitUntil` 或直接不 await 並吞錯。本計畫採「不 await + catch」最簡單且與 `notifyOrder` 經由 `ctx.waitUntil()` fire-and-forget 的既有風格一致。

### 0.5 reset token TTL = 30 分鐘；成功改密要「清 token + 刪該用戶全部 session」

- TTL：`reset_token_expires_at = now + 30min`（UTC ISO-8601 Z）。GET 驗證頁與 POST 改密都要檢查 `expires_at > now`，過期一律拒。
- 成功改密後（比照 `change-password.ts:65-72` 模式）：
  1. `UPDATE admin_users SET password_hash=?, must_change_password=0, reset_token=NULL, reset_token_expires_at=NULL WHERE email=?`（同時清掉 token，使連結一次性失效）。
  2. `DELETE FROM sessions WHERE user_email=?`（踢掉該用戶所有舊 session——若攻擊者用舊密碼登入過，這裡一併登出）。
  3. audit `password_reset_success`。
  4. **不**自動建新 session（與 change-password 不同：忘記密碼者本來就沒登入，改完導去 `/admin/login` 讓他用新密碼登入，較直覺也較安全）。

### 0.6 新增的 audit actions（共用契約，全 V6 一致）

- `password_reset_requested`：request-reset 對「存在的 email」成功發出連結時寫。`details {email}`。
- `password_reset_failed`：request-reset 對「不存在 email / rate-limited / 缺欄位」時寫；reset-submit 對「token 無效/過期/密碼不合規」時寫。`details {reason, email?}`。`reason ∈ {unknown_email, rate_limited, missing_email, invalid_token, expired_token, weak_password, password_same_as_token_user_unknown}`（實際用到的子集見各 Task）。
- `password_reset_success`：reset-submit 成功改密時寫。`details {email, rotated: true}`。

> audit 寫法：比照 `change-password.ts:53-58, 74-79` 的 `env.DB.prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?,?,?,?)").bind(...).run()`（原生 prepare，不經 drizzle）。`season_id` 欄位不填（nullable，這些是帳號層事件、非季節層）。`order_id` 同理不填。

### 0.7 rate limit：3/hour/email，新增一個 KV bucket

spec §5.6：「rate limit `3/hour/email`」。`src/lib/rate-limit.ts` 現有多個 bucket（`checkLoginEmailRate` 等，`:54-64`）。本模組**新增** `checkResetRequestRate(env, email)`：KV key `rl:reset:<email-lowercase>`、limit 3、window 3600s，完全比照 `checkLoginEmailRate` 結構。

> 為什麼按 email 而非 IP：忘記密碼的攻擊面是「對特定帳號連發騷擾店主 Telegram」，按 email 限流最對症（同 login 的 email 層）。IP 層在此非必要（spec 只要 email 層），不加（YAGNI）。

---

## 共用契約（與其他 V6 模組一致）

- **授權/CSRF**：request-reset 與 reset-submit 都**不要求 session**（忘記密碼者沒 session），但都**必須** `requireSameOrigin(request)`（`src/lib/csrf.ts`）擋跨站 POST。這是它們與其它 `/api/admin/**`（走 `authorizeAdmin()`）的刻意差異。
- **時間戳**：所有 `created_at` / `expires_at` / audit `ts` 都是 UTC ISO-8601 帶 `Z`（`new Date(...).toISOString()`）。
- **不碰庫存路徑**：本模組完全不動 `stock_fen` / intake / products batch。
- **新 audit actions**：`password_reset_requested` / `password_reset_failed` / `password_reset_success`（見 §0.6）。
- **reset_token 存雜湊**（§0.2）。

---

## 檔案總覽（本模組新增/修改）

| 動作 | 路徑 | 說明 |
|---|---|---|
| Modify | `src/lib/auth.ts` | 新增 `sha256Hex()` + `generateResetToken()`（純函式，TDD 單元測試） |
| Modify | `src/lib/rate-limit.ts` | 新增 `checkResetRequestRate()`（3/hr/email） |
| Modify | `src/lib/telegram.ts` | 新增通用 `sendTelegramMessage(env, text)` |
| Create | `src/pages/api/admin/auth/request-reset.ts` | POST：產 token、存 DB、推 Telegram、列舉一致回應、audit |
| Create | `src/pages/api/admin/auth/reset-password.ts` | POST：驗 token、改密、清 token、刪 session、audit |
| Create | `src/pages/admin/forgot-password.astro` | email 輸入頁（登出可達） |
| Create | `src/pages/admin/reset-password.astro` | GET 驗 token + 新密碼表單（登出可達） |
| Modify | `src/middleware.ts` | 放行 forgot-password / reset-password 兩條路徑 |
| Modify | `src/pages/admin/login.astro` | 加「忘記密碼？」連結 |
| Create | `tests/auth-reset-helper.test.ts` | 純單元：`sha256Hex` / `generateResetToken` |
| Create | `tests/password-reset.test.ts` | stage 整合：request-reset + reset-password 全流程 |
| Modify | `tests/_setup.ts` | 新增 reset 測試用 helper（種有真 hash 的 admin、讀 reset 欄位、清 `rl:reset:*`） |

> **依賴 P3**：`admin_users.reset_token` / `reset_token_expires_at` 欄位與 index 由 P3 在 schema.ts + `drizzle/0007_*.sql` 提供並已套用到 stage。本計畫所有讀寫這兩欄位的 Task 假設 P3 已完成。Task 1 第一步會驗證這個前提。

---

## Task 列表總覽

1. **Task 1** — 前置驗證 P3 已落地（schema 型別 + stage 欄位存在）。
2. **Task 2** — `src/lib/auth.ts`：新增 `sha256Hex()` + `generateResetToken()`（TDD 純單元）。
3. **Task 3** — `src/lib/rate-limit.ts`：新增 `checkResetRequestRate()`；`src/lib/telegram.ts`：新增 `sendTelegramMessage()`。
4. **Task 4** — `POST /api/admin/auth/request-reset`（TDD stage 整合：列舉一致、rate limit、token 雜湊落地）。
5. **Task 5** — `POST /api/admin/auth/reset-password`（TDD stage 整合：過期拒絕、成功改密+清 session+清 token）。
6. **Task 6** — middleware 放行兩條路徑 + 兩個 .astro 頁面 + login 連結（含手動驗證）。
7. **Task 7** — 全量回歸 + 收尾。

> 每個 code step 給完整 code；每個 test step 給完整 test code；每個指令給預期輸出。bite-sized：單步 2–5 分鐘。先寫失敗測試 → 跑驗證 FAIL → 最小實作 → 跑驗證 PASS → commit。

---

## Task 1 — 前置驗證 P3 已落地

**Files**
- 無改動（純驗證）。

> 本模組整個建立在 P3 的兩個欄位上。動手前先確認 P3 已合進當前分支且 stage 已套用 0007，避免後面 Task 卡在「欄位不存在」。

### Steps

- [ ] 1.1 確認 `src/db/schema.ts` 的 `admin_users` 已有 reset 欄位（P3 Task 1 產物）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
grep -n "reset_token" src/db/schema.ts
```

預期：至少 3 行命中——`reset_token: text("reset_token")`、`reset_token_expires_at: text(...)`、partial unique index `admin_users_reset_token_unique`。
> ⛔ 若 0 行命中：P3 的 schema 改動尚未進當前分支。**停手，先完成/合入 P3 Task 1**，再回本模組。

- [ ] 1.2 確認 stage D1 已有欄位（P3 Task 5 產物）。需 wrangler 登入：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx wrangler d1 execute mango-hsu-stage --env stage --remote --json \
  --command "SELECT name FROM pragma_table_info('admin_users') WHERE name IN ('reset_token','reset_token_expires_at') ORDER BY name;" 2>&1 | tail -10
```

預期 `results` 含兩列：`reset_token`、`reset_token_expires_at`。
> ⛔ 若少於兩列：stage 尚未套用 0007。**先跑 P3 Task 5（`bun run db:migrate:stage`）**，再回本模組。

- [ ] 1.3 確認分支正確（在 V6 feature 分支上，非 main 直接改）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git branch --show-current
```

預期：`feature/v6-admin-selfservice`（或總編指定的 V6 分支）。若在 `main`，先切到 V6 分支再繼續（**不在 main 直接改 production code**）。

---

## Task 2 — `auth.ts`：`sha256Hex()` + `generateResetToken()`（TDD 純單元）

**Files**
- Modify: `src/lib/auth.ts`（在現有 `bytesToHex`（`:33-35`）之後、`hashPassword`（`:57`）之前插入；新增 export）
- Test: `tests/auth-reset-helper.test.ts`（新）

> 這兩個是純函式（不碰 DB / env），所以是**純單元測試**（不 import `_setup.ts`，不需 stage env），放 `tests/*.test.ts`，比照 `tests/stock-helper.test.ts` 風格。

### Steps

- [ ] 2.1 先寫失敗測試。建立 `tests/auth-reset-helper.test.ts`，完整內容：

```ts
// Pure-unit tests (no env): reset-token helpers in src/lib/auth.ts.
// sha256Hex must be deterministic + 64 hex chars; generateResetToken must yield
// a 64-hex-char opaque token whose hash differs from the plaintext.
import { describe, expect, it } from "bun:test";
import { sha256Hex, generateResetToken } from "../src/lib/auth";

describe("sha256Hex", () => {
  it("returns 64 lowercase hex chars", async () => {
    const h = await sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 of 'abc'", async () => {
    // Canonical SHA-256("abc") test vector.
    const h = await sha256Hex("abc");
    expect(h).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic (same input → same hash)", async () => {
    const a = await sha256Hex("the-same-token");
    const b = await sha256Hex("the-same-token");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await sha256Hex("token-a");
    const b = await sha256Hex("token-b");
    expect(a).not.toBe(b);
  });
});

describe("generateResetToken", () => {
  it("returns a 64-hex-char plaintext token and its sha256 hash", async () => {
    const { token, hash } = await generateResetToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes → 64 hex
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // hash must be sha256Hex(token), NOT the token itself (we store the hash).
    expect(hash).not.toBe(token);
    expect(hash).toBe(await sha256Hex(token));
  });

  it("produces unique tokens across calls", async () => {
    const a = await generateResetToken();
    const b = await generateResetToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});
```

- [ ] 2.2 跑測試，確認 **FAIL**（函式還不存在）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bun test tests/auth-reset-helper.test.ts 2>&1 | tail -20
```

預期 FAIL，錯誤類似 `error: export 'sha256Hex' not found in '../src/lib/auth'`（或 import 解析失敗 / `is not a function`）。**這就是預期的紅燈。**

- [ ] 2.3 最小實作。在 `src/lib/auth.ts` 的 `bytesToHex`（結束於 `:35`）之後、`async function pbkdf2`（`:37`）之前，插入以下兩個 export 函式：

```ts
// --- V6 forgot-password reset-token helpers ---
// We store the SHA-256 hash of the reset token in admin_users.reset_token, never the
// plaintext. The plaintext only travels inside the Telegram reset link. A leaked DB backup
// therefore can't be used to forge a reset (SHA-256 is one-way). The token itself is a
// 128-bit random value (not a low-entropy human password), so a single SHA-256 is sufficient
// — no PBKDF2 stretching needed (and it keeps us well under the Workers 10ms CPU cap).
export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtle.digest("SHA-256", enc.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

// Generate an opaque single-use reset token. Returns BOTH the plaintext (goes in the link)
// and its SHA-256 hash (stored in the DB column). 32 random bytes → 64 hex chars.
export async function generateResetToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(bytes);
  const hash = await sha256Hex(token);
  return { token, hash };
}
```

> 說明：`subtle`（`:17`）與 `enc`（`:18`）與 `bytesToHex`（`:33`）都已在 `auth.ts` 既有頂層宣告，直接複用，不需新 import。

- [ ] 2.4 跑測試，確認 **PASS**：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bun test tests/auth-reset-helper.test.ts 2>&1 | tail -15
```

預期：`6 pass`、`0 fail`（兩個 describe 共 6 個 it）。

- [ ] 2.5 型別檢查（確認沒破壞 auth.ts 既有匯出）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx tsc --noEmit --skipLibCheck src/lib/auth.ts 2>&1 | grep -i "auth.ts" || echo "auth.ts type-clean"
```

預期最後一行：`auth.ts type-clean`。

- [ ] 2.6 commit：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git add src/lib/auth.ts tests/auth-reset-helper.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): add sha256Hex + generateResetToken helpers for password reset (V6 §5.6)

Reset tokens are stored as their SHA-256 hash (never plaintext); the plaintext
only travels in the Telegram reset link. 32-byte random token → 64 hex chars.
Pure-unit tested (SHA-256("abc") test vector, determinism, uniqueness).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

預期：`2 files changed`（1 modified, 1 new）。

---

## Task 3 — `rate-limit.ts` 新 bucket + `telegram.ts` 通用推送

**Files**
- Modify: `src/lib/rate-limit.ts`（在 `checkLoginEmailRate`（結束於 `:64`）之後插入）
- Modify: `src/lib/telegram.ts`（在檔尾、`notifyOrder` 之後新增 export）

> 這兩個是 endpoint 的零件，先單獨做好並型別檢查，Task 4/5 直接組裝。Telegram 與 rate-limit 真正生效在 stage 整合測試（Task 4）才驗，這裡先確保編譯與簽名正確。

### Steps

- [ ] 3.1 在 `src/lib/rate-limit.ts` 的 `checkLoginEmailRate` 函式（`:54-64`）之後、`const PUBLIC_STATUS_LIMIT`（`:66`）之前，插入：

```ts
// /admin/forgot-password → request-reset throttle. 3 requests per hour per email.
// Per-email (not per-IP): the abuse vector is spamming a specific admin's Telegram with
// reset links; the email layer is the on-target control (spec §5.6). Limit-hit still returns
// the same generic 200 to the client (never 429 — that would leak email existence); the
// endpoint just skips sending and audits password_reset_failed{reason:rate_limited}.
const RESET_REQUEST_LIMIT = 3;
const RESET_REQUEST_WINDOW_SECONDS = 60 * 60;

export async function checkResetRequestRate(env: AppEnv, email: string): Promise<boolean> {
  const key = `rl:reset:${email.toLowerCase()}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= RESET_REQUEST_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: RESET_REQUEST_WINDOW_SECONDS,
  });
  return true;
}
```

- [ ] 3.2 在 `src/lib/telegram.ts` 檔尾（`notifyOrder` 結束的 `}` 之後）新增通用推送函式：

```ts

// V6 §5.6: generic Telegram push (forgot-password reset link, future alerts). Reuses the same
// bot token + chat id as order notifications but with an arbitrary message body. Does NOT touch
// notifyOrder (the live order-notification path stays untouched). Fire-and-forget friendly:
// returns true on a 2xx send, false on misconfig/error — the caller decides whether to audit.
// IMPORTANT: callers on a latency-sensitive path (request-reset) must NOT await this inside the
// response path (it would leak email-existence via timing); kick it off and ignore the promise.
export async function sendTelegramMessage(env: AppEnv, text: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

> 說明：`AppEnv` 型別已在 `telegram.ts:1` import（`import type { AppEnv, Db } from "../db/client";`），直接複用，不需新 import。

- [ ] 3.3 型別檢查兩檔：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx tsc --noEmit --skipLibCheck src/lib/rate-limit.ts src/lib/telegram.ts 2>&1 | grep -iE "rate-limit.ts|telegram.ts" || echo "rate-limit + telegram type-clean"
```

預期最後一行：`rate-limit + telegram type-clean`。

- [ ] 3.4 commit：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git add src/lib/rate-limit.ts src/lib/telegram.ts
git commit -m "$(cat <<'EOF'
feat(auth): add reset-request rate bucket + generic Telegram push (V6 §5.6)

- checkResetRequestRate: 3/hour/email (rl:reset:<email>), mirrors checkLoginEmailRate
- sendTelegramMessage: generic push reusing the order bot/chat; notifyOrder untouched

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

預期：`2 files changed`。

---

## Task 4 — `POST /api/admin/auth/request-reset`（TDD stage 整合）

**Files**
- Create: `src/pages/api/admin/auth/request-reset.ts`
- Modify: `tests/_setup.ts`（新增 reset 測試 helper）
- Test: `tests/password-reset.test.ts`（新；本 Task 先放 request-reset 段，Task 5 再補 reset-submit 段）

> 這是會真正寫 DB（`admin_users.reset_token`）與發 Telegram 的 endpoint。整合測試打 stage worker（比照 `admin-idempotency.test.ts`）。**先寫測試 → 看它 FAIL（endpoint 404）→ 實作 → PASS。**

### Steps — 先擴充 `_setup.ts` helper（測試要用）

- [ ] 4.1 在 `tests/_setup.ts` 檔尾（`skipIfNoIntegration`（`:343-345`）之後）新增以下 helper：

```ts

// --- V6 §5.6 forgot-password test helpers ---

// Seed an admin_users row whose email is a test-prefixed address ('%@local' so cleanupTestAdmin
// removes it) with a REAL pbkdf2 hash for `password`. Used by reset tests that must verify
// login works with the NEW password after a successful reset. password_hash is computed locally
// via the same auth helper the app uses.
import { hashPassword } from "../src/lib/auth";

export async function seedAdminUser(opts: {
  email: string;
  password: string;
  role?: "admin" | "operator";
}): Promise<void> {
  if (!opts.email.endsWith("@local")) {
    throw new Error(`seedAdminUser: email must end with "@local" (got "${opts.email}")`);
  }
  const hash = await hashPassword(opts.password);
  const role = opts.role ?? "admin";
  const now = new Date().toISOString();
  d1Execute(
    `INSERT OR REPLACE INTO admin_users (email, password_hash, role, must_change_password, created_at)
     VALUES ('${opts.email}', '${hash}', '${role}', 0, '${now}')`,
  );
}

// Read the stored reset_token (hash) + expiry for an admin. Returns nulls if unset.
export function getResetTokenRow(email: string): {
  reset_token: string | null;
  reset_token_expires_at: string | null;
} {
  const rows = d1Execute(
    `SELECT reset_token, reset_token_expires_at FROM admin_users WHERE email = '${email}'`,
  ) as Array<{ reset_token: string | null; reset_token_expires_at: string | null }>;
  if (rows.length === 0) throw new Error(`getResetTokenRow: no admin ${email}`);
  return rows[0]!;
}

// Directly set an admin's reset_token (hash) + expiry — lets reset-submit tests install a known
// token (and an EXPIRED one) without going through request-reset (which would push Telegram).
export function setResetToken(
  email: string,
  tokenHash: string | null,
  expiresAt: string | null,
): void {
  const tk = tokenHash === null ? "NULL" : `'${tokenHash}'`;
  const ex = expiresAt === null ? "NULL" : `'${expiresAt}'`;
  d1Execute(
    `UPDATE admin_users SET reset_token = ${tk}, reset_token_expires_at = ${ex} WHERE email = '${email}'`,
  );
}

// Read an admin's current password_hash (to assert it CHANGED after a reset).
export function getAdminPasswordHash(email: string): string {
  const rows = d1Execute(
    `SELECT password_hash FROM admin_users WHERE email = '${email}'`,
  ) as Array<{ password_hash: string }>;
  if (rows.length === 0) throw new Error(`getAdminPasswordHash: no admin ${email}`);
  return rows[0]!.password_hash;
}

// Count live sessions for an admin (to assert reset wiped them).
export function countSessions(email: string): number {
  const rows = d1Execute(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_email = '${email}'`,
  ) as Array<{ n: number }>;
  return rows[0]!.n;
}

// Insert a session row for an admin (to assert reset deletes it). Token is test-prefixed.
export function seedSessionFor(email: string): string {
  const token = `test-sess-${crypto.randomUUID()}`;
  const expires = new Date(Date.now() + 3600_000).toISOString();
  d1Execute(
    `INSERT INTO sessions (token, user_email, expires_at) VALUES ('${token}', '${email}', '${expires}')`,
  );
  return token;
}

// Wipe rl:reset:* KV keys between reset tests (1-hour TTL is far slower than test traffic; the
// 3/hr/email limit would otherwise carry across test cases). Mirrors clearOrderRateLimit.
export function clearResetRateLimit() {
  const list = spawnSync(
    "bunx",
    [
      "wrangler",
      "kv",
      "key",
      "list",
      "--binding=RATELIMIT",
      "--env=stage",
      "--remote",
      "--prefix=rl:reset:",
    ],
    { encoding: "utf-8" },
  );
  if (list.status !== 0) return;
  let keys: Array<{ name: string }>;
  try {
    keys = JSON.parse(list.stdout);
  } catch {
    return;
  }
  for (const { name } of keys) {
    spawnSync(
      "bunx",
      [
        "wrangler",
        "kv",
        "key",
        "delete",
        name,
        "--binding=RATELIMIT",
        "--env=stage",
        "--remote",
      ],
      { encoding: "utf-8" },
    );
  }
}
```

> 註：`hashPassword` 從 `../src/lib/auth` import 是安全的——它只用 WebCrypto `subtle`（Bun 有原生實作），不碰 Cloudflare 專屬 binding，故可在 bun test 進程（非 worker）內直接跑。`spawnSync` 已在 `_setup.ts:18` import。`crypto.randomUUID()` 在 Bun 全域可用（`createTestAdminSession` 已用，`:323`）。

- [ ] 4.2 型別檢查 `_setup.ts`（確認新 helper 與 import 無誤）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx tsc --noEmit --skipLibCheck tests/_setup.ts 2>&1 | grep -i "_setup.ts" || echo "_setup type-clean"
```

預期最後一行：`_setup type-clean`。

### Steps — 寫 request-reset 整合測試（先 FAIL）

- [ ] 4.3 建立 `tests/password-reset.test.ts`，**本 Task 先放 request-reset 段**（Task 5 會 append reset-submit 段到同檔）。完整內容：

```ts
// V6 §5.6 forgot-password (Telegram channel) — stage integration.
// request-reset: enumeration-consistent response, 3/hr/email rate limit, token hash persisted.
// reset-password (Task 5) appended below.
//
// NOTE: request-reset pushes Telegram for EXISTING emails. On stage, TELEGRAM_* secrets point
// at a test/throwaway chat (or are unset). The endpoint is fire-and-forget on the push, so the
// HTTP response + DB writes are deterministic regardless of whether the push lands; these tests
// assert ONLY the response + DB state (reset_token hash) + audit, never Telegram delivery.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  clearResetRateLimit,
  getResetTokenRow,
  seedAdminUser,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const ADMIN_EMAIL = "test-reset-admin@local";
const UNKNOWN_EMAIL = "test-reset-nobody@local";

beforeEach(async () => {
  if (SKIP) return;
  cleanupTestAdmin();
  cleanupTestData();
  clearResetRateLimit();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestAdmin();
  cleanupTestData();
  clearResetRateLimit();
});

async function requestReset(email: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/auth/request-reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL, // pass requireSameOrigin
      ...extraHeaders,
    },
    body: JSON.stringify({ email }),
  });
}

describe("V6 request-reset: enumeration consistency", () => {
  it("returns identical 200 {ok:true} for existing AND unknown email", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });

    const rExisting = await requestReset(ADMIN_EMAIL);
    const rUnknown = await requestReset(UNKNOWN_EMAIL);

    expect(rExisting.status).toBe(200);
    expect(rUnknown.status).toBe(200);
    const bExisting = (await rExisting.json()) as { ok: boolean };
    const bUnknown = (await rUnknown.json()) as { ok: boolean };
    expect(bExisting).toEqual({ ok: true });
    expect(bUnknown).toEqual({ ok: true });
  });

  it("persists a reset_token HASH (not plaintext) for an existing email", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });

    const before = getResetTokenRow(ADMIN_EMAIL);
    expect(before.reset_token).toBeNull();

    const r = await requestReset(ADMIN_EMAIL);
    expect(r.status).toBe(200);

    const after = getResetTokenRow(ADMIN_EMAIL);
    // Stored value is a 64-hex sha256 hash, and an expiry ~30 min out was set.
    expect(after.reset_token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.reset_token_expires_at).not.toBeNull();
    const ttlMs = new Date(after.reset_token_expires_at!).getTime() - Date.now();
    // 30-min TTL, allow generous slack for clock + round-trip (25..35 min).
    expect(ttlMs).toBeGreaterThan(25 * 60_000);
    expect(ttlMs).toBeLessThan(35 * 60_000);
  });

  it("does NOT set a token for an unknown email", async () => {
    if (SKIP) return;
    // No seedAdminUser for UNKNOWN_EMAIL → row doesn't exist; just assert the response is 200
    // and nothing blew up. (No row to inspect; absence is the point.)
    const r = await requestReset(UNKNOWN_EMAIL);
    expect(r.status).toBe(200);
    expect((await r.json())).toEqual({ ok: true });
  });

  it("rejects cross-origin POST (missing/foreign Origin) with 403", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    // Foreign Origin → requireSameOrigin fails.
    const r = await fetch(`${STAGE_URL}/api/admin/auth/request-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
      body: JSON.stringify({ email: ADMIN_EMAIL }),
    });
    expect(r.status).toBe(403);
    // And no token was set despite a valid email (CSRF blocked before any work).
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBeNull();
  });
});

describe("V6 request-reset: rate limit 3/hr/email", () => {
  it("4th request within the window still returns 200 but stops sending (enumeration-safe)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });

    // 3 allowed
    for (let i = 0; i < 3; i++) {
      const r = await requestReset(ADMIN_EMAIL);
      expect(r.status).toBe(200);
    }
    // 4th: limit hit. Must STILL be 200 {ok:true} (never 429 — that leaks existence).
    const r4 = await requestReset(ADMIN_EMAIL);
    expect(r4.status).toBe(200);
    expect((await r4.json())).toEqual({ ok: true });
  });
});
```

- [ ] 4.4 跑測試，確認 **FAIL**（endpoint 還不存在 → 404，期望 200/403 落空）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev \
TEST_TOKEN="<stage ORDER_TOKEN，非 prod>" \
bun test tests/password-reset.test.ts 2>&1 | tail -30
```

預期 FAIL：多數案例 `expect(received).toBe(200)` 收到 `404`（endpoint 不存在）。**這是預期紅燈。**
> 若顯示 `Skipping non-unit tests`（缺 stage env），代表沒設 `MANGO_STAGE_URL`/`TEST_TOKEN`——補上再跑（CLAUDE.md「Testing」段）。

### Steps — 實作 request-reset endpoint（轉綠）

- [ ] 4.5 建立 `src/pages/api/admin/auth/request-reset.ts`，完整內容：

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { generateResetToken } from "../../../../lib/auth";
import { checkResetRequestRate } from "../../../../lib/rate-limit";
import { sendTelegramMessage } from "../../../../lib/telegram";

// V6 §5.6 — forgot-password request endpoint (Telegram channel).
//
// Auth model: NO session required (the user forgot their password). Defenses are:
//   1. requireSameOrigin() — block cross-site POSTs.
//   2. checkResetRequestRate() — 3/hour/email throttle.
//   3. Enumeration consistency — ALWAYS respond 200 {ok:true}, whether or not the email exists
//      or the rate limit tripped. Existence/rate-limit signals go to audit_log only, never to
//      the client (and never as a 429, which would itself leak existence).
//
// Token handling: generateResetToken() returns plaintext (→ Telegram link only) + sha256 hash
// (→ stored in admin_users.reset_token). TTL 30 min. The Telegram push is fire-and-forget and
// is NOT awaited on the response path (awaiting it would make "email exists" measurably slower
// and leak existence via timing).
const RESET_TTL_MS = 30 * 60_000;

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();

  // Generic success response reused on every branch below (enumeration consistency).
  const ok = () => json({ ok: true });

  if (!email) {
    await audit("password_reset_failed", "<unknown>", { reason: "missing_email" });
    return ok();
  }

  // Rate limit (per-email). Limit hit → still 200, but don't touch DB or Telegram.
  if (!(await checkResetRequestRate(env, email))) {
    await audit("password_reset_failed", email, { reason: "rate_limited" });
    return ok();
  }

  const db = makeDb(env);
  const rows = await db
    .select({ email: admin_users.email })
    .from(admin_users)
    .where(eq(admin_users.email, email))
    .limit(1);
  const user = rows[0];

  if (!user) {
    // Unknown email: audit (so the owner can notice probing) but respond identically.
    await audit("password_reset_failed", email, { reason: "unknown_email" });
    return ok();
  }

  // Existing email: mint token, store HASH + 30-min expiry, push link to Telegram.
  const { token, hash } = await generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

  await db
    .update(admin_users)
    .set({ reset_token: hash, reset_token_expires_at: expiresAt })
    .where(eq(admin_users.email, email));

  await audit("password_reset_requested", email, { email });

  // Build absolute reset link from the request origin (same pattern as mark-shipped.ts:84).
  const origin = new URL(request.url).origin;
  const link = `${origin}/admin/reset-password?token=${token}`;
  const msg = [
    "🔐 後台密碼重設",
    `帳號：${email}`,
    `重設連結（30 分鐘內有效，僅本人可用）：`,
    link,
    "若非你本人申請，請忽略本訊息並通知管理員。",
  ].join("\n");

  // Fire-and-forget: do NOT await on the response path (timing-leak guard). Swallow the promise;
  // sendTelegramMessage already catches its own errors and returns false.
  void sendTelegramMessage(env, msg);

  return ok();
};
```

> 為什麼 Telegram push 不寫「失敗則 audit」：若 await 它並依結果 audit，會把「email 存在 → 多一次網路 round-trip」的時間差洩漏出去（列舉攻擊）。spec §5.6 的列舉防護優先於「push 失敗可觀測性」。push 是否成功對店主而言「收不到連結就重按一次」即可，且 `sendTelegramMessage` 內部已吞錯。若未來要可觀測，應改用 `ctx.waitUntil()` 在回應送出後背景 audit（不在本模組範圍）。

- [ ] 4.6 跑 request-reset 測試，確認 **PASS**：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev \
TEST_TOKEN="<stage ORDER_TOKEN，非 prod>" \
bun test tests/password-reset.test.ts 2>&1 | tail -25
```

預期：request-reset 的兩個 describe 全 pass（6 個 it）。
> ⚠️ endpoint 改動需先部署到 stage 才會生效（stage worker 跑的是已部署版本，不是本機）。若測試仍 404，先把當前分支部署到 stage：見 Task 7 的「stage 部署」備註（`bun run deploy:stage`，注意 CLAUDE.md 的 token 規則）。本計畫假設整合測試在「endpoint 已部署到 stage」後跑——**這是 stage 整合測試的固有前提**（既有 `admin-idempotency` 等也是打已部署的 stage）。

- [ ] 4.7 commit：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git add src/pages/api/admin/auth/request-reset.ts tests/_setup.ts tests/password-reset.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): POST /api/admin/auth/request-reset — Telegram reset link (V6 §5.6)

No session required; defenses = requireSameOrigin + 3/hr/email rate limit +
enumeration-consistent 200 response (existence/rate-limit only in audit_log).
Stores sha256(token); plaintext only in the Telegram link. 30-min TTL.
Telegram push is fire-and-forget (timing-leak guard). Audits requested/failed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

預期：`3 files changed`（1 new endpoint, _setup modified, 1 new test）。

---

## Task 5 — `POST /api/admin/auth/reset-password`（TDD stage 整合）

**Files**
- Create: `src/pages/api/admin/auth/reset-password.ts`
- Test: `tests/password-reset.test.ts`（append reset-submit 段）

> 改密 endpoint：拿 `?token=` 的明文、雜湊後查 admin、驗未過期、驗新密碼 12+、PBKDF2 改密、清 token、刪該用戶全部 session、audit。**先 append 測試 → FAIL → 實作 → PASS。**

### Steps — append reset-submit 測試（先 FAIL）

- [ ] 5.1 在 `tests/password-reset.test.ts` **檔尾 append** 以下內容（同檔，沿用上方 import；新增需要的 helper import——把檔案頂部的 import 區塊補上 `sha256Hex`、`generateResetToken`、`setResetToken`、`getAdminPasswordHash`、`countSessions`、`seedSessionFor`、`getResetTokenRow`）：

  首先，**修改檔案頂部 import**，把 Task 4.3 的 import 區塊換成下面這份（多 import 幾個 helper + auth 純函式）：

```ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  clearResetRateLimit,
  getResetTokenRow,
  getAdminPasswordHash,
  countSessions,
  seedSessionFor,
  setResetToken,
  seedAdminUser,
  skipIfNoIntegration,
} from "./_setup";
import { sha256Hex, generateResetToken } from "../src/lib/auth";
```

  然後在**檔尾** append：

```ts

async function submitReset(token: string, newPassword: string): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/auth/reset-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL, // pass requireSameOrigin
    },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

describe("V6 reset-password: token validation", () => {
  it("rejects an unknown token with 400 and audits invalid_token", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    // A well-formed but never-issued token.
    const r = await submitReset("deadbeef".repeat(8), "brand-new-password-9");
    expect(r.status).toBe(400);
  });

  it("rejects an EXPIRED token with 400 and leaves the password unchanged", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);

    // Install a known token whose expiry is in the PAST.
    const { token, hash } = await generateResetToken();
    const past = new Date(Date.now() - 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, past);

    const r = await submitReset(token, "brand-new-password-9");
    expect(r.status).toBe(400);
    // Password untouched.
    expect(getAdminPasswordHash(ADMIN_EMAIL)).toBe(hashBefore);
  });

  it("rejects a too-short new password (min 12) with 400", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const r = await submitReset(token, "short");
    expect(r.status).toBe(400);
    // Token NOT consumed on a validation failure (user can retry with a longer password).
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBe(hash);
  });
});

describe("V6 reset-password: successful reset", () => {
  it("changes password, clears token, wipes sessions, and audits success", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);

    // Pre-existing sessions for this user (should be wiped by the reset).
    seedSessionFor(ADMIN_EMAIL);
    seedSessionFor(ADMIN_EMAIL);
    expect(countSessions(ADMIN_EMAIL)).toBe(2);

    // Install a valid (future-expiry) token.
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const r = await submitReset(token, "a-fresh-strong-password");
    expect(r.status).toBe(200);
    expect((await r.json())).toEqual({ ok: true });

    // Password hash changed.
    expect(getAdminPasswordHash(ADMIN_EMAIL)).not.toBe(hashBefore);
    // Token cleared (link is now single-use / dead).
    const row = getResetTokenRow(ADMIN_EMAIL);
    expect(row.reset_token).toBeNull();
    expect(row.reset_token_expires_at).toBeNull();
    // All sessions wiped.
    expect(countSessions(ADMIN_EMAIL)).toBe(0);
  });

  it("a consumed token cannot be reused (second submit fails 400)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const r1 = await submitReset(token, "first-new-password-12");
    expect(r1.status).toBe(200);
    // Reuse the same plaintext token → token already cleared → not found → 400.
    const r2 = await submitReset(token, "second-new-password-12");
    expect(r2.status).toBe(400);
  });

  it("the new password actually works at /admin/login (end-to-end)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const newPw = "login-after-reset-pw";
    expect((await submitReset(token, newPw)).status).toBe(200);

    // Log in with the NEW password via the real login form POST.
    const form = new URLSearchParams();
    form.set("email", ADMIN_EMAIL);
    form.set("password", newPw);
    const login = await fetch(`${STAGE_URL}/admin/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: STAGE_URL,
      },
      body: form.toString(),
      redirect: "manual",
    });
    // Successful login → 302 redirect + Set-Cookie mh_session.
    expect(login.status).toBe(302);
    expect(login.headers.get("set-cookie") ?? "").toContain("mh_session=");
  });
});
```

> 註：`sha256Hex` 在 import 後雖未直接被斷言用到（測試用 `generateResetToken` 取得 `{token, hash}`），保留 import 不影響（若 lint 抱怨 unused，可在最後一個成功案例加一行 `expect(await sha256Hex(token)).toBe(hash)` 佐證一致性——非必要）。為避免 unused-import 噪音，下方 5.x 實作完成後若 `astro check` 報 `sha256Hex` unused，從 import 移除即可。

- [ ] 5.2 跑測試，確認 reset-submit 段 **FAIL**（endpoint 不存在 → 404）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev \
TEST_TOKEN="<stage ORDER_TOKEN，非 prod>" \
bun test tests/password-reset.test.ts -t "reset-password" 2>&1 | tail -30
```

預期 FAIL：reset-submit 案例 `expect(received).toBe(400/200)` 收到 `404`。**預期紅燈。**
（`-t "reset-password"` 只跑 describe 名含 `reset-password` 的段，加速反饋。）

### Steps — 實作 reset-password endpoint（轉綠）

- [ ] 5.3 建立 `src/pages/api/admin/auth/reset-password.ts`，完整內容：

```ts
import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users, sessions } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { hashPassword, sha256Hex } from "../../../../lib/auth";

// V6 §5.6 — forgot-password completion endpoint.
//
// Auth model: NO session required. Defenses = requireSameOrigin + possession of a valid,
// unexpired reset token (looked up by its sha256 hash). On success:
//   1. password_hash = pbkdf2(new password); must_change_password = false
//   2. reset_token + reset_token_expires_at cleared (link becomes single-use)
//   3. ALL sessions for the user deleted (kicks off any attacker holding the old password)
//   4. audit password_reset_success
// We do NOT mint a new session here (unlike change-password): the user wasn't logged in, so
// we send them to /admin/login to sign in with the new password (the client redirects).
//
// Password policy mirrors change-password.ts: 12-char min (NIST SP 800-63B floor), 200 max.

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  let body: { token?: string; new_password?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const token = String(body.token ?? "");
  const next = String(body.new_password ?? "");

  if (!token) {
    await audit("password_reset_failed", "<unknown>", { reason: "invalid_token" });
    return text("invalid or expired token", 400);
  }

  const db = makeDb(env);
  const tokenHash = await sha256Hex(token);

  // Look up the admin by the token HASH. (Plaintext token never stored.)
  const rows = await db
    .select({
      email: admin_users.email,
      reset_token_expires_at: admin_users.reset_token_expires_at,
    })
    .from(admin_users)
    .where(eq(admin_users.reset_token, tokenHash))
    .limit(1);
  const user = rows[0];

  if (!user) {
    await audit("password_reset_failed", "<unknown>", { reason: "invalid_token" });
    return text("invalid or expired token", 400);
  }

  // Expiry check.
  const exp = user.reset_token_expires_at;
  if (!exp || new Date(exp).getTime() < Date.now()) {
    await audit("password_reset_failed", user.email, { reason: "expired_token" });
    return text("invalid or expired token", 400);
  }

  // Password policy (mirror change-password.ts:34-38). Token is NOT consumed on a policy
  // failure so the user can retry the same link with a compliant password.
  if (next.length < 12) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too short (min 12)", 400);
  }
  if (next.length > 200) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too long", 400);
  }

  const newHash = await hashPassword(next);
  const now = new Date().toISOString();

  // Atomic-ish completion: update creds + clear token, then wipe sessions, then audit.
  // The UPDATE is guarded by `reset_token = tokenHash` so a concurrent second submit of the
  // same token (race) changes 0 rows on the loser (token already cleared) — see reuse test.
  await db
    .update(admin_users)
    .set({
      password_hash: newHash,
      must_change_password: false,
      reset_token: null,
      reset_token_expires_at: null,
    })
    .where(and(eq(admin_users.email, user.email), eq(admin_users.reset_token, tokenHash)));

  await db.delete(sessions).where(eq(sessions.user_email, user.email));

  await audit("password_reset_success", user.email, { email: user.email, rotated: true });

  return json({ ok: true });
};
```

> 並發備註：兩次同 token 同時送達時，兩個 request 都可能在「查到 user」階段看到 token 還在；但 UPDATE 帶 `WHERE reset_token = tokenHash`，第一個成功者把 token 清成 NULL，第二個 UPDATE 命中 0 row（不改密、不再清 session）。即便如此，第二個仍會 `delete sessions` + audit `success`——這是可接受的（密碼已被第一個改成同/不同值；session 被多刪一次無害）。reuse 測試（5.1）測的是「**先後**兩次」（非並發）：第一次清掉 token 後，第二次在「查 user」階段就 `!user` → 400，符合預期。

- [ ] 5.4 跑 reset-submit 測試，確認 **PASS**：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev \
TEST_TOKEN="<stage ORDER_TOKEN，非 prod>" \
bun test tests/password-reset.test.ts 2>&1 | tail -30
```

預期：整個 `tests/password-reset.test.ts` 全 pass（request-reset 6 + reset-password 7 = 13 個 it，視最終數）。
> 同 Task 4.6 備註：需先 `bun run deploy:stage` 把含 reset-password endpoint 的版本部署到 stage，整合測試才打得到。

- [ ] 5.5 commit：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git add src/pages/api/admin/auth/reset-password.ts tests/password-reset.test.ts
git commit -m "$(cat <<'EOF'
feat(auth): POST /api/admin/auth/reset-password — complete reset (V6 §5.6)

Looks up admin by sha256(token); rejects unknown/expired tokens; enforces 12+
password (mirrors change-password). On success: pbkdf2 rehash, clear token,
delete ALL user sessions, audit password_reset_success. No new session minted
(user re-logs in at /admin/login). UPDATE guarded by reset_token for race safety.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

預期：`2 files changed`。

---

## Task 6 — middleware 放行 + 兩個 .astro 頁 + login 連結

**Files**
- Modify: `src/middleware.ts`（`:33` 的 `isLogin` 判斷擴成放行三條 logged-out 可達路徑）
- Create: `src/pages/admin/forgot-password.astro`
- Create: `src/pages/admin/reset-password.astro`
- Modify: `src/pages/admin/login.astro`（表單下方加「忘記密碼？」連結）

> 前端頁面無自動化測試（專案慣例：.astro 頁靠手動/QA；API 已有整合測試覆蓋核心邏輯）。本 Task 以「型別檢查 + 手動驗證清單」收斂，並把 middleware 改動的安全影響講清楚。

### Steps — middleware 放行（**安全關鍵**）

- [ ] 6.1 確認 `src/middleware.ts` 現況（`:32-35`）：`isAdmin = startsWith("/admin")`、`isLogin = url.pathname === "/admin/login"`、`if (!isAdmin || isLogin) return ...next()`。

- [ ] 6.2 把 `isLogin` 那行（`src/middleware.ts:33`）擴成一個「logged-out 可達白名單」。將：

```ts
  const isAdmin = url.pathname.startsWith("/admin");
  const isLogin = url.pathname === "/admin/login";

  if (!isAdmin || isLogin) return applySecurityHeaders(await next());
```

改成：

```ts
  const isAdmin = url.pathname.startsWith("/admin");
  // Logged-out-reachable admin pages: login + the forgot/reset-password flow (V6 §5.6).
  // A user who forgot their password has no session, so these must bypass the auth gate.
  // Exact-match only (no startsWith) so nothing else under /admin/ is accidentally exposed.
  const PUBLIC_ADMIN_PATHS = new Set([
    "/admin/login",
    "/admin/forgot-password",
    "/admin/reset-password",
  ]);

  if (!isAdmin || PUBLIC_ADMIN_PATHS.has(url.pathname)) {
    return applySecurityHeaders(await next());
  }
```

> 安全說明：用 `Set.has(exact pathname)`（非 `startsWith`）放行，確保只有這三條精確路徑可在登出時存取，其餘 `/admin/**` 仍被 gate。`reset-password` 頁本身不靠 session——它靠 query `?token=` + 後端 endpoint 的雜湊比對驗身，所以「登出可達」不構成越權（沒有有效 token 就只看到錯誤訊息）。

- [ ] 6.3 型別檢查 middleware：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx tsc --noEmit --skipLibCheck src/middleware.ts 2>&1 | grep -i "middleware.ts" || echo "middleware type-clean"
```

預期最後一行：`middleware type-clean`。

### Steps — forgot-password 頁

- [ ] 6.4 建立 `src/pages/admin/forgot-password.astro`，完整內容（沿用 `change-password.astro` 的 client-side fetch + 訊息框風格；POST 到 request-reset，永遠顯示一致成功訊息）：

```astro
---
import Layout from "../../layouts/Layout.astro";
// Logged-out reachable (middleware PUBLIC_ADMIN_PATHS). No session, no server-side work here —
// the form POSTs to /api/admin/auth/request-reset, which is enumeration-consistent.
---

<Layout title="忘記密碼">
  <main class="mx-auto max-w-sm px-4 py-12">
    <h1 class="mb-2 text-2xl font-bold">忘記密碼</h1>
    <p class="mb-6 text-sm text-gray-600">
      輸入你的後台電子信箱。若該帳號存在，系統會把「重設密碼連結」推送到店家的 Telegram，30 分鐘內有效。
    </p>

    <div id="msg" class="mb-4 hidden rounded px-3 py-2 text-sm"></div>

    <form id="form" class="space-y-4">
      <div>
        <label for="email" class="block text-sm font-medium mb-1">電子信箱</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autocomplete="username"
          class="w-full rounded border border-gray-300 px-3 py-2 text-base"
        />
      </div>
      <button
        type="submit"
        class="w-full rounded bg-orange-600 px-4 py-3 text-base font-medium text-white hover:bg-orange-700"
      >
        發送重設連結
      </button>
    </form>

    <p class="mt-6 text-center text-sm">
      <a href="/admin/login" class="text-gray-600 underline">返回登入</a>
    </p>
  </main>

  <script>
    const form = document.getElementById("form") as HTMLFormElement;
    const msg = document.getElementById("msg") as HTMLDivElement;

    function showMsg(text: string, kind: "ok" | "err") {
      msg.textContent = text;
      msg.className =
        "mb-4 rounded px-3 py-2 text-sm " +
        (kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700");
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const email = String(fd.get("email") ?? "").trim();
      if (!email) {
        showMsg("請輸入電子信箱。", "err");
        return;
      }
      try {
        const res = await fetch("/api/admin/auth/request-reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        // Enumeration-consistent: the API returns 200 {ok:true} regardless. Show the same
        // message whether or not the account exists.
        if (res.ok) {
          showMsg("若該帳號存在，重設連結已發送到店家 Telegram，請查收（30 分鐘內有效）。", "ok");
          (form.querySelector("button[type=submit]") as HTMLButtonElement).disabled = true;
        } else {
          showMsg("發送失敗，請稍後再試。", "err");
        }
      } catch {
        showMsg("發送失敗，請稍後再試。", "err");
      }
    });
  </script>
</Layout>
```

### Steps — reset-password 頁

- [ ] 6.5 建立 `src/pages/admin/reset-password.astro`，完整內容。GET 時讀 `?token=`，但**不在伺服器端查 DB 驗 token**（避免 SSR 路徑也要碰 reset_token；驗證交給 POST endpoint，前端僅檢查「有無 token query」決定顯示表單或錯誤）；POST 由前端 fetch 到 reset-password endpoint：

```astro
---
import Layout from "../../layouts/Layout.astro";
// Logged-out reachable (middleware PUBLIC_ADMIN_PATHS). The token's real validity is checked
// server-side by POST /api/admin/auth/reset-password (hash lookup + expiry). Here we only read
// the ?token= query to decide whether to render the form; an absent token shows guidance.
const url = new URL(Astro.request.url);
const token = url.searchParams.get("token") ?? "";
const hasToken = token.length > 0;
---

<Layout title="重設密碼">
  <main class="mx-auto max-w-sm px-4 py-12">
    <h1 class="mb-2 text-2xl font-bold">重設密碼</h1>

    {hasToken ? (
      <>
        <p class="mb-6 text-sm text-gray-600">請設定新密碼（至少 12 個字）。完成後請用新密碼登入。</p>

        <div id="msg" class="mb-4 hidden rounded px-3 py-2 text-sm"></div>

        <form id="form" class="space-y-4" data-token={token}>
          <div>
            <label for="new" class="block text-sm font-medium mb-1">新密碼（至少 12 字元）</label>
            <input
              id="new"
              name="new_password"
              type="password"
              required
              minlength="12"
              autocomplete="new-password"
              class="w-full rounded border border-gray-300 px-3 py-2 text-base"
            />
          </div>
          <div>
            <label for="confirm" class="block text-sm font-medium mb-1">再輸入一次新密碼</label>
            <input
              id="confirm"
              name="confirm_password"
              type="password"
              required
              minlength="12"
              autocomplete="new-password"
              class="w-full rounded border border-gray-300 px-3 py-2 text-base"
            />
          </div>
          <button
            type="submit"
            class="w-full rounded bg-orange-600 px-4 py-3 text-base font-medium text-white hover:bg-orange-700"
          >
            設定新密碼
          </button>
        </form>
      </>
    ) : (
      <div class="rounded bg-amber-50 px-3 py-3 text-sm text-amber-800">
        連結無效或缺少參數。請從店家 Telegram 重新點選重設連結，或
        <a href="/admin/forgot-password" class="underline">重新申請</a>。
      </div>
    )}

    <p class="mt-6 text-center text-sm">
      <a href="/admin/login" class="text-gray-600 underline">返回登入</a>
    </p>
  </main>

  <script>
    const form = document.getElementById("form") as HTMLFormElement | null;
    const msg = document.getElementById("msg") as HTMLDivElement | null;
    if (form && msg) {
      const token = form.dataset.token ?? "";

      function showMsg(text: string, kind: "ok" | "err") {
        msg!.textContent = text;
        msg!.className =
          "mb-4 rounded px-3 py-2 text-sm " +
          (kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700");
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form!);
        const nw = String(fd.get("new_password") ?? "");
        const cf = String(fd.get("confirm_password") ?? "");
        if (nw !== cf) {
          showMsg("兩次新密碼不一致。", "err");
          return;
        }
        if (nw.length < 12) {
          showMsg("新密碼至少 12 個字。", "err");
          return;
        }
        try {
          const res = await fetch("/api/admin/auth/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, new_password: nw }),
          });
          if (res.ok) {
            showMsg("密碼已重設，2 秒後前往登入頁⋯", "ok");
            (form!.querySelector("button[type=submit]") as HTMLButtonElement).disabled = true;
            setTimeout(() => (location.href = "/admin/login"), 2000);
          } else {
            showMsg("重設失敗：" + (await res.text()), "err");
          }
        } catch {
          showMsg("重設失敗，請稍後再試。", "err");
        }
      });
    }
  </script>
</Layout>
```

### Steps — login 頁加連結

- [ ] 6.6 在 `src/pages/admin/login.astro` 的登入 `<form>` 結束 `</form>`（`:141`）之後、`</main>`（`:142`）之前，插入「忘記密碼？」連結：

```astro
    <p class="mt-6 text-center text-sm">
      <a href="/admin/forgot-password" class="text-gray-600 underline">忘記密碼？</a>
    </p>
```

> 對齊：插入點在現有 `</form>` 與 `</main>` 之間。`login.astro` 現況 `</form>` 在 `:141`、`</main>` 在 `:142`。改後 login 頁底部結構為「登入按鈕表單 → 忘記密碼連結 → main 結束」。

- [ ] 6.7 全專案型別檢查（涵蓋三個 .astro + middleware；`.astro` 頁的 client `<script>` 也會被 astro check 檢）：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx astro check 2>&1 | tail -15
```

預期：`0 errors`（既存 warning 與本模組無關者可接受，**不得新增 error**）。若報 `tests/password-reset.test.ts` 內 `sha256Hex` unused，回 Task 5.1 從 import 移除（或加一行斷言使用它）。

- [ ] 6.8 **手動驗證清單**（需先 `bun run deploy:stage` 部署當前分支到 stage；CLAUDE.md token 規則：deploy 前確認 active `PUBLIC_ORDER_TOKEN` == stage `ORDER_TOKEN`）。逐項在 stage 上點過：

  - [ ] 6.8a 登出狀態直接開 `https://mango-hsu-stage.rhsu.workers.dev/admin/forgot-password` → **應顯示 email 表單**（不被導去 login）。證明 middleware 放行生效。
  - [ ] 6.8b 登出狀態開 `/admin/reset-password`（無 token）→ 顯示「連結無效或缺少參數」黃框。
  - [ ] 6.8c 登出狀態開 `/admin/reset-password?token=abc`（亂 token）→ 顯示新密碼表單；送出 → 紅字「重設失敗：invalid or expired token」。
  - [ ] 6.8d login 頁 `/admin/login` 底部 → 出現「忘記密碼？」連結，點擊到 forgot-password 頁。
  - [ ] 6.8e 登出狀態開**其它** `/admin/xxx`（如 `/admin/orders`）→ 仍被導去 `/admin/login`（證明白名單是精確匹配、沒放行過頭）。
  - [ ] 6.8f （端到端，可選但建議）在 forgot-password 輸入一個 stage 上真實存在的 admin email（非 `@local` 測試帳號，用店主自己的測試帳號）→ 檢查 stage Telegram chat 是否收到含 `…/admin/reset-password?token=…` 的訊息 → 點該連結 → 設新密碼 → 用新密碼登入成功。

  > 6.8f 涉及真實 Telegram + 真實 admin，建議用一個專為測試建立的 stage admin（之後可刪），避免動到店主正式帳號。若 stage 的 `TELEGRAM_*` secret 指向 throwaway chat，這步可在該 chat 觀察。

- [ ] 6.9 commit：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git add src/middleware.ts src/pages/admin/forgot-password.astro src/pages/admin/reset-password.astro src/pages/admin/login.astro
git commit -m "$(cat <<'EOF'
feat(admin): forgot/reset-password pages + login link; middleware allowlist (V6 §5.6)

- middleware: exact-match allowlist exposes /admin/forgot-password + /admin/reset-password
  to logged-out users (alongside /admin/login); everything else under /admin stays gated.
- forgot-password.astro: email form → request-reset (enumeration-consistent UI message).
- reset-password.astro: reads ?token=, renders new-password form (12+), posts to reset-password.
- login.astro: "忘記密碼？" link to the forgot-password page.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

預期：`4 files changed`（2 new pages, middleware + login modified）。

---

## Task 7 — 全量回歸 + 收尾

**Files**
- 無新增改動（驗證 + 可能的小修）。

### Steps

- [ ] 7.1 跑全部純單元（不需 stage），確認沒打到既有：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bun test tests/auth-reset-helper.test.ts tests/stock-helper.test.ts tests/items-hash.test.ts tests/csp.test.ts tests/deploy-token-guard.test.ts 2>&1 | tail -15
```

預期：全 pass。

- [ ] 7.2 跑本模組 stage 整合 + 一個既有 admin 整合（確認 `_setup.ts` 改動沒破壞既有 helper 使用者）。需 stage env，且當前分支已部署到 stage：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev \
TEST_TOKEN="<stage ORDER_TOKEN，非 prod>" \
bun test tests/password-reset.test.ts tests/admin-idempotency.test.ts 2>&1 | tail -30
```

預期：`tests/password-reset.test.ts` 全 pass；`tests/admin-idempotency.test.ts` 仍全 pass（`_setup.ts` 新增 helper 屬純增量，不改既有 export，故既有測試不受影響）。

- [ ] 7.3 全專案最終型別檢查：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
bunx astro check 2>&1 | tail -10
```

預期：`0 errors`。

- [ ] 7.4 確認本模組未碰禁區（庫存 intake / products batch / wrangler.jsonc / package.json / schema.ts）。`schema.ts` 由 P3 改、本模組不應再動它：

```bash
cd /Users/rayhsu/Projects/Github/mango-hsu
git diff --name-only $(git merge-base HEAD main)..HEAD -- src/db/schema.ts drizzle/ wrangler.jsonc package.json src/pages/api/admin/product-groups/ src/pages/api/admin/products/batch.ts 2>&1
```

預期：**空輸出**（本模組的 commit 沒碰這些檔；P3 的 schema/drizzle 改動是 P3 的 commit，若它們已合入則會在更早的 commit、不屬本模組 range——用 `git log --oneline` 自行區分。若本指令列出 `src/db/schema.ts` 且該改動屬本模組 commit，代表誤改，需 revert 該部分）。

- [ ] 7.5 收尾 commit（若 7.x 有任何小修；無修則跳過）。本模組整體已分 Task 2/3/4/5/6 各自 commit，至此完成。

---

## 驗收清單（本模組「完成」定義）

- [ ] **依賴**：P3 的 `admin_users.reset_token` / `reset_token_expires_at` 欄位與 index 已在 schema + stage 落地（Task 1 驗過）。
- [ ] `src/lib/auth.ts`：`sha256Hex()` + `generateResetToken()` 已加，純單元測試（`tests/auth-reset-helper.test.ts`）全 pass；token 存雜湊不存明文。
- [ ] `src/lib/rate-limit.ts`：`checkResetRequestRate()`（3/hr/email，`rl:reset:` bucket）已加。
- [ ] `src/lib/telegram.ts`：`sendTelegramMessage()` 通用推送已加；`notifyOrder` 未動。
- [ ] `POST /api/admin/auth/request-reset`：列舉一致回應（存在/不存在/rate-limited 都回 200 `{ok:true}`）、`requireSameOrigin` CSRF、3/hr/email rate limit、存 token 雜湊 + 30 分 TTL、Telegram fire-and-forget、audit `password_reset_requested`/`password_reset_failed`。整合測試 pass。
- [ ] `POST /api/admin/auth/reset-password`：以雜湊查 admin、拒未知/過期 token、12+ 密碼、PBKDF2 改密、清 token、刪該用戶全部 session、audit `password_reset_success`/`password_reset_failed`；不自動建新 session。整合測試 pass。
- [ ] `src/middleware.ts`：精確白名單放行 `/admin/forgot-password` + `/admin/reset-password`（+ 既有 `/admin/login`），其餘 `/admin/**` 仍 gate（6.8e 驗過）。
- [ ] `src/pages/admin/forgot-password.astro`、`reset-password.astro`：登出可達、UI 列舉一致、手動驗證清單（6.8a–e）通過。
- [ ] `src/pages/admin/login.astro`：含「忘記密碼？」連結。
- [ ] 新 audit actions（`password_reset_requested` / `password_reset_failed` / `password_reset_success`）已寫入對應路徑。
- [ ] `bunx astro check` 0 error；既有測試回歸 pass；未碰庫存/批次/wrangler/package/schema 禁區。

---

## 重要 open concerns（留給總編）

1. **middleware 是本模組唯一動到的「跨模組共用」production 檔**。spec §5.6 寫「登出可達」但沒明寫要改 `src/middleware.ts`——本計畫把 forgot/reset-password 兩條路徑加進精確白名單（§0.1 / Task 6.2）。若 V6 其它模組（如 §5.7 後台 UX）也要改 middleware，需與本模組協調**同一處**的改法（避免兩個 PR 各自重寫 `isLogin` 判斷而衝突）。建議總編指定 middleware 的 owner 模組或合併順序。

2. **Telegram push 故意 fire-and-forget 且不 await、不 audit 失敗**（§0.4 / Task 4.5）：這是為了列舉防護（避免「email 存在 → 多一次 round-trip → 變慢」洩漏）。代價是「push 失敗無 audit 痕跡」。若總編更重視可觀測性，替代方案是改用 `ctx.waitUntil()` 在回應送出後背景送 + 背景 audit（`notifyOrder` 即經由下單路徑的 `ctx.waitUntil()`）——但 Astro APIRoute 取 `ctx`（`waitUntil`）需 `locals.runtime.ctx`，而本專案 §「Env access」刻意不走 `Astro.locals.runtime`。要不要為此破例，留總編定。

3. **request-reset 的時間側信道未做嚴格等化**：login.astro 用 `DUMMY_HASH` 對「email 不存在」也跑一次 PBKDF2 做時間等化（`login.astro:21`）。request-reset 不驗密碼、不跑 PBKDF2，主要時間差來自「存在 → 多一次 `UPDATE` + token 生成（一次 SHA-256）」。本計畫靠「Telegram fire-and-forget」消除最大的網路差，但 DB `UPDATE` 的微小時間差仍存在。對一個 5 人家庭生意、且攻擊者就算確認 email 存在也收不到連結（連結只進店主 Telegram）的威脅模型，本計畫判斷不需做到 login 等級的 PBKDF2 時間等化。若總編要求嚴格等化，可在「不存在」分支補一次等量的假 SHA-256 + 假 expiry 計算。留總編定。

4. **reset-password 頁的 token 驗證放在 POST 而非 GET SSR**：本計畫 GET 只看「有無 token query」就渲染表單，真正驗證（雜湊查 + 過期）在 POST endpoint。好處是 SSR 路徑不碰 reset_token、頁面簡單、且不洩漏「token 有效性」給未送出表單者（無 timing/狀態差）。spec §5.6 寫「GET `?token=` → 驗 token 存在且未過期」——本計畫把該驗證延到 POST，使用者體驗上「無效 token 也先看到表單、送出才報錯」。若總編堅持 GET 即時驗（點連結就知道有效與否），需在 reset-password.astro 的 frontmatter 加一支「GET 驗證」呼叫（可新增 `GET /api/admin/auth/reset-password` 回 token 狀態，或 SSR 直接查 DB）——會多一個往返/路徑，且讓 SSR 碰 reset_token。本計畫選簡單安全版，差異留總編定。

5. **整合測試依賴「先部署到 stage」**：本模組所有 stage 整合測試（Task 4/5/7）打的是**已部署的 stage worker**，與既有 `admin-idempotency` 等一致。執行順序務必是「改 endpoint → `bun run deploy:stage` → 跑整合測試」。若在 CI 自動化，需把 stage 部署排在整合測試前。這不是本模組獨有，但對「零 context 工程師」需明示（已在 Task 4.6 / 5.4 備註）。
