# 設計:後台 6 碼 OTP 忘記密碼(取代 V6 連結式)

- 日期:2026-06-08
- 分支:main(實作時另開 feature 分支)
- 狀態:APPROVED
- 取代:`2026-06-06-v6-admin-selfservice-design.md` 的 §5.6(Telegram 連結式密碼重設)

## 1. 背景與動機

V6 已上線一套「忘記密碼」流程(commit `910394c`):輸入 email → 系統產生 256-bit 隨機 token → 把**重設連結**推到店家 Telegram(30 分鐘、單次)→ 點連結進 `/admin/reset-password?token=...` 設新密碼。

店主希望改成更熟悉的 **6 位數驗證碼(OTP)** 體驗:Telegram 收到 6 碼 → 在頁面輸入 6 碼 → 驗證成功即可改密碼。本設計**取代**連結式流程,只保留一套重設機制(不並存)。

### 1.1 關鍵安全前提

6 位數只有 1,000,000 種組合(舊 token 是 256-bit,幾乎不可能猜)。因此 OTP 版**必須在「驗證」端做嘗試次數上限**,否則可被暴力破解。這是本設計與舊版最大的差異點,所有後續決策圍繞此前提。

純 `SHA-256(code)` 對 6 碼無保護意義(攻擊者可預先算 100 萬個雜湊反查),所以改用 **HMAC-SHA256(server secret, "email:code")** 儲存——DB 外洩也無法反查,且綁定 email 順帶解決「兩人抽到同一組碼撞 unique index」的問題。

## 2. 目標 / 非目標

**目標**
- 把 Telegram 推送內容從「連結」改為「6 位數驗證碼」。
- 單頁(`/admin/forgot-password`)漸進式完成:輸 email → 顯示「驗證碼 + 新密碼」→ 一次 POST 完成驗證+重設。
- 在驗證端加「連錯 N 次作廢」與「每 IP 限制」兩道防線。
- 沿用既有的列舉一致、發送限流、成功後踢 session + Telegram 警示等防護。

**非目標**
- 不做 email/SMS 通道(維持單一共用店家 Telegram,沿用 `TELEGRAM_CHAT_ID`)。
- 不改密碼雜湊策略(PBKDF2 20k iters 不動)。
- 不改一般登入、`change-password`、`must_change_password` 強制改密碼流程。
- OTP **不**用來換登入 session;只用來閘住一次密碼重設(維持「重設密碼」語意)。

## 3. 流程(單頁 `/admin/forgot-password`)

email 全程留在前端 JS 變數,**不放進 URL**(避免進瀏覽器歷史 / server log)。

```
狀態 1(預設)              POST request-reset          狀態 2(同頁顯示,JS 切換)
┌──────────────┐          (永遠回 200 ok)            ┌─────────────────────────┐
│ Email [____] │ ───────────────────────────────▶  │ 「驗證碼已發到店家 Telegram」│
│ [發送驗證碼] │                                    │ 驗證碼 [_ _ _ _ _ _]      │
└──────────────┘                                    │ 新密碼 [____________]     │
       │                                            │ 再輸入 [____________]     │
   店主切到 Telegram 抄 6 碼                          │ [確認重設]  [重新發送]     │
                                                    └─────────────────────────┘
                                                              │ POST reset-password
                                                              ▼ {email, code, new_password}
                          成功 → 清碼 + 踢掉該帳號所有 session + Telegram 警示 → 2 秒後轉 /admin/login
                          失敗 → 「驗證碼錯誤,還剩 N 次」/「驗證碼已過期,請重新發送」
```

- 「重新發送」再打一次 `request-reset`(受 3 次/小時/email 限制);每次新碼會把 `reset_attempts` 歸零並覆蓋舊碼(舊碼即失效)。
- 因 `request-reset` 列舉一致(永遠 200),即使 email 不存在,UI 一樣進入狀態 2,只是店主不會收到碼。這是預期行為。

## 4. 安全模型

| 控制 | 設定 | 作用 | 實作位置 |
|---|---|---|---|
| 驗證嘗試上限 | 每組碼錯 **5 次** → 作廢、需重發 | 暴力破解主防線 | `reset-password.ts` + DB `reset_attempts` |
| 碼有效期 | **10 分鐘** | 縮小攻擊窗口 | `request-reset.ts`(`RESET_TTL_MS`) |
| 發送限流 | **3 次/小時/email**(沿用) | 防洗 Telegram | `checkResetRequestRate`(既有) |
| 驗證端限流 | **新增** 每 IP **10 次/15 分** | 防跨帳號狂試 | 新 `checkResetVerifyRate` |
| 儲存格式 | `HMAC-SHA256(RESET_OTP_SECRET, "lower(email):code")` hex,**不存明碼** | DB 外洩無法反查;綁 email 防同碼撞索引 | `auth.ts` `hmacResetCode` |
| 單次使用 | 成功或達上限即清 `reset_token / expiry / attempts` | 防重放 | `reset-password.ts` |
| 列舉一致 | 發送端永遠回 200;驗證端 email 不存在也跑 dummy HMAC、回一致錯誤訊息 | 不洩漏帳號是否存在 | 兩端 |
| 成功後 | 踢掉該帳號**所有 session** + Telegram「密碼已被重設」警示 | 防接管(沿用 FIX #12) | `reset-password.ts` |

> ⚠️ **已知前提(沿用 FIX #12)**:驗證碼發到**共用**店家 Telegram,任何能看到該對話的人都看得到碼。對 5 人家庭店是可接受的威脅模型(與舊連結式相同);以「成功後發警示」讓接管可被察覺。

## 5. 資料模型變更(`src/db/schema.ts` + migration)

`admin_users` 表:

- **沿用** `reset_token`:語意改為「6 碼的 HMAC hex」(更新欄位註解)。
- **沿用** `reset_token_expires_at`:TTL 改 10 分鐘(由 endpoint 設定,欄位不變)。
- **新增** `reset_attempts INTEGER NOT NULL DEFAULT 0`:發碼時歸零,錯一次原子 +1。
- **移除** 索引 `admin_users_reset_token_unique`:新查法是「用 email 查、比對 HMAC」,不再需要 token 全域唯一;留著反而會在兩人同抽到同碼時撞索引。

產生 migration:`bun run db:generate`(輸出到 `./drizzle`)。套用順序:**先 stage 驗證,再 prod**。
須通過既有 `tests/migration-idempotency.test.ts`。

> 移除既有具名索引時,確認 drizzle 產出的 migration 含 `DROP INDEX admin_users_reset_token_unique;`;若 D1 既有資料庫已建該索引,migration 必須能在 remote 套用成功。

## 6. API 變更

### 6.1 `POST /api/admin/auth/request-reset`(改寫)

不變的部分:`requireSameOrigin`、`checkResetRequestRate`(3/hr/email)、列舉一致(永遠 `json({ok:true})`)、Telegram **fire-and-forget 不 await**(timing-leak 防護)。

改變:
1. 以 `generateOtpCode()` 產 6 碼(取代 `generateResetToken()`)。
2. 存 `reset_token = hmacResetCode(env.RESET_OTP_SECRET, email, code)`、`reset_token_expires_at = now + 10min`、`reset_attempts = 0`(同一 UPDATE 一起寫)。
3. Telegram 推**驗證碼**(非連結),文案見 §9。
4. `RESET_TTL_MS = 10 * 60_000`。

### 6.2 `POST /api/admin/auth/reset-password`(改寫)

請求 body:`{ email: string, code: string, new_password: string }`(新增 `email`、`code` 取代 `token`)。

防護順序與邏輯:
1. `requireSameOrigin` → 失敗 403。
2. **新增** 驗證端 IP 限流 `checkResetVerifyRate(env, ip)` → 超限回**一致的**錯誤訊息(不回 429,避免成為洩漏訊號)。`ip` 取 `cf-connecting-ip`(同 login.astro)。
3. 正規化 `email = lower(trim(email))`;`code` 取數字字串。
4. 查 `admin_users`(by email),取 `reset_token, reset_token_expires_at, reset_attempts`。
5. **email 不存在**:仍跑一次 dummy `hmacResetCode`(timing 等化),回一致錯誤 `驗證碼錯誤或已過期`。
6. **無有效碼 / 已過期 / `reset_attempts >= 5`**:回一致錯誤;若過期或已達上限,順手清 `reset_token/expiry`。
7. 計算 `hmacResetCode(secret, email, code)`,與儲存值做 **constant-time 比對**:
   - **不符** → 原子遞增:
     ```sql
     UPDATE admin_users SET reset_attempts = reset_attempts + 1
     WHERE email = ?1 AND reset_token IS NOT NULL
     RETURNING reset_attempts;
     ```
     若回傳 `>= 5`,再清 `reset_token/reset_token_expires_at`(作廢)。audit `password_reset_failed{reason:"bad_code", attempts:n}`。回 `驗證碼錯誤,還剩 (5-n) 次`。
   - **相符** → 密碼政策檢查(12–200 字;不符**不消耗**碼,讓使用者修正後重試,沿用舊行為)→ 成功路徑:
     ```sql
     UPDATE admin_users
     SET password_hash = ?, must_change_password = 0,
         reset_token = NULL, reset_token_expires_at = NULL, reset_attempts = 0
     WHERE email = ? AND reset_token = ?;   -- race guard(沿用 FIX #11)
     ```
     檢查 `meta.changes > 0`(並發雙送的 loser 改 0 列 → 回一致錯誤);成功則 `DELETE FROM sessions WHERE user_email = ?`、audit `password_reset_success`、Telegram 發「密碼已被重設」警示(fire-and-forget)。回 `json({ok:true})`,前端 2 秒後轉 `/admin/login`。

> 不在此端 mint 新 session(使用者本來就沒登入),沿用舊版行為。

## 7. 新增 / 變更的 lib

### 7.1 `src/lib/auth.ts`
- **移除** `generateResetToken`(及若確認無其他引用則一併移除 `sha256Hex`)。
- **新增** `generateOtpCode(): string` — 6 位數字字串,CSPRNG(`crypto.getRandomValues`),**rejection sampling 避免模偏**,左補零。
- **新增** `hmacResetCode(secret: string, email: string, code: string): Promise<string>` — `HMAC-SHA256(secret, lower(email)+":"+code)` 回 hex。

### 7.2 `src/lib/rate-limit.ts`
- **新增** `checkResetVerifyRate(env, ip)` — KV key `rl:reset_verify:<ip>`,10 次 / 15 分(仿 `checkLoginIpRate`)。

### 7.3 `src/lib/env.ts` / `src/db/client.ts`
- `AppEnv` 新增 secret 欄位 `RESET_OTP_SECRET: string`。

## 8. 前端頁面變更

### 8.1 `/admin/forgot-password.astro`(改寫為單頁兩態)
- 狀態 1:email 欄 + 「發送驗證碼」。送出後 POST `request-reset`;200 即把 email 存入 JS 變數、隱藏 email 欄、顯示狀態 2。
- 狀態 2:提示文字 + 6 碼欄(`inputmode="numeric"`、`maxlength=6`、`autocomplete="one-time-code"`)+ 新密碼 + 確認 + 「確認重設」+「重新發送」。送出後 POST `reset-password {email, code, new_password}`;成功顯示「密碼已重設,2 秒後前往登入」並導向 `/admin/login`;失敗顯示後端回的訊息(「還剩 N 次」/「已過期」)。
- 客戶端先擋:兩次新密碼一致、≥12 字、碼為 6 位數字。

### 8.2 移除 `/admin/reset-password.astro`
- 刪檔。
- `src/middleware.ts` 的 `PUBLIC_ADMIN_PATHS` 移除 `"/admin/reset-password"`。
- 確認無其他連入點(已查:`login.astro` 連的是 `forgot-password`;Telegram 改發碼後不再有連結)。

## 9. Telegram 文案

發碼(`request-reset`):
```
🔐 後台密碼重設
帳號:<email>
驗證碼:123456
10 分鐘內有效,最多輸入 5 次。
若非你本人申請,請忽略本訊息並通知管理員。
```

成功警示(`reset-password`,沿用現有):
```
⚠️ 後台密碼已被重設
帳號:<email>
若不是你本人操作,請立即聯絡管理員並重新申請重設。
```

## 10. 測試計畫

- `tests/auth-reset-helper.test.ts`(改寫,純單元免 env):
  - `generateOtpCode` 回 6 位數字、落在 `000000–999999`、分佈無明顯模偏(抽樣)。
  - `hmacResetCode` 決定性、對 email 或 code 任一變動即不同、綁 email(同 code 不同 email → 不同 hash)。
- `tests/password-reset.test.ts`(改寫,整合打 stage):
  - happy path:request → 由 `getResetTokenRow` 取不到明碼(只有 HMAC)→ 用測試已知 secret 自算 HMAC 反推不可行,故改由 `setResetToken` 植入「已知 code 的 HMAC + 未過期 + attempts=0」→ 驗證+改密碼成功 → 新密碼可登入、舊 session 被踢。
  - 錯碼計次:連錯 5 次 → 第 5 次後碼作廢(`reset_token` 變 NULL)→ 即使再送正確碼也失敗。
  - 過期:植入過期 expiry → 一致錯誤。
  - 重發歸零:第二次 request 後 attempts 回 0、舊碼 HMAC 失效。
  - 並發雙送(race):同碼兩送,loser 改 0 列、回錯誤(不誤報成功)。
- `tests/_setup.ts`:`setResetToken` 增設 `reset_attempts` 參數(預設 0);`getResetTokenRow` 加回 `reset_attempts`。新增 helper 計算測試用 HMAC(用測試 secret),或讓整合測試以 `setResetToken` 植入由測試端算好的 HMAC。
- 既有 `tests/migration-idempotency.test.ts` 須對新 migration 仍綠。

> 整合測試需 stage 設好 `RESET_OTP_SECRET`,且測試端知道同一值才能自算 HMAC 植入。於 `_setup.ts` 以環境變數 `TEST_RESET_OTP_SECRET`(對齊 stage 值)提供,缺少時 skip 對應整合案例(純單元案例不受影響)。

## 11. 部署步驟

1. `wrangler secret put RESET_OTP_SECRET --env stage`(隨機長字串,≥32 bytes)。
2. `bun run db:migrate:stage` 套 migration → 跑整合測試驗證。
3. `wrangler secret put RESET_OTP_SECRET --env prod`。
4. `bun run db:migrate:prod`。
5. 部署 main worker(`bun run deploy:stage` → 驗證 → `bun run deploy:prod`;注意 CLAUDE.md 的 `PUBLIC_ORDER_TOKEN` 換 env 陷阱)。
6. 上線後實機驗證:request → Telegram 收碼 → 重設 → 新密碼登入 → 收到「密碼已被重設」警示。

> 不影響 cron worker(未讀此 secret)。

## 12. 邊界與失敗模式

- **email 不存在**:UI 仍進狀態 2;驗證端跑 dummy HMAC、回一致錯誤。不洩漏存在性。
- **碼過期後送出**:回「已過期,請重新發送」;清殘留碼。
- **連錯達上限**:碼作廢;UI 提示重新發送(非永久鎖定帳號,避免 DoS-by-lockout)。
- **同碼並發雙送**:race guard 讓 loser 改 0 列、回錯誤。
- **Telegram 未設定 / 發送失敗**:`sendTelegramMessage` 回 false 且自吞錯;發送端仍回 200(不阻斷、不洩漏)。店主收不到碼 → 走「重新發送」。
- **兩人同抽到同一組 6 碼**:HMAC 綁 email → 儲存值不同;且已移除 unique index,不會撞。

## 13. 逐檔改動清單

| 檔案 | 動作 |
|---|---|
| `src/db/schema.ts` | 加 `reset_attempts`;移除 `admin_users_reset_token_unique`;更新註解 |
| `drizzle/*`(產生) | `bun run db:generate` 新 migration |
| `src/db/client.ts` | `AppEnv` 加 `RESET_OTP_SECRET` |
| `src/lib/auth.ts` | 移除 `generateResetToken`(/`sha256Hex` 若無引用);加 `generateOtpCode`、`hmacResetCode` |
| `src/lib/rate-limit.ts` | 加 `checkResetVerifyRate` |
| `src/pages/api/admin/auth/request-reset.ts` | 產 6 碼、存 HMAC+TTL10m+attempts=0、發碼文案 |
| `src/pages/api/admin/auth/reset-password.ts` | 改 `{email,code,new_password}`、IP 限流、嘗試上限、HMAC 比對、成功路徑 |
| `src/pages/admin/forgot-password.astro` | 改寫為單頁兩態 |
| `src/pages/admin/reset-password.astro` | 刪除 |
| `src/middleware.ts` | `PUBLIC_ADMIN_PATHS` 移除 `/admin/reset-password` |
| `src/lib/telegram.ts` | 註解微調(發碼非連結);`sendTelegramMessage` 本體不變 |
| `tests/auth-reset-helper.test.ts` | 改寫 |
| `tests/password-reset.test.ts` | 改寫 |
| `tests/_setup.ts` | `setResetToken`/`getResetTokenRow` 支援 `reset_attempts`;HMAC 測試 secret |

## 14. 已定參數

- TTL:**10 分鐘**
- 驗證嘗試上限:**5 次/碼**
- 驗證端 IP 限流:**10 次/15 分/IP**
- 發送限流:**3 次/小時/email**(沿用)
- HMAC 金鑰:**新增專用 `RESET_OTP_SECRET`**
- 碼格式:6 位數字,CSPRNG + rejection sampling
