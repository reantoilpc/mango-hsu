import { afterAll, describe, expect, it } from "bun:test";
import {
  STAGE_URL, TEST_TOKEN, createTestAdminSession, cleanupTestData, cleanupTestAdmin,
  seedActiveSeasonScenario, skipIfNoIntegration, d1Execute, stageFetch,
  clearOrderRateLimit, TEST_SKU_PREFIX,
} from "./_setup";

const HOST_ADDRESS = "台北市測試路1號";

// Create an open group on stage and return its 5-digit code + group_id. Shared by the
// create + member-join tests.
async function createGroup(cookie: string, sku: string): Promise<{ code: string; group_id: number }> {
  const deadline = new Date(Date.now() + 5 * 86400_000).toISOString();
  const res = await fetch(`${STAGE_URL}/api/admin/groups/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: STAGE_URL },
    body: JSON.stringify({
      idempotency_key: `test-grp-${crypto.randomUUID()}`,
      host_name: "test-host", host_phone: "0912345678", host_address: HOST_ADDRESS,
      deadline, items: [{ sku, qty: 2 }],
    }),
  });
  const data = (await res.json()) as { ok: boolean; code?: string; group_id?: number };
  expect(res.status).toBe(200);
  expect(data.ok).toBe(true);
  return { code: data.code!, group_id: data.group_id! };
}

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
        host_name: "test-host", host_phone: "0912345678", host_address: HOST_ADDRESS,
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

  it("public lookup GET /api/groups/[code] returns host_name + deadline for an open group", async () => {
    seedActiveSeasonScenario({
      season_code: "test-grp-look", group_slug: "test-grp-look-jh", initial_stock_fen: 100000,
      skus: [{ sku: `${TEST_SKU_PREFIX}GRP-LOOK`, package_fen: 100, price: 600 }],
    });
    const cookie = createTestAdminSession();
    const { code } = await createGroup(cookie, `${TEST_SKU_PREFIX}GRP-LOOK`);

    const ok = await fetch(`${STAGE_URL}/api/groups/${code}`);
    const okData = (await ok.json()) as { ok: boolean; host_name?: string; deadline?: string };
    expect(ok.status).toBe(200);
    expect(okData.ok).toBe(true);
    expect(okData.host_name).toBe("test-host");
    expect(typeof okData.deadline).toBe("string");

    // No open group for this code → { ok: false }.
    const miss = await fetch(`${STAGE_URL}/api/groups/99999`);
    const missData = (await miss.json()) as { ok: boolean };
    expect(missData.ok).toBe(false);
  });

  it("a customer joins via code: shipping 0, address = host, group_role='member'", async () => {
    seedActiveSeasonScenario({
      season_code: "test-grp-join", group_slug: "test-grp-join-jh", initial_stock_fen: 100000,
      skus: [{ sku: `${TEST_SKU_PREFIX}GRP-JOIN`, package_fen: 100, price: 600 }],
    });
    const cookie = createTestAdminSession();
    const { code, group_id } = await createGroup(cookie, `${TEST_SKU_PREFIX}GRP-JOIN`);

    clearOrderRateLimit();
    const memberName = `test-member-${crypto.randomUUID().slice(0, 8)}`;
    const res = await stageFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `test-member-${crypto.randomUUID()}`,
        token: TEST_TOKEN,
        honeypot: "",
        name: memberName,
        phone: "0922333444",
        address: "customer-typed address (should be ignored)",
        items: [{ sku: `${TEST_SKU_PREFIX}GRP-JOIN`, qty: 1 }],
        notes: "",
        pdpa_accepted: true,
        group_code: code,
      }),
    });
    const data = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);

    const rows = d1Execute(
      `SELECT shipping, group_role, address, order_group_id FROM orders WHERE name = '${memberName}'`,
    ) as Array<{ shipping: number; group_role: string; address: string; order_group_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.shipping).toBe(0);
    expect(rows[0]!.group_role).toBe("member");
    expect(rows[0]!.address).toBe(HOST_ADDRESS);
    expect(rows[0]!.order_group_id).toBe(group_id);
  });

  it("an invalid / unknown group_code on /api/orders → GROUP_INVALID", async () => {
    seedActiveSeasonScenario({
      season_code: "test-grp-bad", group_slug: "test-grp-bad-jh", initial_stock_fen: 100000,
      skus: [{ sku: `${TEST_SKU_PREFIX}GRP-BAD`, package_fen: 100, price: 600 }],
    });

    clearOrderRateLimit();
    const res = await stageFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `test-member-${crypto.randomUUID()}`,
        token: TEST_TOKEN,
        honeypot: "",
        name: "test-member-bad",
        phone: "0922333444",
        address: "test address",
        items: [{ sku: `${TEST_SKU_PREFIX}GRP-BAD`, qty: 1 }],
        notes: "",
        pdpa_accepted: true,
        group_code: "99999", // no open group with this code
      }),
    });
    const data = (await res.json()) as { ok: boolean; error_code?: string };
    expect(data.ok).toBe(false);
    expect(data.error_code).toBe("GROUP_INVALID");
  });
});
