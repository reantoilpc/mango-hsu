// V6 §5.7 — stage HTML existence assertions for admin UX shell.
// Fetches rendered admin pages over HTTP (real SSR) and asserts P8 elements exist.
// Requires MANGO_STAGE_URL + TEST_TOKEN + a stage admin session (wrangler login).
//
// We hit the stage worker directly (NOT stageFetch — that forces Content-Type: json,
// and we want plain GET for HTML). Auth uses the same test session cookie helper as
// the endpoint tests.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  createTestAdminSession,
  cleanupTestAdmin,
  d1Execute,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const OPERATOR_EMAIL = "test-operator@local";

let adminCookie = "";
let operatorCookie = "";

async function getHtml(path: string, cookie: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${STAGE_URL}${path}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  const html = await res.text();
  return { status: res.status, html };
}

beforeAll(() => {
  if (SKIP) return;
  cleanupTestAdmin();
  adminCookie = createTestAdminSession(); // admin role by default
  // Build an operator session: createTestAdminSession upserts an admin; downgrade a
  // second user to operator manually.
  const token = `test-${crypto.randomUUID()}`;
  const expires = new Date(Date.now() + 3600_000).toISOString();
  d1Execute(
    `INSERT OR REPLACE INTO admin_users (email, password_hash, role, must_change_password, created_at)
     VALUES ('${OPERATOR_EMAIL}', 'test-hash-not-real', 'operator', 0, '${new Date().toISOString()}')`,
  );
  d1Execute(
    `INSERT INTO sessions (token, user_email, expires_at) VALUES ('${token}', '${OPERATOR_EMAIL}', '${expires}')`,
  );
  operatorCookie = `mh_session=${token}`;
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestAdmin();
});

describe("admin UX HTML shell (P8)", () => {
  it("header nav renders the V6 entries for an admin", async () => {
    if (SKIP) return;
    const { status, html } = await getHtml("/admin/orders", adminCookie);
    expect(status).toBe(200);
    // The seven labels from admin-nav model (settings + seasons share an href but
    // both labels render). Assert the distinctive new ones exist.
    expect(html).toContain("年度設定");
    expect(html).toContain("品種庫存");
    expect(html).toContain('href="/admin/seasons"');
    // active marker on the current (orders) page
    expect(html).toContain('aria-current="page"');
  });

  it("mobile drawer toggle is present in the admin shell", async () => {
    if (SKIP) return;
    const { html } = await getHtml("/admin/orders", adminCookie);
    expect(html).toContain("data-admin-drawer-toggle");
    expect(html).toContain('id="admin-drawer"');
  });

  it("home dashboard shows the current-season region and stock summary container", async () => {
    if (SKIP) return;
    const { status, html } = await getHtml("/admin", adminCookie);
    expect(status).toBe(200);
    expect(html).toContain("各品種剩餘庫存");
    // either the active-season banner ("當季：") or the no-season prompt renders;
    // both contain "當季" / "年度". Assert at least the section heading exists above.
  });

  it("breadcrumb renders on the orders list", async () => {
    if (SKIP) return;
    const { html } = await getHtml("/admin/orders", adminCookie);
    expect(html).toContain("data-admin-breadcrumb");
    expect(html).toContain('aria-label="麵包屑"');
  });

  it("operator gets a friendly 403 (not blank) on /admin/products", async () => {
    if (SKIP) return;
    const { status, html } = await getHtml("/admin/products", operatorCookie);
    expect(status).toBe(403);
    expect(html).toContain("沒有權限");
    expect(html).toContain('href="/admin"'); // a way back
    // must NOT be the old blank string
    expect(html.trim()).not.toBe("admin only");
  });

  it("operator does NOT see admin-only nav items", async () => {
    if (SKIP) return;
    const { html } = await getHtml("/admin/orders", operatorCookie);
    // operator nav = orders / audit / account only; no 品種庫存 / 商品 / 年度設定 links
    expect(html).not.toContain('href="/admin/product-groups"');
    expect(html).not.toContain('href="/admin/seasons"');
  });
});
