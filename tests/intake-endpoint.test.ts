// V5.2 PR2 /api/admin/product-groups/:id/intake integration tests.
//
// Verifies the gate-first non-batch pattern: CAS UPDATE with expected_pool_fen,
// negative-pool guard, audit row append, idempotency replay, validation/auth.
//
// Skipped without MANGO_STAGE_URL + TEST_TOKEN.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  getGroupStockFen,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-intake-season";
const TEST_GROUP_SLUG = "test-intake-group";
const TEST_SKU = "TEST-INTAKE-A";
const PACKAGE_FEN = 100;

let testGroupId = 0;
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

function seedScenario(initialFen: number) {
  const r = seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: initialFen,
    skus: [{ sku: TEST_SKU, package_fen: PACKAGE_FEN }],
  });
  testGroupId = r.group_id;
  seasonId = r.season_id;
}

interface IntakePayload {
  delta_fen?: number | string | null;
  expected_pool_fen?: number;
  reason?: string | null;
  idempotency_key?: string;
}

async function adminIntake(
  cookie: string,
  groupId: number,
  payload: IntakePayload,
  opts: { origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== null) {
    headers.Origin = opts.origin ?? STAGE_URL;
  }
  return fetch(`${STAGE_URL}/api/admin/product-groups/${groupId}/intake`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

describe("V5.2 PR2 /product-groups/:id/intake", () => {
  it("happy path: positive delta increments pool and writes audit row", async () => {
    if (SKIP) return;
    seedScenario(0);
    const cookie = createTestAdminSession();

    const idempotencyKey = `test-${crypto.randomUUID()}`;
    const res = await adminIntake(cookie, testGroupId, {
      delta_fen: 500,
      reason: "test intake +5 斤",
      idempotency_key: idempotencyKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      new_pool_fen: number;
      replayed?: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.new_pool_fen).toBe(500);
    expect(body.replayed).toBeUndefined();
    expect(getGroupStockFen(testGroupId)).toBe(500);

    const auditRows = d1Execute(
      `SELECT details FROM audit_log
        WHERE action = 'group_stock_change' AND season_id = ${seasonId}
        ORDER BY ts DESC LIMIT 1`,
    ) as Array<{ details: string }>;
    expect(auditRows.length).toBe(1);
    const parsed = JSON.parse(auditRows[0]!.details) as {
      reason: string;
      group_id: number;
      delta_fen: number;
      before_fen: number;
      after_fen: number;
      intake_reason: string;
      idempotency_key: string;
    };
    expect(parsed.reason).toBe("group_intake");
    expect(parsed.delta_fen).toBe(500);
    expect(parsed.before_fen).toBe(0);
    expect(parsed.after_fen).toBe(500);
    expect(parsed.intake_reason).toBe("test intake +5 斤");
    expect(parsed.idempotency_key).toBe(idempotencyKey);
  });

  it("negative delta decrements pool", async () => {
    if (SKIP) return;
    seedScenario(500);
    const cookie = createTestAdminSession();

    const res = await adminIntake(cookie, testGroupId, {
      delta_fen: -300,
      reason: "破損報廢 -3 斤",
    });
    expect(res.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(200);
  });

  it("INVALID_DELTA: refuses to drive pool negative", async () => {
    if (SKIP) return;
    seedScenario(100);
    const cookie = createTestAdminSession();

    const res = await adminIntake(cookie, testGroupId, {
      delta_fen: -200,
      reason: "should fail",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_code: string; current_pool_fen: number };
    expect(body.error_code).toBe("INVALID_DELTA");
    expect(body.current_pool_fen).toBe(100);
    expect(getGroupStockFen(testGroupId)).toBe(100);
  });

  it("STALE_STATE: refuses when expected_pool_fen doesn't match current", async () => {
    if (SKIP) return;
    seedScenario(500);
    const cookie = createTestAdminSession();

    const res = await adminIntake(cookie, testGroupId, {
      delta_fen: 100,
      expected_pool_fen: 400, // wrong — actual is 500
      reason: "stale test",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_code: string; current_pool_fen: number };
    expect(body.error_code).toBe("STALE_STATE");
    expect(body.current_pool_fen).toBe(500);
    expect(getGroupStockFen(testGroupId)).toBe(500);
  });

  it("idempotency replay: same key returns ok+replayed without double-applying", async () => {
    if (SKIP) return;
    seedScenario(0);
    const cookie = createTestAdminSession();

    const key = `test-${crypto.randomUUID()}`;
    const r1 = await adminIntake(cookie, testGroupId, {
      delta_fen: 250,
      reason: "first apply",
      idempotency_key: key,
    });
    expect(r1.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(250);

    const r2 = await adminIntake(cookie, testGroupId, {
      delta_fen: 250,
      reason: "replay attempt",
      idempotency_key: key,
    });
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as {
      ok: boolean;
      replayed?: boolean;
      new_pool_fen: number;
    };
    expect(body2.ok).toBe(true);
    expect(body2.replayed).toBe(true);
    expect(body2.new_pool_fen).toBe(250);
    expect(getGroupStockFen(testGroupId)).toBe(250); // NOT 500
  });

  it("validation: zero delta rejected", async () => {
    if (SKIP) return;
    seedScenario(100);
    const cookie = createTestAdminSession();
    const res = await adminIntake(cookie, testGroupId, {
      delta_fen: 0,
      reason: "test",
    });
    expect(res.status).toBe(400);
  });

  it("validation: missing reason rejected", async () => {
    if (SKIP) return;
    seedScenario(100);
    const cookie = createTestAdminSession();
    const res = await adminIntake(cookie, testGroupId, {
      delta_fen: 100,
    });
    expect(res.status).toBe(400);
  });

  it("validation: out-of-range delta rejected", async () => {
    if (SKIP) return;
    seedScenario(100);
    const cookie = createTestAdminSession();
    const res = await adminIntake(cookie, testGroupId, {
      delta_fen: 2_000_000, // 20000 斤 — above MAX_ABS_DELTA_FEN
      reason: "test",
    });
    expect(res.status).toBe(400);
  });

  it("validation: non-integer group id returns 400", async () => {
    if (SKIP) return;
    seedScenario(100);
    const cookie = createTestAdminSession();
    const res = await fetch(`${STAGE_URL}/api/admin/product-groups/abc/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL, Cookie: cookie },
      body: JSON.stringify({ delta_fen: 100, reason: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when group_id doesn't exist", async () => {
    if (SKIP) return;
    seedScenario(100);
    const cookie = createTestAdminSession();
    const res = await adminIntake(cookie, 99999999, {
      delta_fen: 100,
      reason: "test",
    });
    expect(res.status).toBe(404);
  });

  it("auth: no cookie returns 401", async () => {
    if (SKIP) return;
    seedScenario(100);
    const res = await fetch(`${STAGE_URL}/api/admin/product-groups/${testGroupId}/intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL },
      body: JSON.stringify({ delta_fen: 100, reason: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("csrf: foreign Origin returns 403", async () => {
    if (SKIP) return;
    seedScenario(100);
    const cookie = createTestAdminSession();
    const res = await adminIntake(
      cookie,
      testGroupId,
      { delta_fen: 100, reason: "test" },
      { origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(403);
  });
});
