// Integration: PATCH /api/admin/seasons/[id]/shipping-config (P4 §5.5).
// Requires stage env (see tests/_setup.ts). Seeds a test season, flips its shipping_config,
// asserts the DB row + audit_log shipping_config_change.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedSeason,
  skipIfNoIntegration,
  stageFetch,
  STAGE_URL,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SEASON_CODE = "test-shipcfg-season";

let cookie = "";
let seasonId = 0;

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
  cookie = createTestAdminSession("test-shipcfg@local");
  seasonId = seedSeason({ code: SEASON_CODE, status: "draft" });
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

function readConfig(id: number): string | null {
  const rows = d1Execute(
    `SELECT shipping_config FROM seasons WHERE id = ${id}`,
  ) as Array<{ shipping_config: string | null }>;
  return rows[0]?.shipping_config ?? null;
}

function patchConfig(id: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return stageFetch(`/api/admin/seasons/${id}/shipping-config`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      Origin: STAGE_URL,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH shipping-config", () => {
  it("sets a valid threshold_jin config and writes audit", async () => {
    if (SKIP) return;
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 },
    });
    expect(res.status).toBe(200);
    const stored = JSON.parse(readConfig(seasonId)!);
    expect(stored).toEqual({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });

    const audit = d1Execute(
      `SELECT action FROM audit_log WHERE season_id = ${seasonId} AND action = 'shipping_config_change'`,
    ) as Array<{ action: string }>;
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("sets a valid flat config", async () => {
    if (SKIP) return;
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "flat", fee_twd: 200 },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(readConfig(seasonId)!)).toEqual({ type: "flat", fee_twd: 200 });
  });

  it("rejects an invalid config shape (400) and does not mutate", async () => {
    if (SKIP) return;
    const before = readConfig(seasonId);
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "tiered", fee_twd: 150 },
    });
    expect(res.status).toBe(400);
    expect(readConfig(seasonId)).toBe(before);
  });

  it("rejects threshold_jin with non-positive free_over_fen (400)", async () => {
    if (SKIP) return;
    const res = await patchConfig(seasonId, {
      shipping_config: { type: "threshold_jin", free_over_fen: 0, fee_twd: 150 },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-existent season", async () => {
    if (SKIP) return;
    const res = await patchConfig(99999999, {
      shipping_config: { type: "flat", fee_twd: 150 },
    });
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated request (no cookie)", async () => {
    if (SKIP) return;
    const res = await stageFetch(`/api/admin/seasons/${seasonId}/shipping-config`, {
      method: "PATCH",
      headers: { Origin: STAGE_URL },
      body: JSON.stringify({ shipping_config: { type: "flat", fee_twd: 150 } }),
    });
    expect(res.status === 401 || res.status === 403).toBe(true);
  });

  it("rejects cross-origin (CSRF) request", async () => {
    if (SKIP) return;
    const res = await patchConfig(
      seasonId,
      { shipping_config: { type: "flat", fee_twd: 150 } },
      { Origin: "https://evil.example.com" },
    );
    expect(res.status === 403).toBe(true);
  });
});
