# TODOS

Deferred work surfaced during V5.2 design + eng review (2026-05-12). Each item lists why, what we'd gain, and what's blocking or sequencing.

---

## 1. 鮮芒果 product line 上架

**What**：在現有 `seasons` / `product_groups` / `products` 模型上加新 product_group「鮮芒果」(可能再分品種如愛文鮮果、玉文鮮果)，新 SKU 用 `package_fen = 1000` (10 斤箱)。

**Why**：D4 對話中明確提到「未來要賣芒果也是用斤計算，會變成10斤一箱」。V5.2 schema 已預留容納（INT `package_fen` 可裝 10000+ fen，product_group 可加新 row）— **不需要 schema migration**，純資料 + UI 設定。

**Pros**：
- 商品線擴張，季節性商品多元化
- V5.2 model 設計時就以這個為驗證 case，所以零工程風險
- 進貨對話框 (PR2) 直接套用、不用改 endpoint

**Cons**：
- 鮮果保鮮期短（天級），不像芒果乾可以放幾個月 — 可能反而會 trigger 需要 batches/expiry 表（見 #3）
- 物流可能跟既有不同（冷藏 / 隔日達等）— 出貨流程要重新評估
- 客戶下單後到出貨的窗期短，operator workflow 壓力大

**Context**：mango-hsu 家族目前主賣芒果乾（產季結束後可長期賣），鮮果只在產季 6-7 月銷售。考慮從一個品種試水溫（例如愛文鮮果 10 斤箱）、看物流 + operator workflow 撐不撐得住，再擴大到第二品種。

**Depends on / blocked by**：
- V5.2 PR1 + PR2 上線（admin 進貨對話框 + group-centric UI 必須先 ship）
- 物流方案 + 冷藏配送決策（外部依賴、非工程）
- 若需要 batches table（#3）就連動

---

## 2. Pre-pack ledger trigger（Premise 6 風險監控）

**What**：當 operator 開始抱怨「總斤數夠但 X 包不夠」、或拒絕拆裝重組時，加一張 `sku_pack_count` 表記錄各 SKU 的實際裝包數量；保留 `product_groups.stock_fen` 為 source of truth、ledger 平行追蹤實裝。

**Why**：V5.2 Premise 6 假設「stock 在 group fen pool 是 fungible 直到出貨時才裝包」。現在芒果乾烘製流程確實 loose stock + on-demand packing，假設成立。但鮮果未來若改「進貨即 10 斤箱、不拆」，pool fen 就跟 derived 包數不再一致 — 會出現「總斤數夠但 1 斤箱不夠」現象（撕箱重組麻煩）。

**Pros**：
- 不影響現有 model（純加表）
- V5.2 已在 `src/lib/stock.ts` 檔頭 doc comment 標出 trigger 條件，未來看到 trigger signal 就知道該做這個
- 可以分階段：先只記錄、不 enforce；觀察一兩個月再決定 SKU 級 CAS

**Cons**：
- 多一張表 + 多一份 source of truth（雖然主從關係明確）
- Reconcile script 要擴展為「fen pool ↔ pack ledger ↔ orders 三邊對帳」
- 進貨流程要決定「進來就裝」還是「進來放 pool、出貨時記裝」

**Context**：這是 conditional TODO — 只有觀察到 trigger signal 才做。Trigger signals (in `src/lib/stock.ts` doc comment)：
- (a) operator 講出「總斤數夠但 X 包不夠」
- (b) admin 拒絕拆裝重組
- (c) 進貨工作流程顯示「箱裝到貨」而非「散裝到貨」

**Depends on / blocked by**：
- Trigger signal 出現（被動觸發、不主動排）
- 鮮果 product line（#1）若上架且採「箱裝到貨」會自動觸發

---

## 3. Batches / FIFO / expiry / 進貨成本

**What**：加一張 `product_intakes` (id, group_id, weight_fen, intake_date, cost_per_jin?, expiry_date?, notes, created_by) ledger，記錄每筆進貨的時間 + 來源 + 成本 + 保鮮期。Pool weight 仍是 cached aggregate。Order 扣減可選按 FIFO 從最舊批次扣（或先不分批次、純 pool）。

**Why**：V5.2 Approach C 在 /office-hours 被評為「成品重假設下用不到、過度工程」當下落選。但若未來：
- 想算 COGS（每月毛利 = 收入 - 進貨成本）
- 鮮果上架後需要 expiry 警告（5 天內必須出清這批）
- 想分析「金煌 vs 愛文」哪個進貨成本上升、調整訂價

…這些查詢需要批次粒度。屆時加一張 `product_intakes` 即可，pool weight 維持 cached。

**Pros**：
- 解鎖商業分析能力（毛利、損耗、批次效率）
- 鮮果 product line 的天然搭檔（保鮮期管理）
- Reconcile script 也會更精確（intakes 合計 - decrements 合計 = pool）

**Cons**：
- Schema migration（雖然不大）
- 進貨流程多一步（成本欄位）— operator workflow 摩擦
- FIFO 邏輯若上線，cancel 流程要「還回原批次」會複雜

**Context**：本 PR 系列 (V5.2 PR1/PR2/PR3) 完全不做。觸發條件：
- 想開始追毛利報表
- 鮮果 (#1) 上架且需要 expiry 管理
- Operator 自發說「我想知道這批進來多少錢」

可以分階段：先加表 + 進貨寫一筆（不影響扣減邏輯），等觀察到查詢需求再上 FIFO / cost 分析。

**Depends on / blocked by**：
- V5.2 三 PR 全部 ship（避免疊加風險）
- 商業需求出現（COGS / expiry / FIFO 任一）
