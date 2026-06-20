import { afterAll, describe, expect, it } from "bun:test";
import {
  STAGE_URL, createTestAdminSession, cleanupTestData, cleanupTestAdmin,
  seedActiveSeasonScenario, skipIfNoIntegration, d1Execute, TEST_SKU_PREFIX,
} from "./_setup";

describe("order-groups create (stage)", () => {
  if (skipIfNoIntegration()) { it.skip("needs MANGO_STAGE_URL + TEST_TOKEN", () => {}); return; }
  afterAll(() => { cleanupTestData(); cleanupTestAdmin(); });

  it("admin creates a group + host order with a 5-digit code", async () => {
    const { } = seedActiveSeasonScenario({
      season_code: "test-grp", group_slug: "test-grp-jh", initial_stock_fen: 100000,
      skus: [{ sku: `${TEST_SKU_PREFIX}GRP-1`, package_fen: 100, price: 600 }],
    });
    const cookie = createTestAdminSession();
    const deadline = new Date(Date.now() + 5 * 86400_000).toISOString();
    const res = await fetch(`${STAGE_URL}/api/admin/groups/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: STAGE_URL },
      body: JSON.stringify({
        idempotency_key: `test-grp-${crypto.randomUUID()}`,
        host_name: "test-host", host_phone: "0912345678", host_address: "台北市測試路1號",
        deadline, items: [{ sku: `${TEST_SKU_PREFIX}GRP-1`, qty: 2 }],
      }),
    });
    const data = (await res.json()) as { ok: boolean; code?: string; group_id?: number };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.code).toMatch(/^[1-9]\d{4}$/);
    const rows = d1Execute(`SELECT status, code FROM order_groups WHERE id = ${data.group_id}`) as Array<{ status: string }>;
    expect(rows[0]!.status).toBe("open");
  });
});
