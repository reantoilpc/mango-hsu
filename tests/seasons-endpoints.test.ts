// tests/seasons-endpoints.test.ts
//
// V6 §5.1 季節管理 API 整合測試（stage worker over HTTP）。
//
// 覆蓋：
//   POST /api/admin/seasons            — 建立（draft），audit season_create
//   PATCH /api/admin/seasons/:id/activate — 原子切換（舊 active 降 archived、新季升 active）
//   PATCH /api/admin/seasons/:id/archive  — 封存；有未出貨訂單時阻擋
//
// 全部需要 stage env（MANGO_STAGE_URL + TEST_TOKEN）；缺則整檔 skip。

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedActiveSeasonScenario,
  seedSeason,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();

const SEASON_NEW = "test-se-new"; // POST target code
const SEASON_OLD_ACTIVE = "test-se-oldactive";
const SEASON_TO_ACTIVATE = "test-se-toactivate";
const SEASON_ARCH = "test-se-arch";

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

// --- HTTP helpers ---------------------------------------------------------

async function postSeason(
  cookie: string,
  body: Record<string, unknown>,
  opts: { origin?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== false) headers.Origin = STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/seasons`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function patchSeason(
  cookie: string,
  id: number,
  action: "activate" | "archive",
  body: Record<string, unknown> = {},
  opts: { origin?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
  };
  if (opts.origin !== false) headers.Origin = STAGE_URL;
  return fetch(`${STAGE_URL}/api/admin/seasons/${id}/${action}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

function seasonRow(code: string): { id: number; status: string } | null {
  const rows = d1Execute(
    `SELECT id, status FROM seasons WHERE code = '${code}'`,
  ) as Array<{ id: number; status: string }>;
  return rows[0] ?? null;
}

// --- POST /api/admin/seasons ---------------------------------------------

describe("POST /api/admin/seasons", () => {
  it("creates a draft season + audit season_create", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();

    const res = await postSeason(cookie, {
      code: SEASON_NEW,
      name: "test 新年度",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(body.id).toBeGreaterThan(0);

    const row = seasonRow(SEASON_NEW);
    expect(row?.status).toBe("draft");

    const audit = d1Execute(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'season_create' AND season_id = ${body.id}`,
    ) as Array<{ n: number }>;
    expect(audit[0]!.n).toBe(1);
  });

  it("rejects duplicate code (409)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    seedSeason({ code: SEASON_NEW, status: "draft" });

    const res = await postSeason(cookie, { code: SEASON_NEW, name: "dup" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("CODE_EXISTS");
  });

  it("rejects bad code (400)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const res = await postSeason(cookie, { code: "白白白", name: "x" });
    expect(res.status).toBe(400);
  });

  it("CSRF: missing Origin rejected (403)", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const res = await postSeason(
      cookie,
      { code: SEASON_NEW, name: "x" },
      { origin: false },
    );
    expect(res.status).toBe(403);
  });

  it("no session rejected (401)", async () => {
    if (SKIP) return;
    const res = await postSeason("mh_session=bogus", {
      code: SEASON_NEW,
      name: "x",
    });
    expect(res.status).toBe(401);
  });
});
