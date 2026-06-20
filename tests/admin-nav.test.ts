// Pure unit test (no stage env). Tests the admin nav model + active detection.
import { describe, expect, it } from "bun:test";
import { ADMIN_NAV_ITEMS, navItemsForRole, activeNavKey } from "../src/lib/admin-nav";

describe("admin-nav model", () => {
  it("exposes the nav items in declared order, 首頁 first", () => {
    const keys = ADMIN_NAV_ITEMS.map((i) => i.key);
    expect(keys).toEqual([
      "home",
      "orders",
      "seasons",
      "groups",
      "products",
      "audit",
      "settings",
      "account",
    ]);
  });

  it("every item has a non-empty label and an /admin href", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.href.startsWith("/admin")).toBe(true);
    }
  });

  it("operator role hides admin-only items (products, groups, seasons, settings) but keeps 首頁", () => {
    const operatorKeys = navItemsForRole("operator").map((i) => i.key);
    expect(operatorKeys).toEqual(["home", "orders", "audit", "account"]);
  });

  it("admin role sees every item", () => {
    const adminKeys = navItemsForRole("admin").map((i) => i.key);
    expect(adminKeys).toEqual([
      "home",
      "orders",
      "seasons",
      "groups",
      "products",
      "audit",
      "settings",
      "account",
    ]);
  });

  it("activeNavKey matches the longest href prefix of the current path", () => {
    expect(activeNavKey("/admin/orders")).toBe("orders");
    expect(activeNavKey("/admin/orders/M-20260606-001")).toBe("orders");
    expect(activeNavKey("/admin/orders/new")).toBe("orders");
    expect(activeNavKey("/admin/product-groups")).toBe("groups");
    expect(activeNavKey("/admin/products")).toBe("products");
    expect(activeNavKey("/admin/seasons")).toBe("seasons");
    expect(activeNavKey("/admin/audit")).toBe("audit");
    expect(activeNavKey("/admin/change-password")).toBe("account");
  });

  it("does NOT mis-match /admin/products as /admin/product-groups (or vice versa)", () => {
    // 'groups' href is /admin/product-groups; 'products' href is /admin/products.
    // /admin/products must not be swallowed by the shorter shared 'product' string.
    expect(activeNavKey("/admin/products")).toBe("products");
    expect(activeNavKey("/admin/product-groups")).toBe("groups");
  });

  // Regression: the 銷售概況 (sales summary) lives ONLY on the dashboard root
  // (/admin) but the menu had no entry pointing there, so admins navigating via
  // the menu could never get back to it. The 首頁 item fixes that — /admin (and
  // any unlisted /admin/* page) now maps to "home", and home is reachable from
  // the menu for both roles.
  it("dashboard root maps to 首頁 (so 銷售概況 is reachable from the menu)", () => {
    expect(activeNavKey("/admin")).toBe("home");
    expect(activeNavKey("/admin/")).toBe("home");
    const home = ADMIN_NAV_ITEMS.find((i) => i.key === "home");
    expect(home?.href).toBe("/admin");
    expect(home?.operatorVisible).toBe(true);
  });

  it("specific pages still win over 首頁 via longest-prefix (home is fallback only)", () => {
    // home href "/admin" is a prefix of every admin path, but the longest match wins.
    expect(activeNavKey("/admin/orders")).toBe("orders");
    expect(activeNavKey("/admin/audit")).toBe("audit");
    expect(activeNavKey("/admin/change-password")).toBe("account");
  });
});
