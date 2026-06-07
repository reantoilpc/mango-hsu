// Pure unit test (no stage env). Tests the admin nav model + active detection.
import { describe, expect, it } from "bun:test";
import { ADMIN_NAV_ITEMS, navItemsForRole, activeNavKey } from "../src/lib/admin-nav";

describe("admin-nav model", () => {
  it("exposes the seven V6 nav items in declared order", () => {
    const keys = ADMIN_NAV_ITEMS.map((i) => i.key);
    expect(keys).toEqual([
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

  it("operator role hides admin-only items (products, groups, seasons, settings)", () => {
    const operatorKeys = navItemsForRole("operator").map((i) => i.key);
    expect(operatorKeys).toEqual(["orders", "audit", "account"]);
  });

  it("admin role sees every item", () => {
    const adminKeys = navItemsForRole("admin").map((i) => i.key);
    expect(adminKeys).toEqual([
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

  it("returns null when no item matches (e.g. dashboard root)", () => {
    expect(activeNavKey("/admin")).toBeNull();
    expect(activeNavKey("/admin/")).toBeNull();
  });
});
