// tests/group-crud.test.ts
// V6 P6: product_groups CRUD (create + update) integration tests against stage worker.
//
// Covers spec §5.2:
//   - POST /api/admin/product-groups/create: slug [a-z0-9-]+, (season_id,slug) unique,
//     name required, display_order/available optional, audit group_create, new stock_fen=0.
//   - PATCH /api/admin/product-groups/[id]: edit name/available/display_order,
//     REJECT any body containing stock_fen (stock only via intake), audit group_update.
//   - auth (authorizeAdmin) + CSRF (requireSameOrigin).
//
// Skipped without MANGO_STAGE_URL + TEST_TOKEN (see tests/_setup.ts).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedActiveSeasonScenario,
  seedGroup,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SEASON_CODE = "test-group-crud-season";
const GROUP_SLUG = "test-gcrud-existing"; // pre-seeded group for update/dup tests
const NEW_SLUG = "test-gcrud-new"; // created via API in create tests

let seasonId = 0;
let existingGroupId = 0;

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

// One active season + one pre-existing group, no SKUs needed for CRUD shape.
function seedScenario() {
  const r = seedActiveSeasonScenario({
    season_code: SEASON_CODE,
    group_slug: GROUP_SLUG,
    initial_stock_fen: 0,
    skus: [],
  });
  seasonId = r.season_id;
  existingGroupId = r.group_id;
}

interface CreateBody {
  slug?: string | null;
  name?: string | null;
  display_order?: number;
  available?: boolean;
  stock_fen?: number; // only used to assert it's rejected
}

async function createGroup(
  cookie: string,
  body: CreateBody,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== null) headers.Origin = opts.origin ?? STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/product-groups/create`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface UpdateBody {
  name?: string;
  available?: boolean;
  display_order?: number;
  stock_fen?: number; // only used to assert it's rejected
  expected?: { name: string; available: boolean; display_order: number };
}

async function updateGroup(
  cookie: string,
  groupId: number | string,
  body: UpdateBody,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== null) headers.Origin = opts.origin ?? STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/product-groups/${groupId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

describe("V6 P6 product-groups create", () => {
  it("happy path: creates group in active season with stock_fen=0 + audit group_create", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, {
      slug: NEW_SLUG,
      name: "test-新群種",
      display_order: 5,
      available: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; group_id: number; slug: string };
    expect(body.ok).toBe(true);
    expect(typeof body.group_id).toBe("number");
    expect(body.slug).toBe(NEW_SLUG);

    const rows = d1Execute(
      `SELECT slug, name, stock_fen, available, display_order, season_id
         FROM product_groups WHERE id = ${body.group_id}`,
    ) as Array<{
      slug: string;
      name: string;
      stock_fen: number;
      available: number;
      display_order: number;
      season_id: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.slug).toBe(NEW_SLUG);
    expect(rows[0]!.name).toBe("test-新群種");
    expect(rows[0]!.stock_fen).toBe(0); // never set on create
    expect(rows[0]!.available).toBe(1);
    expect(rows[0]!.display_order).toBe(5);
    expect(rows[0]!.season_id).toBe(seasonId);

    const audit = d1Execute(
      `SELECT action, details FROM audit_log
        WHERE action = 'group_create' AND season_id = ${seasonId}
        ORDER BY ts DESC LIMIT 1`,
    ) as Array<{ action: string; details: string }>;
    expect(audit.length).toBe(1);
    const d = JSON.parse(audit[0]!.details) as {
      group_id: number;
      slug: string;
      name: string;
    };
    expect(d.slug).toBe(NEW_SLUG);
    expect(d.name).toBe("test-新群種");
    expect(d.group_id).toBe(body.group_id);
  });

  it("defaults: available defaults true, display_order defaults 0", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, { slug: NEW_SLUG, name: "test-預設群" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { group_id: number };

    const rows = d1Execute(
      `SELECT available, display_order FROM product_groups WHERE id = ${body.group_id}`,
    ) as Array<{ available: number; display_order: number }>;
    expect(rows[0]!.available).toBe(1);
    expect(rows[0]!.display_order).toBe(0);
  });

  it("SLUG_TAKEN: duplicate slug in same season is rejected (409)", async () => {
    if (SKIP) return;
    seedScenario(); // GROUP_SLUG already exists in this season
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, { slug: GROUP_SLUG, name: "test-重複" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("SLUG_TAKEN");

    // No second row created.
    const rows = d1Execute(
      `SELECT COUNT(*) AS n FROM product_groups
        WHERE season_id = ${seasonId} AND slug = '${GROUP_SLUG}'`,
    ) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it("validation: bad slug (uppercase/space) rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const r1 = await createGroup(cookie, { slug: "TEST-BadSlug", name: "test-x" });
    expect(r1.status).toBe(400);

    const r2 = await createGroup(cookie, { slug: "test bad slug", name: "test-x" });
    expect(r2.status).toBe(400);
  });

  it("validation: missing name rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await createGroup(cookie, { slug: NEW_SLUG, name: "" });
    expect(res.status).toBe(400);
  });

  it("auth: no cookie returns 401", async () => {
    if (SKIP) return;
    seedScenario();
    const res = await fetch(`${STAGE_URL}/api/admin/product-groups/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL },
      body: JSON.stringify({ slug: NEW_SLUG, name: "test-x" }),
    });
    expect(res.status).toBe(401);
  });

  it("csrf: foreign Origin returns 403", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await createGroup(
      cookie,
      { slug: NEW_SLUG, name: "test-x" },
      { origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
  });
});

describe("V6 P6 product-groups update (PATCH)", () => {
  it("happy path: updates name + available + display_order + audit group_update", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await updateGroup(cookie, existingGroupId, {
      name: "test-改後名",
      available: false,
      display_order: 9,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = d1Execute(
      `SELECT name, available, display_order FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; available: number; display_order: number }>;
    expect(rows[0]!.name).toBe("test-改後名");
    expect(rows[0]!.available).toBe(0);
    expect(rows[0]!.display_order).toBe(9);

    const audit = d1Execute(
      `SELECT details FROM audit_log
        WHERE action = 'group_update' AND season_id = ${seasonId}
        ORDER BY ts DESC LIMIT 1`,
    ) as Array<{ details: string }>;
    expect(audit.length).toBe(1);
    const d = JSON.parse(audit[0]!.details) as { group_id: number; changed: string[] };
    expect(d.group_id).toBe(existingGroupId);
    expect(d.changed).toContain("name");
    expect(d.changed).toContain("available");
    expect(d.changed).toContain("display_order");
  });

  it("partial: updating only available leaves name/display_order untouched", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const before = d1Execute(
      `SELECT name, display_order FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; display_order: number }>;

    const res = await updateGroup(cookie, existingGroupId, { available: false });
    expect(res.status).toBe(200);

    const after = d1Execute(
      `SELECT name, available, display_order FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; available: number; display_order: number }>;
    expect(after[0]!.available).toBe(0);
    expect(after[0]!.name).toBe(before[0]!.name);
    expect(after[0]!.display_order).toBe(before[0]!.display_order);
  });

  it("STOCK_FORBIDDEN: body containing stock_fen is rejected 400 and pool unchanged", async () => {
    if (SKIP) return;
    seedScenario();
    // give the group some stock so we can prove it didn't move
    d1Execute(`UPDATE product_groups SET stock_fen = 777 WHERE id = ${existingGroupId}`);
    const cookie = createTestAdminSession();

    const res = await updateGroup(cookie, existingGroupId, {
      name: "test-想偷改庫存",
      stock_fen: 0,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("STOCK_FORBIDDEN");

    // Neither stock nor name changed (whole request rejected before any write).
    const rows = d1Execute(
      `SELECT name, stock_fen FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string; stock_fen: number }>;
    expect(rows[0]!.stock_fen).toBe(777);
    expect(rows[0]!.name).not.toBe("test-想偷改庫存");
  });

  it("NO_FIELDS: empty patch (no editable field) rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(cookie, existingGroupId, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("NO_FIELDS");
  });

  it("STALE_STATE: optimistic lock mismatch rejected 409, no write", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();

    const res = await updateGroup(cookie, existingGroupId, {
      name: "test-樂觀鎖測",
      expected: { name: "WRONG-OLD-NAME", available: true, display_order: 0 },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("STALE_STATE");

    const rows = d1Execute(
      `SELECT name FROM product_groups WHERE id = ${existingGroupId}`,
    ) as Array<{ name: string }>;
    expect(rows[0]!.name).not.toBe("test-樂觀鎖測");
  });

  it("validation: bad name (too long) rejected 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const longName = "x".repeat(60); // > 50
    const res = await updateGroup(cookie, existingGroupId, { name: longName });
    expect(res.status).toBe(400);
  });

  it("404: non-existent group id", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(cookie, 99999999, { name: "test-nope" });
    expect(res.status).toBe(404);
  });

  it("validation: non-integer id returns 400", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(cookie, "abc", { name: "test-x" });
    expect(res.status).toBe(400);
  });

  it("auth: no cookie returns 401", async () => {
    if (SKIP) return;
    seedScenario();
    const res = await fetch(`${STAGE_URL}/api/admin/product-groups/${existingGroupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL },
      body: JSON.stringify({ name: "test-x" }),
    });
    expect(res.status).toBe(401);
  });

  it("csrf: foreign Origin returns 403", async () => {
    if (SKIP) return;
    seedScenario();
    const cookie = createTestAdminSession();
    const res = await updateGroup(
      cookie,
      existingGroupId,
      { name: "test-x" },
      { origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
  });
});
