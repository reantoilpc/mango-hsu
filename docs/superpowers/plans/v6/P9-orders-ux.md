# P9 — 既有訂單管理 UX 整頓 實作計畫（spec §5.8）

> **模組範圍**：純前端 / UI 可發現性與清晰度整頓。**不**改訂單底層狀態機、**不**改任何 API（`mark-paid` / `mark-shipped` / `cancel` / `save` / `bulk-mark-shipped` 行為完全不動）、**不**改 audit、**不**改庫存路徑。
>
> **唯一觸碰的 production 檔（共 3 個）**：
> - `src/pages/admin/orders/[id].astro`（訂單詳情：操作面板重組 + 編輯流程提示 + 按鈕文案）
> - `src/pages/admin/orders/index.astro`（訂單列表：批次操作 UX + 按鈕文案）
> - `src/pages/admin/orders/new.astro`（代客建單：返回連結文案，已存在 ← 訂單列表，spec 要求確認/微調）
>
> 本計畫不新增 API、不新增 DB 欄位、不依賴 P2 遷移、不依賴 P3 運費。可在任何順序執行，但建議排在 spec §9 第 7 步（後台 UX）。

---

## 給「零 context 工程師」的前置說明（務必先讀）

### 1. 這個 codebase 怎麼跑

```bash
# 安裝（若還沒）
bun install

# 啟動 dev server（含 Cloudflare bindings via platformProxy）。預設 http://localhost:4321
bun run dev
```

- 框架：**Astro 6 SSR**。`.astro` 檔上半 `---fence---` 是 server-side（Node/Workers），下半是 HTML 模板 + `<script>`（瀏覽器端，會被 Vite 打包）。
- 樣式：**Tailwind v4**（class 直接寫在 markup）。專案自訂色 `mango-50..600`、`orange-600`、`emerald`、`amber`、`blue`、`red` 等已在用，照抄即可，不要自創新色票。
- 互動：`.astro` 內的 `<script>`（非 `is:inline`）會被當 ES module 打包；DOM 用原生 API（無 React/Vue/jQuery）。
- 既有共用元件：`src/components/admin/StatusStepper.astro`（狀態進度條，純展示）、`StickyBar.astro`（底部浮動儲存列）、`Modal.astro`（原生 `<dialog>` 確認框）。

### 2. 驗證工具（本模組的「測試」長怎樣）

這個 repo **沒有** DOM 單元測試框架（無 jsdom / happy-dom / @testing-library / playwright）。`bun test` 只跑兩種：純單元 `.test.ts` 與打 stage worker 的 HTTP 整合測試（見 `tests/_setup.ts`，缺 stage env 會自動 skip）。**純 UI 展示層改動不適合寫成 `.test.ts`**——硬寫會變成測試框架本身而非測 UI。

因此本模組每個 Task 的「測試」用**兩層、皆可在本機重現**：

- **層 1（確定性、必跑、無需任何 env/瀏覽器）= 源碼斷言 + 編譯閘**
  - `bunx astro check` — Astro/TypeScript 型別與模板編譯檢查。任何破壞 markup 或 client script 型別的改動會讓它非 0 退出。**這是 hard gate，每個 Task 必過。**
  - `grep` 斷言 — 用 `grep -c` / `grep -q` 對「**渲染模板源碼**」斷言「應出現的精確字串」或「應消失的舊字串」。這是 TDD 的 RED/GREEN：實作前 grep 預期字串 → 找不到（FAIL）；實作後 → 找到（PASS）。確定性、可在 CI 重現、不需登入。
- **層 2（視覺 / 互動確認、人工或 gstack）= 瀏覽器斷言**
  - 用 `/browse`（gstack）skill 對 `bun run dev` 的 `http://localhost:4321/admin/...` 做 DOM/狀態斷言（按鈕文字、disabled 狀態、變色、提示文字）。需要管理員 session（先用既有帳號登入後台，或用 `setup-browser-cookies` skill 匯入 cookie）。
  - gstack 非確定性（依賴 live session），所以**不作為 hard gate**；但每個有可見行為的 Task 都附上「gstack 驗收腳本」與「預期可見結果」，供執行者實機驗收與截圖。

> 每個 Task 的 RED→GREEN 以**層 1 的 grep** 為主驗證（最小可重現），層 2 為實機驗收。Commit 在層 1 全綠後進行。

### 3. 共用契約（本模組會用到的部分）

- **授權 / API**：本模組**不碰** API，故無 `authorizeAdmin` / `requireSameOrigin` 變更。既有前端 `fetch` 呼叫一律帶 `credentials: "same-origin"`（照抄現狀）。
- **既有狀態旗標**：訂單有 `paid`(bool) / `shipped`(bool) / `cancelled_at`(string|null) / `tracking_no` / `shipped_at`。列表頁每列已帶 `data-paid` / `data-shipped` dataset（`index.astro:152-153`），批次邏輯靠它判斷。
- **時間**：顯示一律用 `formatTaipei()`（`src/lib/formatters.ts`）。本模組不新增時間欄位。
- **Toast**：`src/lib/toast.ts` 的 `showToast(msg, { kind })`、`flashToast`（跨頁 reload 後顯示）、`consumeFlash()`。`kind ∈ "success" | "error"`（沿用現有呼叫）。

### 4. 硬規則

- 只改上述 3 個 `.astro` 檔。不要動 API、schema、其他頁面、共用元件（`StatusStepper` / `StickyBar` / `Modal` 維持原樣，本模組只「使用」不「修改」它們）。
- 不改任何 `fetch` 的 URL、method、body 結構或 server 回應契約。狀態機行為（誰能 disabled、什麼時候能標出貨）由 **既有 server SQL guard** 權威保證；前端 disabled 只是「可發現性提示」，不是新的授權邏輯。
- No placeholder：每個 step 給完整可貼上的程式碼。

### 5. 本模組目標（spec §5.8 逐項對應 Task）

| spec §5.8 條目 | Task |
|---|---|
| 訂單詳情操作面板 → 狀態流程卡，下一步按鈕永遠可見、未達條件 disabled + 說明（`[id].astro:236-286`） | **Task 2** |
| 訂單編輯流程簡化：編輯區明確視覺提示（`[id].astro:149-191 / 309-318`） | **Task 3** |
| 批次操作 UX：勾選變色 +「已選 N 筆」+ 批次確認列出單號；「一鍵生揀貨單」→「生成揀貨單」（`index.astro:118-142`） | **Task 4 / Task 5** |
| 按鈕文案 / 確認框 / toast 具體化 | 散落於 Task 2/4/5/6 |
| 代客建單加「← 返回訂單列表」（`new.astro:49`） | **Task 6** |

Task 0 = 基線/工具就緒；Task 1 = 先寫一支「源碼斷言驗收檔」當作整個模組的 RED 清單（最後 Task 7 收尾驗證全綠）。

---

## Task 0 — 建立工作分支 + 確認基線綠

**Files**
- Modify: 無（只跑指令）

**Steps**

- [ ] 確認在 repo 根目錄、工作樹乾淨（除了允許的 `CLAUDE.md` 既有改動）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git status --short
  ```
  預期輸出（`CLAUDE.md` 那行可有可無，視當前狀態；**不應**有 `src/pages/admin/orders/*` 的改動）：
  ```
   M CLAUDE.md
  ```
- [ ] 從 `main` 開新分支（本工作不直接 commit 到 main）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git checkout -b feature/v6-p9-orders-ux
  ```
  預期：`Switched to a new branch 'feature/v6-p9-orders-ux'`
- [ ] 確認基線 `astro check` 綠（記下既有 error 數，之後不得增加）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -5
  ```
  預期最後一行類似 `Result (NNN files): ... 0 errors`。**若基線本來就有 error，把數字記下來當門檻；本模組結束時 error 數必須 ≤ 基線。**
- [ ] 啟動 dev server（背景，供 gstack 實機驗收；層 1 grep 不需要它）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bun run dev
  ```
  預期看到 `astro ... ready in ... http://localhost:4321/`。讓它在背景跑著；之後每個 Task 的 gstack 驗收都連這個 URL。

> 本 Task 不 commit（沒有檔案改動）。

---

## Task 1 — 寫模組級「源碼斷言驗收檔」（RED 清單）

**目的**：把 §5.8 所有可見變更收斂成一支可重複跑的 bash 斷言腳本。先讓它**整批 FAIL**（RED），每完成一個後續 Task 就有對應斷言轉 PASS，Task 7 整批 GREEN。這支腳本不是 `bun test`（它測的是「模板源碼是否含預期 UI 字串」，屬確定性源碼契約檢查），放在 `scripts/` 下，**不影響** production，也不被 `bun test` 收集。

> ⚠️ 注意：`scripts/` 目錄屬 production tree 嗎？本 repo `scripts/` 放的是部署/維運腳本（`deploy.mjs`、`reconcile-stock.ts`），會被 git 追蹤但**不**進 worker bundle。本驗收檔是「開發期 UI 契約 gate」，與 `tests/deploy-token-guard.test.ts` 同性質（驗源碼而非跑 app）。為避免污染 `scripts/`，放在 `docs/superpowers/plans/v6/` 旁的不會被打包路徑。**最終放置路徑：`scripts/p9-ux-assert.sh`**（與既有維運腳本同層，符合慣例；不被 `astro build` 收集，不被 `bun test` 收集）。

**Files**
- Create: `scripts/p9-ux-assert.sh`

**Steps**

- [ ] 建立驗收腳本。完整內容如下（直接寫入）：

```bash
#!/usr/bin/env bash
# P9 (spec §5.8) 訂單 UX 整頓 — 源碼契約驗收。
# 對「渲染模板源碼」斷言應出現/應消失的 UI 字串。確定性、無需 env、無需瀏覽器。
# 用法：bash scripts/p9-ux-assert.sh
# 退出碼：全綠 0；任一 FAIL 非 0。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ID="$ROOT/src/pages/admin/orders/[id].astro"
LIST="$ROOT/src/pages/admin/orders/index.astro"
NEW="$ROOT/src/pages/admin/orders/new.astro"
fail=0

# $1=描述 $2=should be "present"|"absent" $3=檔案 $4=固定字串(grep -F)
assert() {
  local desc="$1" mode="$2" file="$3" needle="$4"
  if grep -qF -- "$needle" "$file"; then found=1; else found=0; fi
  if { [ "$mode" = "present" ] && [ "$found" = "1" ]; } || \
     { [ "$mode" = "absent" ]  && [ "$found" = "0" ]; }; then
    printf "PASS  %s\n" "$desc"
  else
    printf "FAIL  %s  (expected %s of: %s)\n" "$desc" "$mode" "$needle"
    fail=1
  fi
}

echo "== Task 2: 操作面板狀態流程卡 =="
assert "面板標題改為「下一步操作」"            present "$ID" "下一步操作"
assert "標出貨按鈕在未付款時可見(永遠渲染)"    present "$ID" 'data-step="ship"'
assert "未達條件說明文字(需先標記已付款)"      present "$ID" "需先標記已付款"
assert "舊條件包覆 markup 已移除(付款後才渲染標出貨)" absent "$ID" 'order.paid && !order.shipped && order.cancelled_at === null && ('

echo "== Task 3: 編輯區視覺提示 =="
assert "品項可編輯時顯示「編輯模式」標籤"        present "$ID" "編輯模式"
assert "編輯說明(僅未付款訂單可改品項)"          present "$ID" "僅未付款訂單可修改品項"

echo "== Task 4: 批次列表選取狀態 =="
assert "選取提示文案「已選」"                  present "$LIST" "已選"
assert "批次工具列有選取數高亮容器"            present "$LIST" 'data-batch-bar'
assert "勾選列高亮 class hook 存在"            present "$LIST" "row-selected"

echo "== Task 5: 批次按鈕文案 + 確認列出單號 =="
assert "「一鍵生揀貨單」舊文案已移除"          absent  "$LIST" "一鍵生揀貨單"
assert "新文案「生成揀貨單」"                  present "$LIST" "生成揀貨單"
assert "批次確認列出單號(逐筆)"                present "$LIST" "以下 "
assert "出貨成功 toast 具體化(已標 N 筆)"      present "$LIST" "筆為已出貨"

echo "== Task 6: 代客建單返回連結 =="
assert "返回訂單列表連結文案"                  present "$NEW" "返回訂單列表"

if [ "$fail" = "0" ]; then
  echo ""; echo "ALL GREEN ✅"; exit 0
else
  echo ""; echo "SOME FAILED ❌"; exit 1
fi
```

- [ ] 賦予執行權限並跑一次 — **預期大量 FAIL（RED 基線）**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && chmod +x scripts/p9-ux-assert.sh && bash scripts/p9-ux-assert.sh; echo "exit=$?"
  ```
  預期輸出（節錄；重點是出現多個 `FAIL` 且 `exit=1`）：
  ```
  == Task 2: 操作面板狀態流程卡 ==
  FAIL  面板標題改為「下一步操作」  (expected present of: 下一步操作)
  FAIL  標出貨按鈕在未付款時可見(永遠渲染)  (expected present of: data-step="ship")
  ...
  FAIL  舊條件包覆 markup 已移除(付款後才渲染標出貨)  (expected absent of: order.paid && !order.shipped && order.cancelled_at === null && ()
  ...
  == Task 6: 代客建單返回連結 ==
  PASS  返回訂單列表連結文案
  ...
  SOME FAILED ❌
  exit=1
  ```
  > 註：「返回訂單列表」那條可能已 PASS（`new.astro:49` 現有 `← 訂單列表` 不含「返回」二字 → 應 FAIL；Task 6 會補「返回」）。RED 階段只要整體 `exit=1` 即符合預期。
- [ ] `astro check` 仍綠（這支 `.sh` 不影響型別）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -2
  ```
  預期 error 數 ≤ 基線。
- [ ] Commit（RED 驗收檔本身）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add scripts/p9-ux-assert.sh && git commit -m "test(orders-ux): add §5.8 source-contract assertion harness (RED)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2 — 訂單詳情：操作面板重組為「狀態流程卡」（下一步永遠可見 + disabled 說明）

**spec §5.8**：把「會消失的條件按鈕」改為**下一步按鈕永遠可見、未達條件 disabled + 明確說明**（`[id].astro:236-286`）。

**現況問題**（已讀 `[id].astro:236-286`）：整個 `<section>操作</section>` 被 `{(!order.shipped || cancelled || cancellable) && (...)}` 包住，內部三個動作各自再被條件包：未付款才出現「標為已付款」、`paid && !shipped` 才出現「標為已出貨」。店主在「未付款」狀態下**根本看不到**未來要按的「標出貨」，不知道流程往哪走。

**改法**：保留同一個 `<section>`，但把可見性邏輯反轉——**「標為已付款」與「標為已出貨」兩個下一步按鈕永遠渲染**（只在「已取消」終態整段不顯示動作區）；未滿足前置條件時 `disabled` 並附灰字說明。`mark-shipped` 的物流單號輸入框也永遠渲染但未付款時 disabled。`cancel` 維持「僅未付款可取消」（這是 server 真實 guard，付款後不可取消，不該給可點按鈕）。

> ⚠️ 不改任何 `fetch` 行為與 server 契約。`mark-paid` / `mark-shipped` 的 client handler（`[id].astro:826-833`）**已用 `getElementById` 綁定**，按鈕永遠存在反而讓綁定更穩。disabled 按鈕不會觸發 click，與 server guard 雙保險。

**Files**
- Modify: `src/pages/admin/orders/[id].astro`（模板區 236-286 重寫；client 區補「禁用態不送出」的保險）
- Test: `scripts/p9-ux-assert.sh` 的 Task 2 段（已於 Task 1 建立）+ `bunx astro check`

**Steps**

- [ ] **RED**：先跑 Task 2 段斷言，確認目前 FAIL：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 2/,/Task 3/p'
  ```
  預期 4 條皆 `FAIL`（標題、ship 按鈕永遠渲染、disabled 說明、舊條件 markup 未移除）。

- [ ] 重寫操作區。先讀目前內容定位（行號可能因前面 Task 微移，用內容比對）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && grep -n '會消失的條件\|<h2 class="mb-3 text-lg font-bold">操作</h2>\|order.paid && !order.shipped && order.cancelled_at === null && (' src/pages/admin/orders/\[id\].astro
  ```
- [ ] 用 Edit 取代整段操作 `<section>`。

  **OLD**（`[id].astro` 第 236–286 行，整段；務必連同外層 `{(...) && (` 與結尾 `)}`）：
  ```astro
    {(!order.shipped || order.cancelled_at !== null || cancellable) && (
      <section class="mb-6 rounded border border-gray-200 p-4">
        <h2 class="mb-3 text-lg font-bold">操作</h2>
        <div class="space-y-3">
          {!order.paid && order.cancelled_at === null && (
            <button
              type="button"
              id="mark-paid"
              class="w-full inline-flex items-center justify-center rounded bg-emerald-600 px-4 py-3 min-h-[44px] text-base font-medium text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed"
            >
              標為已付款
            </button>
          )}
          {order.paid && !order.shipped && order.cancelled_at === null && (
            <div class="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                id="tracking-input"
                placeholder="物流單號（選填）"
                value={order.tracking_no ?? ""}
                maxlength="100"
                class="flex-1 rounded border border-gray-300 px-3 py-3 min-h-[44px] text-base focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2"
                aria-label="物流單號"
              />
              <button
                type="button"
                id="mark-shipped"
                class="inline-flex items-center justify-center rounded bg-blue-600 px-4 py-3 min-h-[44px] text-base font-medium text-white hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
              >
                標為已出貨
              </button>
            </div>
          )}
          {order.shipped && order.cancelled_at === null && (
            <div class="text-sm text-gray-700">
              出貨時間 {order.shipped_at ? formatTaipei(order.shipped_at) : "—"}
              {order.tracking_no && ` ／ 物流 ${order.tracking_no}`}
            </div>
          )}
          {cancellable && isAdmin && (
            <button
              type="button"
              id="cancel-order"
              class="w-full inline-flex items-center justify-center rounded border border-red-400 px-4 py-3 min-h-[44px] text-base text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              取消訂單
            </button>
          )}
        </div>
      </section>
    )}
  ```

  **NEW**（貼上取代；註解說明設計意圖）：
  ```astro
    {order.cancelled_at === null && (
      <section class="mb-6 rounded border border-gray-200 p-4">
        <h2 class="mb-3 text-lg font-bold">下一步操作</h2>
        {/*
          V6 §5.8: 下一步按鈕「永遠可見」。未達前置條件 → disabled + 灰字說明，
          讓店主看見完整流程（未付款也看得到之後要按「標出貨」）。
          可點性只是可發現性提示；真正授權由 server SQL guard 把關（mark-paid /
          mark-shipped 各自檢查 expected_state，disabled 與之雙保險）。
          已出貨 → 兩個按鈕都 disabled，下方顯示出貨摘要。
        */}
        <ol class="space-y-3">
          {/* 步驟 1：標為已付款 */}
          <li>
            <button
              type="button"
              id="mark-paid"
              data-step="paid"
              disabled={order.paid}
              class="w-full inline-flex items-center justify-center rounded bg-emerald-600 px-4 py-3 min-h-[44px] text-base font-medium text-white hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed"
            >
              {order.paid ? "✓ 已付款" : "標為已付款"}
            </button>
            {order.paid && (
              <p class="mt-1 text-xs text-gray-500">已於收款後標記，可繼續出貨。</p>
            )}
          </li>

          {/* 步驟 2：標為已出貨（含物流單號）。未付款 → 整組 disabled + 說明 */}
          <li>
            <div class="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                id="tracking-input"
                placeholder="物流單號（選填）"
                value={order.tracking_no ?? ""}
                maxlength="100"
                disabled={!order.paid || order.shipped}
                class="flex-1 rounded border border-gray-300 px-3 py-3 min-h-[44px] text-base focus-visible:outline-2 focus-visible:outline-mango-500 focus-visible:outline-offset-2 disabled:bg-gray-100 disabled:text-gray-400"
                aria-label="物流單號"
              />
              <button
                type="button"
                id="mark-shipped"
                data-step="ship"
                disabled={!order.paid || order.shipped}
                class="inline-flex items-center justify-center rounded bg-blue-600 px-4 py-3 min-h-[44px] text-base font-medium text-white hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
              >
                {order.shipped ? "✓ 已出貨" : "標為已出貨"}
              </button>
            </div>
            {!order.paid && (
              <p class="mt-1 text-xs text-gray-500">需先標記已付款，才能標出貨。</p>
            )}
            {order.shipped && (
              <p class="mt-1 text-xs text-gray-700">
                出貨時間 {order.shipped_at ? formatTaipei(order.shipped_at) : "—"}
                {order.tracking_no && ` ／ 物流 ${order.tracking_no}`}
              </p>
            )}
          </li>

          {/* 取消：僅未付款（server 真實 guard：付款後不可取消）。不符條件不渲染按鈕，
              改顯示說明，避免給出一個「按了一定失敗」的紅按鈕。 */}
          {isAdmin && (
            <li class="border-t border-gray-100 pt-3">
              {cancellable ? (
                <button
                  type="button"
                  id="cancel-order"
                  class="w-full inline-flex items-center justify-center rounded border border-red-400 px-4 py-3 min-h-[44px] text-base text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  取消訂單
                </button>
              ) : (
                <p class="text-xs text-gray-400">已付款或已出貨的訂單無法取消。</p>
              )}
            </li>
          )}
        </ol>
      </section>
    )}
  ```

- [ ] **client 保險**：因為按鈕現在永遠存在，補一個「disabled 不送出」的早退，避免任何意外路徑觸發 fetch。找到 `[id].astro` 既有的 mark-paid / mark-shipped 綁定（約 826-833 行）：

  **OLD**：
  ```javascript
    document.getElementById("mark-paid")?.addEventListener("click", () => {
      statusEvent("/mark-paid", {}, "標為已付款");
    });
    document.getElementById("mark-shipped")?.addEventListener("click", () => {
      const trackingInput = document.getElementById("tracking-input") as HTMLInputElement | null;
      const trackingNo = trackingInput?.value.trim() ?? "";
      statusEvent("/mark-shipped", { tracking_no: trackingNo }, "標為已出貨");
    });
  ```

  **NEW**：
  ```javascript
    document.getElementById("mark-paid")?.addEventListener("click", (e) => {
      // Buttons now always render; a disabled next-step must never POST.
      if ((e.currentTarget as HTMLButtonElement).disabled) return;
      statusEvent("/mark-paid", {}, "標為已付款");
    });
    document.getElementById("mark-shipped")?.addEventListener("click", (e) => {
      if ((e.currentTarget as HTMLButtonElement).disabled) return;
      const trackingInput = document.getElementById("tracking-input") as HTMLInputElement | null;
      const trackingNo = trackingInput?.value.trim() ?? "";
      statusEvent("/mark-shipped", { tracking_no: trackingNo }, "標為已出貨");
    });
  ```

- [ ] **GREEN（層 1）**：跑斷言 + 編譯閘：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 2/,/Task 3/p' && echo "--- astro check ---" && bunx astro check 2>&1 | tail -2
  ```
  預期 Task 2 段 4 條全 `PASS`；`astro check` error 數 ≤ 基線。
- [ ] **層 2（gstack 實機驗收，需登入後台）**：用 `/browse` skill：
  1. 開啟一張**未付款**訂單詳情 `http://localhost:4321/admin/orders/<某未付款單號>`。
  2. 斷言：`#mark-paid` 文字為「標為已付款」且 **enabled**；`#mark-shipped` **disabled**，其下方可見灰字「需先標記已付款，才能標出貨。」；`#tracking-input` disabled。
  3. 開啟一張**已付款未出貨**訂單：`#mark-paid` 顯示「✓ 已付款」且 disabled；`#mark-shipped` enabled；物流輸入框 enabled。
  4. 開啟一張**已出貨**訂單：兩按鈕皆 disabled、各顯示「✓ …」；可見出貨時間/物流摘要。
  5. 開啟一張**已取消**訂單：整個「下一步操作」section 不出現（`order.cancelled_at !== null`）。
  - 截圖留證（未付款 / 已付款 / 已出貨 三態）。
- [ ] **Commit**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/orders/\[id\].astro scripts/p9-ux-assert.sh && git commit -m "feat(orders-ux): always-visible next-step panel with disabled+reason (§5.8)

Replace disappearing conditional buttons on order detail with a persistent
status-flow card: 標為已付款 / 標為已出貨 always render, disabled with an
inline explanation when prerequisites are unmet. Server SQL guards remain
authoritative; client adds a disabled-no-POST guard.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3 — 訂單詳情：編輯區明確視覺提示（編輯流程簡化）

**spec §5.8**：訂單編輯流程簡化、編輯區明確視覺提示。

**現況**（`[id].astro:146-191`）：品項區標題只有「品項 (…)」，可編輯（`itemsEditable && isAdmin`，即未付款）與唯讀兩種渲染外觀幾乎一樣，店主看不出「現在這張單可以改品項 / 改地址，改完要按底部儲存列」。客人資訊區（地址/備註，`recipientEditable`）同理沒有「這是可編輯欄位」的視覺暗示。

**改法（純視覺提示，不動 StickyBar 行為、不動 save 契約）**：
1. 品項區標題旁，當 `itemsEditable && isAdmin` 時加一枚「編輯模式」徽章 + 一行說明「僅未付款訂單可修改品項，改完按下方〈儲存〉。」
2. 客人資訊區（`data-dirty-track="recipient"`）當 `recipientEditable` 時，於 `<h2>客人資訊</h2>` 旁加「可編輯」提示徽章，讓地址/備註的輸入框有來由。

> ⚠️ 不改 StickyBar（spec 提到「StickyBar 改為視線內浮動」，但 `StickyBar.astro` 的註解明載目前刻意 bottom-fixed full-width、且 §5.8 範圍是「不改既有 API 行為、聚焦可發現性」；移動 StickyBar 屬跨頁共用元件改動且其註解記錄過「曾浮在內容上被改回」的教訓，超出本 UI 模組安全範圍）。**本 Task 只在頁面內加靜態提示，不碰 StickyBar 元件**。此決策列入 open_concerns 供總編裁定是否另開子任務。

**Files**
- Modify: `src/pages/admin/orders/[id].astro`（品項區 `<h2 id="items-title">` 周邊；客人資訊區 `<h2>客人資訊</h2>` 周邊）
- Test: `scripts/p9-ux-assert.sh` Task 3 段 + `bunx astro check`

**Steps**

- [ ] **RED**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 3/,/Task 4/p'
  ```
  預期 2 條 FAIL（「編輯模式」、「僅未付款訂單可修改品項」）。

- [ ] 改品項區標題。找到（`[id].astro:147`）：

  **OLD**：
  ```astro
      <h2 class="mb-3 text-lg font-bold" id="items-title">品項 ({itemsToReadable(items)})</h2>
  ```
  **NEW**：
  ```astro
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-bold" id="items-title">品項 ({itemsToReadable(items)})</h2>
        {itemsEditable && isAdmin && (
          <span class="inline-flex items-center rounded-full bg-mango-100 px-2 py-0.5 text-xs font-medium text-mango-700">
            編輯模式
          </span>
        )}
      </div>
      {itemsEditable && isAdmin && (
        <p class="mb-3 -mt-1 text-xs text-gray-500">
          僅未付款訂單可修改品項；改完按下方〈儲存〉送出。
        </p>
      )}
  ```

- [ ] 改客人資訊區標題。找到（`[id].astro:101`）：

  **OLD**：
  ```astro
      <h2 class="mb-3 text-lg font-bold">客人資訊</h2>
  ```
  **NEW**：
  ```astro
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-bold">客人資訊</h2>
        {recipientEditable && (
          <span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            可編輯
          </span>
        )}
      </div>
  ```

- [ ] **GREEN（層 1）**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 3/,/Task 4/p' && echo "--- astro check ---" && bunx astro check 2>&1 | tail -2
  ```
  預期 Task 3 段 2 條 `PASS`；`astro check` ≤ 基線。
- [ ] **層 2（gstack）**：開未付款訂單 → 品項標題旁見「編輯模式」徽章 + 說明列；客人資訊標題旁見「可編輯」徽章。開已付款訂單 → 品項區無「編輯模式」徽章（改唯讀表格），但客人資訊仍「可編輯」（地址/備註付款後仍可改，符合 `recipientEditable = isAdmin && cancelled_at===null`）。截圖兩態。
- [ ] **Commit**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/orders/\[id\].astro scripts/p9-ux-assert.sh && git commit -m "feat(orders-ux): editable-section affordances on order detail (§5.8)

Add 編輯模式 / 可編輯 badges and an inline hint so the admin can tell which
sections are editable and that changes are saved via the bottom sticky bar.
No StickyBar/save-contract changes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4 — 訂單列表：批次選取狀態（勾選變色 +「已選 N 筆」高亮）

**spec §5.8**：批次操作 UX — 勾選後按鈕變色 +「✓ 已選 N 筆」提示。

**現況**（`index.astro:118-142, 203-258`）：工具列已有「選 N 筆」與 `select-all`，但：未選時與已選時工具列外觀一樣；勾選的列沒有任何高亮；按鈕 disabled 用 `disabled:opacity-40`，啟用後也只是恢復原色，沒有「已就緒」的強調。店主難以一眼確認「我選了哪些、選了幾筆、現在可不可以批次操作」。

**改法（純前端強化，不動 fetch / 不動 `bulk-mark-shipped` body）**：
1. 工具列容器加 `data-batch-bar`，並在 JS `refresh()` 中，依「是否有選取」切換工具列底色（有選取 → `bg-mango-50 ring-1 ring-mango-300`；無 → `bg-gray-50`）。
2. 文案「選 N 筆」→「✓ 已選 N 筆」(有選取時) / 「未選取」(0 筆時)。
3. 勾選的 `<li>` 加 `row-selected`（`bg-mango-50`）高亮——在 `change` 時依該列 checkbox 狀態 toggle。

**Files**
- Modify: `src/pages/admin/orders/index.astro`（工具列 markup `118-142`、列 markup `146`、`<script>` 內 `refresh()` 與 change 監聽 `218-237`）
- Test: `scripts/p9-ux-assert.sh` Task 4 段 + `bunx astro check`

**Steps**

- [ ] **RED**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 4/,/Task 5/p'
  ```
  預期 3 條 FAIL（「已選」、`data-batch-bar`、`row-selected`）。

- [ ] 改工具列容器（加 `data-batch-bar` + id 便於 JS 取得 + 初始 class）。找到（`index.astro:118`）：

  **OLD**：
  ```astro
      <div class="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3">
        <label class="text-sm">
          <input type="checkbox" id="select-all" class="mr-1" />
          全選
        </label>
        <span class="ml-auto text-sm text-gray-600">
          選 <span id="selected-count">0</span> 筆
        </span>
  ```
  **NEW**：
  ```astro
      <div
        id="batch-bar"
        data-batch-bar
        class="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3 transition-colors"
      >
        <label class="text-sm">
          <input type="checkbox" id="select-all" class="mr-1" />
          全選
        </label>
        <span id="selected-label" class="ml-auto text-sm font-medium text-gray-500">
          未選取
        </span>
  ```
  > 註：移除了原本內嵌的 `<span id="selected-count">`，計數改由 `#selected-label` 整串文字呈現（JS 控制）。下一步要同步改 JS 不再讀 `selected-count`。

- [ ] 改列 markup，讓每個 `<li>` 可被高亮。找到（`index.astro:146`）：

  **OLD**：
  ```astro
          <li class="flex flex-wrap items-center gap-3 px-4 py-3">
  ```
  **NEW**：
  ```astro
          <li class="order-row flex flex-wrap items-center gap-3 px-4 py-3 transition-colors">
  ```

- [ ] 改 `<script>`：`refresh()` 內更新文案 + 工具列底色，並新增「逐列高亮」。找到 script 中的 `selectedCountEl` 宣告與 `refresh()`（`index.astro:208`、`218-228`）。

  **OLD**（宣告區，`index.astro:204-212`）：
  ```javascript
    const form = document.getElementById("batch-form") as HTMLFormElement;
    const selectAll = document.getElementById("select-all") as HTMLInputElement;
    const rowCheckboxes = () =>
      Array.from(form.querySelectorAll<HTMLInputElement>(".row-checkbox"));
    const selectedCountEl = document.getElementById("selected-count")!;
    const gotoPickBtn = document.getElementById("goto-pick") as HTMLButtonElement;
    const bulkShipBtn = document.getElementById(
      "bulk-mark-shipped",
    ) as HTMLButtonElement;
  ```
  **NEW**：
  ```javascript
    const form = document.getElementById("batch-form") as HTMLFormElement;
    const selectAll = document.getElementById("select-all") as HTMLInputElement;
    const rowCheckboxes = () =>
      Array.from(form.querySelectorAll<HTMLInputElement>(".row-checkbox"));
    const selectedLabelEl = document.getElementById("selected-label")!;
    const batchBarEl = document.getElementById("batch-bar")!;
    const gotoPickBtn = document.getElementById("goto-pick") as HTMLButtonElement;
    const bulkShipBtn = document.getElementById(
      "bulk-mark-shipped",
    ) as HTMLButtonElement;

    // Highlight a row's <li> whenever its checkbox flips.
    function paintRow(cb: HTMLInputElement): void {
      const li = cb.closest("li");
      if (!li) return;
      li.classList.toggle("row-selected", cb.checked);
      li.classList.toggle("bg-mango-50", cb.checked);
    }
  ```

  **OLD**（`refresh()`，`index.astro:218-228`）：
  ```javascript
    function refresh() {
      const sel = checked();
      selectedCountEl.textContent = String(sel.length);
      gotoPickBtn.disabled = sel.length === 0;
      // Bulk-mark-shipped only on paid + un-shipped rows
      bulkShipBtn.disabled =
        sel.length === 0 ||
        sel.some(
          (c) => c.dataset.paid !== "1" || c.dataset.shipped === "1",
        );
    }
  ```
  **NEW**：
  ```javascript
    function refresh() {
      const sel = checked();
      const n = sel.length;
      // §5.8: "✓ 已選 N 筆" when any selected; muted "未選取" at zero.
      if (n > 0) {
        selectedLabelEl.textContent = `✓ 已選 ${n} 筆`;
        selectedLabelEl.classList.remove("text-gray-500");
        selectedLabelEl.classList.add("text-mango-700");
        batchBarEl.classList.remove("bg-gray-50");
        batchBarEl.classList.add("bg-mango-50", "ring-1", "ring-mango-300");
      } else {
        selectedLabelEl.textContent = "未選取";
        selectedLabelEl.classList.add("text-gray-500");
        selectedLabelEl.classList.remove("text-mango-700");
        batchBarEl.classList.add("bg-gray-50");
        batchBarEl.classList.remove("bg-mango-50", "ring-1", "ring-mango-300");
      }
      gotoPickBtn.disabled = n === 0;
      // Bulk-mark-shipped only on paid + un-shipped rows
      bulkShipBtn.disabled =
        n === 0 ||
        sel.some(
          (c) => c.dataset.paid !== "1" || c.dataset.shipped === "1",
        );
    }
  ```

- [ ] 在 `select-all` 與 `form change` 監聽中，同步重繪列高亮。找到（`index.astro:230-237`）：

  **OLD**：
  ```javascript
    selectAll.addEventListener("change", () => {
      rowCheckboxes().forEach((c) => (c.checked = selectAll.checked));
      refresh();
    });

    form.addEventListener("change", (e) => {
      if ((e.target as HTMLElement).classList.contains("row-checkbox")) refresh();
    });
  ```
  **NEW**：
  ```javascript
    selectAll.addEventListener("change", () => {
      rowCheckboxes().forEach((c) => {
        c.checked = selectAll.checked;
        paintRow(c);
      });
      refresh();
    });

    form.addEventListener("change", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("row-checkbox")) {
        paintRow(t as HTMLInputElement);
        refresh();
      }
    });
  ```

- [ ] **GREEN（層 1）**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 4/,/Task 5/p' && echo "--- astro check ---" && bunx astro check 2>&1 | tail -2
  ```
  預期 Task 4 段 3 條 `PASS`；`astro check` ≤ 基線。
- [ ] **層 2（gstack）**：開 `http://localhost:4321/admin/orders`：
  1. 初始：工具列灰底、右側顯示「未選取」、兩個批次按鈕 disabled。
  2. 勾一列 → 該 `<li>` 變淡橘底（`row-selected`/`bg-mango-50`）；工具列轉淡橘底 + 橘色外框；文字變「✓ 已選 1 筆」。
  3. 點「全選」→ 所有列高亮、文字「✓ 已選 N 筆」。
  4. 全部取消 → 回到「未選取」灰底。
  - 截圖「未選取」與「已選 N 筆」兩態。
- [ ] **Commit**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/orders/index.astro scripts/p9-ux-assert.sh && git commit -m "feat(orders-ux): batch selection affordances on order list (§5.8)

Selecting rows now tints the toolbar (mango) and highlights each chosen
<li>; the counter reads ✓ 已選 N 筆 / 未選取. No change to bulk endpoints
or request bodies.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5 — 訂單列表：批次按鈕文案 + 批次標出貨確認列出單號 + toast 具體化

**spec §5.8**：「一鍵生揀貨單」→「生成揀貨單」；「批次標已出貨」加確認框列出單號；toast 訊息具體化（「已標 3 筆為已出貨」而非「已儲存」）。

**現況**（`index.astro:126-141, 247-258`）：
- 按鈕文字「一鍵生揀貨單」「批次標已出貨」。
- 批次標出貨用 `confirm(\`確定把 ${ids.length} 筆訂單標為已出貨？\`)` —— 只給筆數，沒列單號；店主無法核對。
- 成功後直接 `location.reload()`，沒有「已標 N 筆」的明確回饋。

**改法（不動 fetch URL / body / server 契約）**：
1. 按鈕文字：「一鍵生揀貨單」→「生成揀貨單」；「批次標已出貨」→「批次標為已出貨」（更口語完整，符合詳情頁「標為已出貨」一致用語）。
2. 確認改用既有 `Modal.astro`（`<dialog>`，原生 a11y），列出將被標記的單號清單；確認後才 fetch。沿用 `index.astro` 已 import 的模式——但本頁目前**沒有** import `Modal`，需在 frontmatter import 並在模板放一個 `<Modal id="bulk-ship-modal" ...>`，動態把單號塞進其 slot 區。
3. 成功後改用 `flashToast`（跨 reload 顯示，沿用 `[id].astro` 與 `toast.ts` 模式）寫「已標 N 筆為已出貨」再 reload。

> ⚠️ `bulk-mark-shipped.ts` 是「盡力批次」——server 只標記 `paid=1 AND shipped=0 AND cancelled_at IS NULL` 的單。前端按鈕已限定只在「全選列皆 paid 且未 shipped」才 enabled（Task 4 的 `bulkShipBtn.disabled` 條件），故 modal 列出的單號即為實際會被處理者，無誤導。toast 文案用前端 `ids.length`（與按鈕 enabled 前提一致）。

**Files**
- Modify: `src/pages/admin/orders/index.astro`（frontmatter import `Modal`；按鈕文字 `133/141`；模板尾加 `<Modal>`；`<script>` 內 `bulkShipBtn` click handler `247-258` 改走 modal + flashToast）
- Test: `scripts/p9-ux-assert.sh` Task 5 段 + `bunx astro check`

**Steps**

- [ ] **RED**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 5/,/Task 6/p'
  ```
  預期 4 條 FAIL（舊「一鍵生揀貨單」仍在→absent 斷言 FAIL；「生成揀貨單」缺；「以下 」缺；「筆為已出貨」缺）。

- [ ] frontmatter import `Modal`。找到 `index.astro` 開頭 import 區（`index.astro:1-9`），在現有 import 後加一行。

  **OLD**（`index.astro:2`）：
  ```astro
  import Layout from "../../../layouts/Layout.astro";
  ```
  **NEW**：
  ```astro
  import Layout from "../../../layouts/Layout.astro";
  import Modal from "../../../components/admin/Modal.astro";
  ```

- [ ] 改兩個按鈕文字。找到（`index.astro:133` 與 `141`）：

  **OLD**（揀貨單按鈕內容）：
  ```astro
          一鍵生揀貨單
  ```
  **NEW**：
  ```astro
          生成揀貨單
  ```

  **OLD**（批次出貨按鈕內容）：
  ```astro
          批次標已出貨
  ```
  **NEW**：
  ```astro
          批次標為已出貨
  ```

- [ ] 在 `</Layout>` 之前、`<script>` 之前的模板區插入批次確認 Modal。找到 `index.astro` 中 `</main>` 後、`<script>` 前的位置（`index.astro:201` 的 `</main>` 與 `203` 的 `<script>` 之間），插入：

  **在 `  </main>` 之後、`  <script>` 之前插入 NEW**：
  ```astro
    <Modal
      id="bulk-ship-modal"
      title="批次標為已出貨"
      confirmLabel="確認標記"
    >
      <p class="mb-2">以下 <span id="bulk-ship-count" class="font-semibold">0</span> 筆訂單將標為已出貨：</p>
      <ul id="bulk-ship-list" class="max-h-48 overflow-y-auto rounded border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs leading-6"></ul>
    </Modal>
  ```

- [ ] 改批次出貨 click handler 走 Modal + flashToast。先在 `<script>` 頂部 import `flashToast`（目前 `index.astro` 的 script 無 import）。找到 `<script>` 開頭（`index.astro:203-204`）：

  **OLD**：
  ```astro
    <script>
      const form = document.getElementById("batch-form") as HTMLFormElement;
  ```
  **NEW**：
  ```astro
    <script>
      import { flashToast } from "../../../lib/toast";
      const form = document.getElementById("batch-form") as HTMLFormElement;
  ```

  **OLD**（批次出貨 handler，`index.astro:247-258`）：
  ```javascript
    bulkShipBtn.addEventListener("click", async () => {
      const ids = checked().map((c) => c.value);
      if (!ids.length) return;
      if (!confirm(`確定把 ${ids.length} 筆訂單標為已出貨？`)) return;
      const res = await fetch("/api/admin/orders/bulk-mark-shipped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) location.reload();
      else alert("失敗：" + (await res.text()));
    });
  ```
  **NEW**：
  ```javascript
    const bulkShipDlg = document.getElementById("bulk-ship-modal") as HTMLDialogElement | null;
    const bulkShipCountEl = document.getElementById("bulk-ship-count");
    const bulkShipListEl = document.getElementById("bulk-ship-list");

    async function performBulkShip(ids: string[]): Promise<void> {
      const res = await fetch("/api/admin/orders/bulk-mark-shipped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        // §5.8: concrete success message survives the reload via flashToast.
        flashToast(`已標 ${ids.length} 筆為已出貨`, { kind: "success" });
        location.reload();
      } else {
        flashToast(`批次標出貨失敗：${await res.text()}`, { kind: "error" });
        location.reload();
      }
    }

    bulkShipBtn.addEventListener("click", () => {
      const ids = checked().map((c) => c.value);
      if (!ids.length) return;
      // §5.8: confirm dialog lists every order id so the shopkeeper can verify.
      if (bulkShipCountEl) bulkShipCountEl.textContent = String(ids.length);
      if (bulkShipListEl) {
        bulkShipListEl.innerHTML = "";
        for (const id of ids) {
          const li = document.createElement("li");
          li.textContent = id;
          bulkShipListEl.appendChild(li);
        }
      }
      bulkShipDlg?.showModal();
    });

    bulkShipDlg
      ?.querySelector("[data-modal-confirm]")
      ?.addEventListener("click", () => {
        const ids = checked().map((c) => c.value);
        bulkShipDlg.close();
        if (ids.length) performBulkShip(ids);
      });
  ```

- [ ] 在 script 尾端（任何既有程式之後）補一行：頁面載入時消費上一頁 reload 排入的 flash toast。找到 script 結尾 `</script>`（`index.astro:259`）前，先確認是否已有 `consumeFlash`：本頁原本沒有。加入 import 與呼叫。

  在上一步已加的 `import { flashToast } from "../../../lib/toast";` 改為同時引入 `consumeFlash`：

  **OLD**：
  ```javascript
      import { flashToast } from "../../../lib/toast";
  ```
  **NEW**：
  ```javascript
      import { flashToast, consumeFlash } from "../../../lib/toast";
  ```

  並在 `refresh();`（script 內既有的初始呼叫；找 `index.astro` script 中最後一個獨立 `refresh();`，若無則在 `</script>` 前）之前/後加上 `consumeFlash();`。為定位明確，在 script 最末、`</script>` 之前插入：

  **在 `bulkShipBtn` 相關程式碼之後（script 邏輯尾端）插入 NEW**：
  ```javascript
    // Show any toast queued by a previous reload (bulk-ship result).
    consumeFlash();
  ```

  > 驗證 import 是否乾淨：`grep -n "consumeFlash\|flashToast" src/pages/admin/orders/index.astro` 應同時看到 import 行與兩處使用。`astro check` 會抓未使用 import；若 `consumeFlash` 報未使用代表插入點漏了，補上呼叫。

- [ ] **GREEN（層 1）**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 5/,/Task 6/p' && echo "--- astro check ---" && bunx astro check 2>&1 | tail -2
  ```
  預期 Task 5 段 4 條 `PASS`；`astro check` ≤ 基線。
- [ ] **層 2（gstack）**：開 `http://localhost:4321/admin/orders`：
  1. 揀貨單按鈕文字為「生成揀貨單」；批次按鈕為「批次標為已出貨」。
  2. 勾數張**已付款未出貨**訂單 → 批次按鈕 enabled → 點它 → 彈出 `<dialog>`，標題「批次標為已出貨」，內文「以下 N 筆訂單將標為已出貨：」並逐行列出單號（monospace）。
  3. 點「取消」→ dialog 關閉、無 fetch。再點按鈕 → 點「確認標記」→ 觸發 fetch、reload 後右上角出現 toast「已標 N 筆為已出貨」。
  - 截圖 modal 列單號 + 成功 toast。
  > 若沒有合適測試訂單，可在 stage/本機建 `test-` 前綴訂單後標已付款再測（建單流程不在本模組，借用既有後台操作）。
- [ ] **Commit**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/orders/index.astro scripts/p9-ux-assert.sh && git commit -m "feat(orders-ux): clearer batch labels + id-listing confirm + concrete toast (§5.8)

一鍵生揀貨單→生成揀貨單; 批次標已出貨→批次標為已出貨. Bulk-ship now
confirms via a <dialog> that lists every order id, and reports 已標 N 筆為
已出貨 via flashToast. Endpoint/body unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6 — 代客建單：返回連結文案「← 返回訂單列表」

**spec §5.8**：代客建單頁加「← 返回訂單列表」（`new.astro:49`）。

**現況**（`new.astro:49`）：已有 `<a href="/admin/orders" ...>← 訂單列表</a>`。spec 明確要求文案為「← 返回訂單列表」（與其他頁面一致、語意更清楚「這是返回動作」）。此為純文字微調。

> 一致性備註：詳情頁 `[id].astro:87` 用「← 訂單列表」、列表頁 `index.astro:92` 用「← 後台首頁」。spec 只點名 `new.astro` 要改為「返回訂單列表」，故本 Task 僅改 `new.astro`（不擴張到其他頁，避免越界；其他頁返回連結一致化屬 §5.7 後台導航模組，非 §5.8）。

**Files**
- Modify: `src/pages/admin/orders/new.astro`（`new.astro:49`）
- Test: `scripts/p9-ux-assert.sh` Task 6 段 + `bunx astro check`

**Steps**

- [ ] **RED**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 6/,/$/p'
  ```
  預期「返回訂單列表」FAIL（現文案無「返回」二字）。
- [ ] 改連結文字。找到（`new.astro:49`）：

  **OLD**：
  ```astro
        <a href="/admin/orders" class="text-sm text-gray-600 underline">← 訂單列表</a>
  ```
  **NEW**：
  ```astro
        <a href="/admin/orders" class="text-sm text-gray-600 underline">← 返回訂單列表</a>
  ```
- [ ] **GREEN（層 1）**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh 2>&1 | sed -n '/Task 6/,/$/p' && echo "--- astro check ---" && bunx astro check 2>&1 | tail -2
  ```
  預期 Task 6 段 `PASS`；`astro check` ≤ 基線。
- [ ] **層 2（gstack）**：開 `http://localhost:4321/admin/orders/new` → 左上連結文字為「← 返回訂單列表」，點擊導回 `/admin/orders`。
- [ ] **Commit**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git add src/pages/admin/orders/new.astro scripts/p9-ux-assert.sh && git commit -m "feat(orders-ux): clearer back link on 代客建單 (§5.8)

← 訂單列表 → ← 返回訂單列表 on the admin order-create page.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7 — 模組收尾：全綠驗收 + 完整編譯/型別閘 + 回歸快查

**目的**：確認 §5.8 所有條目達成、沒有破壞既有訂單頁行為、`astro check` 不增 error。

**Files**
- Modify: 無（驗證）

**Steps**

- [ ] **整批 GREEN**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bash scripts/p9-ux-assert.sh; echo "exit=$?"
  ```
  預期最後兩行：
  ```
  ALL GREEN ✅
  exit=0
  ```
- [ ] **型別 / 模板編譯閘（完整）**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && bunx astro check 2>&1 | tail -4
  ```
  預期 error 數 ≤ Task 0 記下的基線（理想 `0 errors`）。**若新增了 error，回到對應 Task 修正後重跑。**
- [ ] **回歸快查（grep，確認沒誤刪關鍵 handler / 契約字串）**——以下每條都應有輸出（存在即綠）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && \
  echo "[1] mark-paid handler 仍在" && grep -c 'getElementById("mark-paid")' src/pages/admin/orders/\[id\].astro && \
  echo "[2] mark-shipped handler 仍在" && grep -c 'getElementById("mark-shipped")' src/pages/admin/orders/\[id\].astro && \
  echo "[3] cancel modal flow 仍在" && grep -c 'cancel-order-modal' src/pages/admin/orders/\[id\].astro && \
  echo "[4] save 契約 fetch 仍在" && grep -c '/save' src/pages/admin/orders/\[id\].astro && \
  echo "[5] bulk endpoint URL 未變" && grep -c '/api/admin/orders/bulk-mark-shipped' src/pages/admin/orders/index.astro && \
  echo "[6] 揀貨單導頁未變" && grep -c '/admin/batches/new' src/pages/admin/orders/index.astro && \
  echo "[7] 列仍帶 data-paid/data-shipped" && grep -c 'data-shipped=' src/pages/admin/orders/index.astro
  ```
  預期每個 echo 標題後跟一個 `>=1` 的數字（特別是 `[1]`~`[7]` 都 ≥1；`[4]/save` 計數因註解可能 >1）。**任一為 0 代表誤刪，須回查。**
- [ ] **確認未觸碰禁區**（應為空輸出）：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git diff --name-only main...HEAD -- 'src/pages/api/**' 'src/db/**' 'drizzle/**' 'wrangler.jsonc' 'package.json' 'src/lib/**' 'src/components/**'
  ```
  預期：**空輸出**（本模組只改 3 個 `.astro` 頁 + 1 個 `scripts/*.sh`，沒碰 API/schema/lib/共用元件）。
- [ ] **本模組改檔清單核對**：
  ```bash
  cd /Users/rayhsu/Projects/Github/mango-hsu && git diff --name-only main...HEAD
  ```
  預期恰好（順序不拘）：
  ```
  scripts/p9-ux-assert.sh
  src/pages/admin/orders/[id].astro
  src/pages/admin/orders/index.astro
  src/pages/admin/orders/new.astro
  ```
- [ ] **（建議）整體視覺回歸**：用 `/design-review` 或 `/qa` skill 對 `/admin/orders`、`/admin/orders/<id>`（三種狀態）、`/admin/orders/new` 做一輪視覺巡檢，確認版面無破圖、按鈕 hit-area ≥44px（既有規範）、色彩對比 OK。截圖歸檔。
- [ ] 本 Task 不 commit（純驗證）。模組完成，待總編彙整後一併進 §9 第 8 步整合測試。

---

## 附錄 A：執行者注意事項與決策紀錄

1. **為何沒有 `.test.ts`**：本 repo 無 DOM 測試框架；§5.8 是純展示層整頓。以 `bunx astro check`（編譯/型別閘，確定性）+ `scripts/p9-ux-assert.sh`（源碼契約斷言，確定性、RED→GREEN）+ gstack 實機視覺（人工驗收）三者取代之。`p9-ux-assert.sh` 不被 `bun test`/`astro build` 收集，純開發期 gate。
2. **StickyBar 不移動**：spec §5.8 提「StickyBar 改為視線內浮動」，但 `StickyBar.astro` 是跨頁共用元件，其註解明載「曾因浮在內容上覆蓋資料而被改回 bottom-fixed full-width」。移動它風險高且影響其他頁（products 列表也用），超出「不改既有行為、聚焦可發現性」的安全範圍。本模組改以**頁面內靜態編輯提示**（Task 3）達成「讓店主知道改完要存」的同等可發現性目標。→ 列入 open_concerns 待總編裁定是否另開子任務動共用元件。
3. **disabled 按鈕的授權語意**：永遠可見的「下一步」按鈕 disabled **只是 UI 提示**，真正授權仍由各 status API 的 server 端 `expected_state` SQL guard 把關（mark-paid/mark-shipped/cancel 不在本模組改動）。client 另加 `if (disabled) return` 早退作雙保險。
4. **批次 modal 不誤導**：批次標出貨按鈕僅在「全選列皆 paid 且未 shipped」才 enabled（既有 `bulkShipBtn.disabled` 條件，Task 4 保留），故 modal 列出的單號即實際會被 server 標記者；`bulk-mark-shipped.ts` 的 `WHERE paid=1 AND shipped=0 AND cancelled_at IS NULL` 不變。
5. **不擴張到其他頁返回連結一致化**：詳情頁/列表頁返回連結文案的全站一致化屬 §5.7（後台導航/可發現性）模組，本模組嚴守 §5.8 點名範圍，只改 `new.astro`。
6. **行號漂移**：每完成一個 Task，後續 Task 的「OLD 區塊」行號可能位移；所有 Edit 以**內容精確比對**為準（OLD 字串唯一），行號僅作定位參考。若某 OLD 字串因前一 Task 已被改動而不再唯一/不存在，依該 Task 的 grep 定位指令重新確認。
