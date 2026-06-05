// tests/terminology-zhtw.test.ts
//
// 純單元測試（無 env）：鎖死後台兩頁的術語中文化。
// 把 .astro 檔當純文字讀入，抽出「面向使用者文案」，斷言不含英文/技術術語禁字。
//
// 為什麼能跑：不 import tests/_setup.ts、不連 stage、不碰 D1/KV，
// 只讀本機檔案字串做正則斷言，CI 與本機 `bun test` 皆可直接執行。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PRODUCTS = resolve(ROOT, "src/pages/admin/products/index.astro");
const GROUPS = resolve(ROOT, "src/pages/admin/product-groups/index.astro");

// 面向使用者文案禁字（字面、區分大小寫）：
//  - "SKU"  → 應為「商品編碼」
//  - "slug" → 應為「品種代碼」
//  - "fen"  → 移除明文，UI 只顯示「斤」
const FORBIDDEN = ["SKU", "slug", "fen"] as const;

// 這些是「合法的內部 token」——含禁字子字串但屬於程式碼/屬性/契約，
// 不是面向使用者文案。掃描時先把整段移除，剩下的才視為文案。
// 注意：用「最長優先」順序，先吃掉長的（package_fen）再吃短的（fen）。
const INTERNAL_TOKENS = [
  // HTML data-* 屬性（含含 fen 者）
  "data-current-fen-label",
  "data-current-fen",
  "data-current-jin",
  "data-package-fen",
  "data-group-card",
  "data-group-id",
  "data-group-slug",
  "data-group-name",
  "data-group-available",
  "data-group-display-order",
  "data-intake-form",
  "data-dirty-track",
  "data-dirty-key",
  "data-prod-field",
  "data-prod-row",
  "data-sku",
  "data-sticky-bar",
  "data-sticky-count",
  "data-sticky-save-label",
  "data-sticky-save",
  "data-sticky-discard",
  "data-new-group-details",
  "data-new-group-error",
  "data-edit-toggle",
  "data-edit-form",
  "data-edit-cancel",
  "data-edit-error",
  "data-toggle-available",
  // TS 介面欄位 / API 契約 / JS 變數（含 fen / sku 子字串）
  "expected_pool_fen",
  "current_pool_fen",
  "new_pool_fen",
  "before_fen",
  "after_fen",
  "package_fen",
  "delta_fen",
  "stock_fen",
  "expectedFen",
  "deltaFen",
  "fenToJin",
  "delta_jin",
  "group_slug",
  "product_groups.slug",
  "products.slug",
  "preselectGroup",
  "ngShowErr",
  // 屬性 key（單純 attribute 名，值另外保留）
  "p.sku",
  "s.sku",
  "products.sku",
  "products.package_fen",
  ".sku",
  ".slug",
  // HTML name= / pattern= 屬性名（後端依賴，非使用者文案）
  'name="slug"',
  'name="sku"',
  'name="group_slug"',
  'name="package_fen"',
  // TypeScript / frontmatter 程式碼中的 fen 參數名與型別
  "{ fen: number",
  "{ fen:",
  "(fen: number)",
  "fen: number",
  "fen /",
  "fen *",
  "* fen",
  "/ fen",
  "fen)",
] as const;

/**
 * 移除一行裡所有已知內部 token，回傳「疑似面向使用者文案」殘餘字串。
 * 這讓 `data-current-fen` 之類不誤判，但渲染文字尾巴的 `fen` 仍會留下被抓到。
 */
function stripInternal(line: string): string {
  let out = line;
  for (const tok of INTERNAL_TOKENS) {
    out = out.split(tok).join(" ");
  }
  return out;
}

/**
 * 收集「面向使用者文案」候選行：
 *  - 含 placeholder= / aria-label= 的行（取整行，後續 stripInternal 清內部）
 *  - 含 showToast( 的行（toast 訊息）
 *  - 其餘行（渲染文字節點、提示段落）也納入——靠 stripInternal 濾掉內部 token。
 * 排除：import 行、純 JS 單行註解（//）——程式碼邏輯與內部備注，非面向使用者文案。
 */
function userFacingLines(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("import "))
    .filter((l) => !l.trimStart().startsWith("//"))
    .map(stripInternal);
}

function assertNoForbidden(filePath: string, label: string): void {
  const src = readFileSync(filePath, "utf8");
  const lines = userFacingLines(src);
  for (let i = 0; i < lines.length; i++) {
    for (const bad of FORBIDDEN) {
      expect(
        lines[i].includes(bad),
        `${label}: 第 ${i + 1} 行的面向使用者文案仍含禁字 "${bad}"：${lines[i].trim()}`,
      ).toBe(false);
    }
  }
}

describe("後台術語中文化 — products/index.astro", () => {
  test("面向使用者文案不得含 SKU / slug / fen", () => {
    assertNoForbidden(PRODUCTS, "products/index.astro");
  });

  test("必含中文新詞「商品編碼」", () => {
    const src = readFileSync(PRODUCTS, "utf8");
    expect(src.includes("商品編碼")).toBe(true);
  });
});

describe("後台術語中文化 — product-groups/index.astro", () => {
  test("面向使用者文案不得含 SKU / slug / fen", () => {
    assertNoForbidden(GROUPS, "product-groups/index.astro");
  });

  test("必含中文新詞「商品編碼」與「品種代碼」", () => {
    const src = readFileSync(GROUPS, "utf8");
    expect(src.includes("商品編碼")).toBe(true);
    expect(src.includes("品種代碼")).toBe(true);
  });
});
