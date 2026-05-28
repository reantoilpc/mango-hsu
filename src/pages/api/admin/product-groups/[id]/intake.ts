import type { APIRoute } from "astro";
import { eq, desc } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { makeDb } from "../../../../../db/client";
import { product_groups, audit_log } from "../../../../../db/schema";
import { env } from "../../../../../lib/env";

// V5.2 PR2: admin intake / correction for product_groups.stock_fen.
//
// Race / atomicity (mirrors cancel.ts gate-first pattern):
//   1. Read current stock_fen (snapshot for optimistic lock + audit before_fen).
//   2. CAS UPDATE solo (.run()): WHERE id = ? AND stock_fen = ? AND stock_fen + ? >= 0.
//      - expected_pool_fen catches concurrent admin intake → STALE_STATE.
//      - stock_fen + delta >= 0 refuses negative pool → INVALID_DELTA.
//   3. changes=0 → disambiguate via re-read.
//   4. changes=1 → INSERT audit_log solo with reason='group_intake'.
//
// Why NOT batch UPDATE + INSERT:
//   D1 batches don't abort on 0-row UPDATE. If CAS misses but audit INSERT batched
//   with it, we'd record a phantom delta and corrupt reconcile-stock.ts. Same trap
//   as mark-paid.ts hit pre-V5.

const IDEMPOTENCY_WINDOW_MS = 60_000;
const IDEMPOTENCY_SCAN_LIMIT = 20;
const MAX_ABS_DELTA_FEN = 1_000_000; // 10,000 斤 — absurd upper bound, catches typos

interface IntakeBody {
  delta_fen?: number;
  expected_pool_fen?: number;
  reason?: string;
  idempotency_key?: string;
}

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const groupId = Number(params.id);
  if (!Number.isInteger(groupId) || groupId <= 0) return text("bad id", 400);

  let body: IntakeBody = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return text("bad json", 400);
  }

  if (!Number.isInteger(body.delta_fen) || body.delta_fen === 0) {
    return text("delta_fen must be a non-zero integer", 400);
  }
  if (Math.abs(body.delta_fen) > MAX_ABS_DELTA_FEN) {
    return text("delta_fen out of range (max ±10000 斤)", 400);
  }
  if (
    typeof body.reason !== "string" ||
    body.reason.trim().length === 0 ||
    body.reason.length > 200
  ) {
    return text("reason required (1-200 chars)", 400);
  }
  const reasonText = body.reason.trim();

  const idempotencyKey =
    typeof body.idempotency_key === "string" && body.idempotency_key.length > 0
      ? body.idempotency_key
      : request.headers.get("Idempotency-Key");

  const db = makeDb(env);

  // Idempotency replay. Scans group_stock_change rows globally (cheap at admin volume).
  // Replay requires same group + same delta — defence against key reuse on different inputs.
  if (idempotencyKey) {
    const recent = await db
      .select()
      .from(audit_log)
      .where(eq(audit_log.action, "group_stock_change"))
      .orderBy(desc(audit_log.ts))
      .limit(IDEMPOTENCY_SCAN_LIMIT);
    for (const row of recent) {
      if (!row.details) continue;
      try {
        const d = JSON.parse(row.details) as {
          idempotency_key?: string;
          group_id?: number;
          delta_fen?: number;
          after_fen?: number;
        };
        if (d.idempotency_key !== idempotencyKey) continue;
        const rowTs = Date.parse(row.ts);
        if (!Number.isFinite(rowTs) || Date.now() - rowTs >= IDEMPOTENCY_WINDOW_MS) continue;
        if (d.group_id !== groupId || d.delta_fen !== body.delta_fen) continue;
        return json({
          ok: true,
          replayed: true,
          group_id: groupId,
          new_pool_fen: d.after_fen ?? null,
        });
      } catch {
        /* malformed details JSON — keep scanning */
      }
    }
  }

  const groupRows = await db
    .select()
    .from(product_groups)
    .where(eq(product_groups.id, groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) return text("group not found", 404);

  const beforeFen = group.stock_fen;
  const expectedFen =
    typeof body.expected_pool_fen === "number" ? body.expected_pool_fen : beforeFen;

  const updateResult = await env.DB.prepare(
    `UPDATE product_groups
        SET stock_fen = stock_fen + ?
      WHERE id = ?
        AND stock_fen = ?
        AND stock_fen + ? >= 0`,
  )
    .bind(body.delta_fen, groupId, expectedFen, body.delta_fen)
    .run();

  if ((updateResult.meta?.changes ?? 0) === 0) {
    const cur = await env.DB.prepare(
      `SELECT stock_fen FROM product_groups WHERE id = ?`,
    )
      .bind(groupId)
      .first<{ stock_fen: number }>();
    const currentPoolFen = cur?.stock_fen ?? 0;
    if (currentPoolFen + body.delta_fen < 0) {
      return json(
        {
          ok: false,
          error_code: "INVALID_DELTA",
          message: "delta would make pool negative",
          current_pool_fen: currentPoolFen,
        },
        409,
      );
    }
    return json(
      {
        ok: false,
        error_code: "STALE_STATE",
        message: "pool changed since you loaded — refresh and retry",
        current_pool_fen: currentPoolFen,
      },
      409,
    );
  }

  const afterFen = beforeFen + body.delta_fen;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now,
      auth.session.email,
      "group_stock_change",
      null,
      group.season_id,
      JSON.stringify({
        reason: "group_intake",
        group_id: groupId,
        delta_fen: body.delta_fen,
        before_fen: beforeFen,
        after_fen: afterFen,
        intake_reason: reasonText,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      }),
    )
    .run();

  return json({
    ok: true,
    group_id: groupId,
    delta_fen: body.delta_fen,
    new_pool_fen: afterFen,
  });
};
