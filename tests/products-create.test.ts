// V6 P1 /api/admin/products/create integration tests.
//
// Locks the contract that the (fixed) admin "新增商品" form must satisfy: a create
// payload carrying group_slug + package_fen succeeds; missing/invalid either field fails;
// unknown group → 404; duplicate SKU in active season → 409; auth + CSRF enforced.
//
// This pins the JSON shape the front-end submit handler is required to send (see plan P1
// Task 2/3). Skipped without MANGO_STAGE_URL + TEST_TOKEN.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-create-season";
const TEST_GROUP_SLUG = "test-create-group";
const SEED_SKU = "TEST-CREATE-SEED";
const NEW_SKU = "TEST-CREATE-NEW";
const PACKAGE_FEN = 100;

let seasonId = 0;

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

// One active season + one group (slug=TEST_GROUP_SLUG) + one pre-existing SKU.
function seedScenario() {
  const r = seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: 10 * PACKAGE_FEN,
    skus: [{ sku: SEED_SKU, package_fen: PACKAGE_FEN, price: 100 }],
  });
  seasonId = r.season_id;
}

interface CreatePayload {
  sku?: string;
  name?: string;
  variant?: string;
  price?: number;
  available?: boolean;
  display_order?: number;
  group_slug?: string;
  package_fen?: number;
}

async function adminCreate(
  cookie: string,
  payload: CreatePayload,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== null) {
    headers.Origin = opts.origin ?? STAGE_URL;
  }
  return fetch(`${STAGE_URL}/api/admin/products/create`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

describe("V6 P1 /api/admin/products/create", () => {
  it("happy path: payload with group_slug + package_fen creates the SKU in active season", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "test product create",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      group_slug: TEST_GROUP_SLUG,
      display_order: 0,
      available: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sku: string };
    expect(body.ok).toBe(true);
    expect(body.sku).toBe(NEW_SKU);

    // Row exists in the active season, with the package_fen we sent.
    const rows = d1Execute(
      `SELECT p.package_fen, p.season_id
         FROM products p
         JOIN seasons s ON s.id = p.season_id AND s.status = 'active'
        WHERE p.sku = '${NEW_SKU}'`,
    ) as Array<{ package_fen: number; season_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.package_fen).toBe(PACKAGE_FEN);
    expect(rows[0]!.season_id).toBe(seasonId);
  });

  it("missing group_slug → 400 bad group_slug (the original UI bug)", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "no group",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      // group_slug intentionally omitted
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("group_slug");
  });

  it("missing package_fen → 400 bad package_fen (the original UI bug)", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "no package",
      variant: "1 斤",
      price: 450,
      group_slug: TEST_GROUP_SLUG,
      // package_fen intentionally omitted
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("package_fen");
  });

  it("package_fen=50 (半斤) accepted", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "half jin",
      variant: "半斤",
      price: 250,
      package_fen: 50,
      group_slug: TEST_GROUP_SLUG,
    });
    expect(res.status).toBe(200);
    const rows = d1Execute(
      `SELECT package_fen FROM products WHERE sku = '${NEW_SKU}'`,
    ) as Array<{ package_fen: number }>;
    expect(rows[0]!.package_fen).toBe(50);
  });

  it("unknown group_slug → 404 GROUP_NOT_FOUND", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: NEW_SKU,
      name: "ghost group",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      group_slug: "test-create-nonexistent",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("GROUP_NOT_FOUND");
  });

  it("duplicate SKU in active season → 409", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await adminCreate(cookie, {
      sku: SEED_SKU, // already seeded
      name: "dup",
      variant: "1 斤",
      price: 450,
      package_fen: PACKAGE_FEN,
      group_slug: TEST_GROUP_SLUG,
    });
    expect(res.status).toBe(409);
  });

  it("auth: no cookie → 401", async () => {
    if (SKIP) return;
    seedScenario();
    const res = await fetch(`${STAGE_URL}/api/admin/products/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL },
      body: JSON.stringify({
        sku: NEW_SKU,
        name: "x",
        variant: "1 斤",
        price: 1,
        package_fen: PACKAGE_FEN,
        group_slug: TEST_GROUP_SLUG,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("csrf: foreign Origin → 403", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await adminCreate(
      cookie,
      {
        sku: NEW_SKU,
        name: "x",
        variant: "1 斤",
        price: 1,
        package_fen: PACKAGE_FEN,
        group_slug: TEST_GROUP_SLUG,
      },
      { origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
  });
});

// ---- Page render (SSR HTML) assertions ----
// The admin products page is server-rendered. With an authed admin cookie, GET /admin/products
// must include the create-form inputs for group_slug + package_fen, plus an <option> per
// active-season group. No browser needed: frontmatter-computed groups are baked into the HTML.

async function getProductsPage(cookie: string): Promise<Response> {
  return fetch(`${STAGE_URL}/admin/products`, {
    method: "GET",
    headers: { Cookie: cookie },
  });
}

describe("V6 P1 /admin/products page render", () => {
  it("create form exposes group_slug + package_fen controls and lists active-season groups", async () => {
    if (SKIP) return;
    seedScenario(); // active season + group(slug=TEST_GROUP_SLUG) + one SKU
    const cookie = createTestAdminSession();

    const res = await getProductsPage(cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The two previously-missing form controls now exist.
    expect(html).toContain('name="group_slug"');
    expect(html).toContain('name="package_fen"');

    // The seeded group is rendered as a selectable option (value = slug).
    expect(html).toContain(`value="${TEST_GROUP_SLUG}"`);

    // Package-size options expose the three fen values.
    expect(html).toContain('value="50"');
    expect(html).toContain('value="100"');
    expect(html).toContain('value="1000"');
  });

  it("products are grouped by product_group (group section markers present)", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await getProductsPage(cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    // Grouped display: a section per group carrying its slug.
    expect(html).toContain("data-group-section");
    expect(html).toContain(`data-group-slug="${TEST_GROUP_SLUG}"`);
  });
});
