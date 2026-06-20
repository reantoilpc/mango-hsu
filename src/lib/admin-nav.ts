// V6 §5.7 — admin nav model.
// Pure (no Astro / env / DB) so it can be unit-tested and shared by both the
// desktop header and the mobile drawer in Layout.astro.
//
// Active detection uses LONGEST matching href prefix so /admin/products is never
// swallowed by a shorter shared substring. The "home" item (href /admin) is the
// fallback: it's a prefix of every admin path, so the longest-match rule lets
// specific pages (orders, audit, …) win, while /admin itself (and any unlisted
// /admin/* page) maps to "home". 首頁 is in the nav so the dashboard — which hosts
// the 銷售概況 sales summary — is reachable from the menu, not just at login.

export type AdminRole = "admin" | "operator";

export interface AdminNavItem {
  key: string;
  label: string;
  href: string;
  /** Visible to operators too. When false, only admins see it. */
  operatorVisible: boolean;
}

// Declared order is the on-screen order (spec §5.7: 訂單 / 年度設定 / 品種庫存 / 商品 / 紀錄 / 設定 / 帳號).
// "seasons" links to /admin/seasons (built by P5; link is harmless before that page exists).
// "settings" links to /admin/seasons too for now (shipping config lives on the season page per
// spec §5.5); P5/P3 own that page. Keeping a distinct key lets us re-point it later without
// touching callers.
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { key: "home", label: "首頁", href: "/admin", operatorVisible: true },
  { key: "orders", label: "訂單", href: "/admin/orders", operatorVisible: true },
  { key: "order-groups", label: "併單", href: "/admin/groups", operatorVisible: false },
  { key: "seasons", label: "年度設定", href: "/admin/seasons", operatorVisible: false },
  { key: "groups", label: "品種庫存", href: "/admin/product-groups", operatorVisible: false },
  { key: "products", label: "商品", href: "/admin/products", operatorVisible: false },
  { key: "audit", label: "紀錄", href: "/admin/audit", operatorVisible: true },
  { key: "settings", label: "設定", href: "/admin/seasons", operatorVisible: false },
  { key: "account", label: "帳號", href: "/admin/change-password", operatorVisible: true },
] as const;

export function navItemsForRole(role: AdminRole): AdminNavItem[] {
  if (role === "admin") return [...ADMIN_NAV_ITEMS];
  return ADMIN_NAV_ITEMS.filter((i) => i.operatorVisible);
}

// Returns the key of the nav item whose href is the longest prefix of `pathname`,
// or null if none matches. A match requires the path to equal the href or continue
// with a "/" so /admin/products doesn't match an href of /admin/product.
export function activeNavKey(pathname: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const item of ADMIN_NAV_ITEMS) {
    const h = item.href;
    const isMatch = pathname === h || pathname.startsWith(h + "/");
    if (!isMatch) continue;
    if (!best || h.length > best.len) {
      best = { key: item.key, len: h.length };
    }
  }
  return best ? best.key : null;
}
