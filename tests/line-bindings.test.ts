// Pure unit test (no env). Tests the LINE-binding roster shaper.
import { describe, expect, it } from "bun:test";
import { shapeLineBindings, type LineBindingRow } from "../src/lib/line-bindings";

// Helper to build a raw row with sensible defaults.
function row(over: Partial<LineBindingRow> & { order_id: string; line_user_id: string }): LineBindingRow {
  return {
    name: "test-某人",
    phone: "0912345678",
    bound_at: "2026-06-20T10:00:00Z",
    created_at: "2026-06-20T09:00:00Z",
    shipped_at: null,
    line_push_sent_at: null,
    cancelled_at: null,
    ...over,
  };
}

describe("shapeLineBindings", () => {
  it("empty input → all zeros, no people", () => {
    const s = shapeLineBindings([]);
    expect(s.people).toEqual([]);
    expect(s.totalPeople).toBe(0);
    expect(s.totalOrders).toBe(0);
    expect(s.pushedOrders).toBe(0);
    expect(s.hasBindings).toBe(false);
  });

  it("single person, single order → one person, correct name/phone/boundAt", () => {
    const s = shapeLineBindings([
      row({ order_id: "M-20260620-001", line_user_id: "U_a", name: "test-王", phone: "0911", bound_at: "2026-06-20T10:00:00Z" }),
    ]);
    expect(s.totalPeople).toBe(1);
    expect(s.totalOrders).toBe(1);
    const p = s.people[0];
    expect(p.lineUserId).toBe("U_a");
    expect(p.name).toBe("test-王");
    expect(p.phone).toBe("0911");
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0].boundAt).toBe("2026-06-20T10:00:00Z");
    expect(p.firstBoundAt).toBe("2026-06-20T10:00:00Z");
  });

  it("bound_at NULL falls back to created_at (robust LEFT JOIN with no audit row)", () => {
    const s = shapeLineBindings([
      row({ order_id: "M-1", line_user_id: "U_x", bound_at: null, created_at: "2026-06-18T08:30:00Z" }),
    ]);
    expect(s.totalPeople).toBe(1);
    expect(s.people[0].orders[0].boundAt).toBe("2026-06-18T08:30:00Z");
  });

  it("distinct count = distinct line_user_id (same LINE, two orders = one person)", () => {
    const s = shapeLineBindings([
      row({ order_id: "M-old", line_user_id: "U_same", name: "test-舊名", bound_at: "2026-06-10T00:00:00Z" }),
      row({ order_id: "M-new", line_user_id: "U_same", name: "test-新名", bound_at: "2026-06-22T00:00:00Z" }),
    ]);
    expect(s.totalPeople).toBe(1);
    expect(s.totalOrders).toBe(2);
    const p = s.people[0];
    expect(p.orders).toHaveLength(2);
    // name/phone from the most-recently-bound order
    expect(p.name).toBe("test-新名");
    // orders sorted boundAt desc
    expect(p.orders[0].orderId).toBe("M-new");
    expect(p.orders[1].orderId).toBe("M-old");
    expect(p.firstBoundAt).toBe("2026-06-10T00:00:00Z");
    expect(p.latestBoundAt).toBe("2026-06-22T00:00:00Z");
  });

  it("cancelled order: person still counted, order flagged, excluded from order stats", () => {
    const s = shapeLineBindings([
      row({ order_id: "M-cxl", line_user_id: "U_c", cancelled_at: "2026-06-21T00:00:00Z", line_push_sent_at: "2026-06-21T01:00:00Z" }),
    ]);
    expect(s.totalPeople).toBe(1); // the LINE binding is still live/pushable
    expect(s.totalOrders).toBe(0); // cancelled excluded
    expect(s.pushedOrders).toBe(0); // cancelled excluded even though push had been sent
    expect(s.people[0].orders[0].cancelled).toBe(true);
  });

  it("counts pushed (non-cancelled) orders and shipped flag", () => {
    const s = shapeLineBindings([
      row({ order_id: "M-1", line_user_id: "U_1", line_push_sent_at: "2026-06-20T12:00:00Z", shipped_at: "2026-06-20T12:00:00Z" }),
      row({ order_id: "M-2", line_user_id: "U_2", line_push_sent_at: null, shipped_at: null }),
    ]);
    expect(s.totalPeople).toBe(2);
    expect(s.totalOrders).toBe(2);
    expect(s.pushedOrders).toBe(1);
    const pushed = s.people.find((p) => p.lineUserId === "U_1")!;
    expect(pushed.orders[0].pushSent).toBe(true);
    expect(pushed.orders[0].shipped).toBe(true);
  });

  it("dedupes duplicate rows for the same order_id (defensive), keeping one order", () => {
    const s = shapeLineBindings([
      row({ order_id: "M-dup", line_user_id: "U_d", bound_at: "2026-06-20T10:00:00Z" }),
      row({ order_id: "M-dup", line_user_id: "U_d", bound_at: "2026-06-20T11:00:00Z" }),
    ]);
    expect(s.totalPeople).toBe(1);
    expect(s.totalOrders).toBe(1);
    expect(s.people[0].orders).toHaveLength(1);
    // keeps the later boundAt
    expect(s.people[0].orders[0].boundAt).toBe("2026-06-20T11:00:00Z");
  });

  it("roster sorted by most-recent binding first", () => {
    const s = shapeLineBindings([
      row({ order_id: "M-a", line_user_id: "U_early", bound_at: "2026-06-01T00:00:00Z" }),
      row({ order_id: "M-b", line_user_id: "U_late", bound_at: "2026-06-25T00:00:00Z" }),
      row({ order_id: "M-c", line_user_id: "U_mid", bound_at: "2026-06-15T00:00:00Z" }),
    ]);
    expect(s.people.map((p) => p.lineUserId)).toEqual(["U_late", "U_mid", "U_early"]);
  });
});
