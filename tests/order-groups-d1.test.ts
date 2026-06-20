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

  it("full lifecycle: create → join → close finalises host fee → ship marks all", async () => {
    // Flat-$150 season (the seeded season inherits the DB default shipping_config
    // {"type":"flat","fee_twd":150}), so the host fee at close is deterministic: $150.
    seedActiveSeasonScenario({
      season_code: "test-grp-life", group_slug: "test-grp-life-jh", initial_stock_fen: 100000,
      skus: [{ sku: `${TEST_SKU_PREFIX}GRP-LIFE`, package_fen: 100, price: 600 }],
    });
    const cookie = createTestAdminSession();

    // 1. Create the group with the host buying 2 斤 (200 fen). createGroup posts qty:2.
    const { code, group_id } = await createGroup(cookie, `${TEST_SKU_PREFIX}GRP-LIFE`);

    // The host order is created with paid=1; capture its order_id for later assertions.
    const hostRows = d1Execute(
      `SELECT order_id, shipping FROM orders WHERE order_group_id = ${group_id} AND group_role = 'host'`,
    ) as Array<{ order_id: string; shipping: number }>;
    expect(hostRows.length).toBe(1);
    const hostOrderId = hostRows[0]!.order_id;
    // Provisional host shipping is 0 until the group closes.
    expect(hostRows[0]!.shipping).toBe(0);

    // 2. A member joins buying 1 斤 (100 fen) via /api/orders with the group_code → shipping 0.
    clearOrderRateLimit();
    const memberName = `test-member-${crypto.randomUUID().slice(0, 8)}`;
    const joinRes = await stageFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: `test-member-${crypto.randomUUID()}`,
        token: TEST_TOKEN,
        honeypot: "",
        name: memberName,
        phone: "0922333444",
        address: "ignored",
        items: [{ sku: `${TEST_SKU_PREFIX}GRP-LIFE`, qty: 1 }],
        notes: "",
        pdpa_accepted: true,
        group_code: code,
      }),
    });
    const joinData = (await joinRes.json()) as { ok: boolean };
    expect(joinRes.status).toBe(200);
    expect(joinData.ok).toBe(true);
    const memberRows = d1Execute(
      `SELECT order_id, shipping FROM orders WHERE name = '${memberName}'`,
    ) as Array<{ order_id: string; shipping: number }>;
    expect(memberRows.length).toBe(1);
    expect(memberRows[0]!.shipping).toBe(0);
    const memberOrderId = memberRows[0]!.order_id;

    // 3. Close the group → host shipping finalised on the COMBINED weight.
    //    Combined = host 200 fen + member 100 fen = 300 fen; flat config → $150.
    const closeRes = await fetch(`${STAGE_URL}/api/admin/groups/${group_id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: STAGE_URL },
    });
    const closeData = (await closeRes.json()) as { ok: boolean; group_shipping?: number };
    expect(closeRes.status).toBe(200);
    expect(closeData.ok).toBe(true);
    expect(closeData.group_shipping).toBe(150);

    const closedGroup = d1Execute(
      `SELECT status FROM order_groups WHERE id = ${group_id}`,
    ) as Array<{ status: string }>;
    expect(closedGroup[0]!.status).toBe("closed");
    // Host order: shipping now $150, total = subtotal + 150.
    const hostAfterClose = d1Execute(
      `SELECT shipping, subtotal, total FROM orders WHERE order_id = '${hostOrderId}'`,
    ) as Array<{ shipping: number; subtotal: number; total: number }>;
    expect(hostAfterClose[0]!.shipping).toBe(150);
    expect(hostAfterClose[0]!.total).toBe(hostAfterClose[0]!.subtotal + 150);
    // Member order is still $0 shipping (the host bears the single group fee).
    const memberAfterClose = d1Execute(
      `SELECT shipping FROM orders WHERE order_id = '${memberOrderId}'`,
    ) as Array<{ shipping: number }>;
    expect(memberAfterClose[0]!.shipping).toBe(0);

    // 4. Mark every group order paid so the ship gate (paid=1) flips them all.
    //    Host is already paid=1 from create; mark the member paid too.
    d1Execute(`UPDATE orders SET paid = 1 WHERE order_group_id = ${group_id}`);

    // 5. Ship the whole group with one tracking number.
    const shipRes = await fetch(`${STAGE_URL}/api/admin/groups/${group_id}/ship`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: STAGE_URL },
      body: JSON.stringify({ tracking_no: "TEST123" }),
    });
    const shipData = (await shipRes.json()) as { ok: boolean; shipped?: number };
    expect(shipRes.status).toBe(200);
    expect(shipData.ok).toBe(true);
    expect(shipData.shipped).toBe(2);

    // Group is shipped, tracking recorded.
    const shippedGroup = d1Execute(
      `SELECT status, tracking_no FROM order_groups WHERE id = ${group_id}`,
    ) as Array<{ status: string; tracking_no: string }>;
    expect(shippedGroup[0]!.status).toBe("shipped");
    expect(shippedGroup[0]!.tracking_no).toBe("TEST123");

    // Every group order flipped to shipped=1 with the same tracking number.
    const allOrders = d1Execute(
      `SELECT shipped, tracking_no FROM orders WHERE order_group_id = ${group_id}`,
    ) as Array<{ shipped: number; tracking_no: string }>;
    expect(allOrders.length).toBe(2);
    for (const o of allOrders) {
      expect(o.shipped).toBe(1);
      expect(o.tracking_no).toBe("TEST123");
    }
  });
});
