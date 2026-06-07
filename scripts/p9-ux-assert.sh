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
