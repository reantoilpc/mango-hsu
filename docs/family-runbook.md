# 家人操作手冊（mango-hsu）

這份是給家人看的操作說明。網站、Google Sheet、Telegram 通知的日常處理，
全部都在這裡。

## 一、一次性 setup（上線前做一次）

### 1. Google Sheet

開啟 `mango-hsu-orders` 這份 Sheet（連結請向 Ray 索取）。會看到四個分頁：

- **settings** — 網站的設定，例如運費、銀行帳號、Telegram token
- **products** — 產品清單跟是否接單
- **orders** — 客人下的所有訂單，每一張訂單一列
- **errors** — 系統遇到錯誤會寫到這裡

**不要刪欄、不要改欄位順序、不要刪分頁**。這會讓網站壞掉。

### 2. Telegram bot（五分鐘）

1. 打開手機的 Telegram，搜尋 `@BotFather`，傳訊息給它
2. 傳 `/newbot`，依指示幫 bot 取名字跟帳號（例：`mangoHsuOrders_bot`）
3. BotFather 會回給你一串 token，長得像：
   `8xxxxxxxxx:AAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBB`
4. 把這串 token **完整** 貼到 Sheet `settings` 分頁的 `telegram_bot_token` 格
5. 建一個 Telegram 群組，叫「芒果許訂單」（或任何你喜歡的名字），
   把要接通知的家人全部加進來
6. 把剛剛建的 bot 也加進這個群組（**把它設為管理員**）
7. 在群組裡隨便發一則訊息，例如「test」
8. 用瀏覽器打開這個網址（把 `<TOKEN>` 換成你的 bot token）：
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
9. 會看到一段 JSON，找到裡面的 `"chat":{"id": -100xxxxxxxxxx, ...}`，
   **把這個 `id` 完整貼** 到 `settings` 的 `telegram_chat_id` 格
   （通常是負數、開頭是 `-100`）
10. 去 Apps Script Editor（在 Sheet 選單「擴充功能 → Apps Script」），
    執行 `testTelegram` 函式，群組應該收到測試訊息

### 3. 如果 bot token 不小心外流

馬上回 `@BotFather` 傳 `/revoke`，選擇你的 bot，拿到新的 token，
再更新 Sheet `settings.telegram_bot_token`。舊的 token 立刻作廢。

---

## 二、日常操作

### A. 新訂單進來 — 你會看到什麼

Telegram 群組會收到一則訊息，長這樣：

```
🥭 新訂單 M-20260519-001
王小明  0912345678

• 金煌芒果乾 1斤 × 3

小計 $1350 + 運費 $80 = 總計 $1430

預期備註：M-20260519-001-王小明
收件地址：台中市...

🔗 https://mango-hsu.pages.dev/status?id=M-20260519-001
```

同時 Google Sheet 的 `orders` 分頁會多一列，寫著剛剛這筆訂單的資料。

### B. 對帳 — 確認收到款

1. 打開網銀 App，看「近期交易」
2. 找備註欄寫著 `M-20260519-001-王小明` 的入帳
3. 回到 Google Sheet `orders` 分頁，找到這筆訂單（用 Ctrl+F 搜訂單編號最快）
4. 把 `paid` 欄位打勾（點一下那一格就會變成勾勾）

**技巧**：如果客人忘了寫備註，就用金額＋姓氏去猜。找不到就 LINE 問客人。

### C. 出貨 — 寄出之後要做的

1. 寄出包裹後拿到宅配單號
2. 回到 `orders` 分頁找訂單
3. 把 `shipped` 欄位打勾
4. 在 `tracking_no` 欄填入宅配單號

這三步做完，客人去「訂單狀態頁」就會看到更新。

### D. 某個品項快賣完 — 下架

1. 到 `products` 分頁
2. 找到賣完的 SKU（例如金煌 1 斤 `DRY-JH-1`）
3. 把 `available` 欄從 `TRUE` 改成 `FALSE`
4. 存檔（Sheet 會自動存）

網站立刻會顯示「已售完」，新客人就不能再訂這個品項。

### E. 整季結束 — 暫停整個網站

1. 到 `settings` 分頁
2. 把 `accepting_dry` 從 `TRUE` 改成 `FALSE`

網站首頁會顯示「目前暫停接單，下一季見」，下訂頁會關閉。
下一季要開賣時改回 `TRUE` 即可。

### F. 客人要改訂單

V1 網站本身不能線上改。請：

1. 請客人用 LINE 告訴你要改什麼
2. 你直接在 Sheet `orders` 那一列手動改
3. 如果要改金額，記得同步改 `total`（用計算機或 Excel 公式）

---

## 三、常見問題排解

### 我沒收到 Telegram 通知？

- 確認 bot 還在群組裡，沒被踢出來
- 確認 `settings.telegram_bot_token` 跟 `telegram_chat_id` 都填了、沒打錯
- 到 `errors` 分頁看有沒有 `TELEGRAM_FAILED` 紀錄
- 執行 Apps Script 的 `testTelegram` 函式，看能不能手動發訊息

### `orders` 分頁有一列是空的或亂的？

先不要刪。截圖給 Ray 看看。有可能是某次提交時發生錯誤。

### 網站顯示錯誤 / 客人說下不了單？

- 到 `errors` 分頁看最新幾筆紀錄
- 如果看不懂，把錯誤訊息截圖貼給 Ray

### 想暫停某個品項但又不想刪資料

用 `available: FALSE` 不要刪那一列。歷史訂單的 `items_json` 會保留那個 SKU，
如果刪掉產品列，Telegram 通知組訊息時會顯示 SKU 代號而不是產品名。

---

## 四、自動清理（已設定）

為符合個資法，Apps Script 每月 1 號會自動刪除 6 個月前的訂單資料。
這是設定好的背景工作，家人不用做任何事情。

如果想手動跑一次（例如想立刻清理），去 Apps Script Editor 執行 `purgeOldOrders`。

---

## 五、需要 Ray 幫忙的時候

直接 LINE 他，附上：

1. 你看到的畫面（截圖）
2. `errors` 分頁最新幾筆紀錄
3. 訂單編號（如果是特定訂單的問題）

三樣都有，他就能很快看出問題。
