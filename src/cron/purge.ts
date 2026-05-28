// PDPA: delete orders older than 6 months. FK cascade auto-cleans
// order_items + audit_log rows tied to those orders.
// Also cleans expired sessions and orphan audit_log rows (login attempts etc).
//
// IMPORTANT: ensure foreign_keys PRAGMA is on, otherwise cascade won't fire.
//
// Takes a D1Database directly (not AppEnv) so cron-worker.ts can call it
// against multiple databases (prod + stage) with one shared implementation.
export async function purgeOldOrders(db: D1Database): Promise<{
  ordersDeleted: number;
  sessionsDeleted: number;
  orphanAuditDeleted: number;
}> {
  await db.prepare("PRAGMA foreign_keys = ON").run();

  const cutoff = new Date(Date.now() - 180 * 86400_000).toISOString();
  const nowIso = new Date().toISOString();

  const ordersResult = await db
    .prepare("DELETE FROM orders WHERE created_at < ?")
    .bind(cutoff)
    .run();

  const sessionsResult = await db
    .prepare("DELETE FROM sessions WHERE expires_at < ?")
    .bind(nowIso)
    .run();

  const auditResult = await db
    .prepare("DELETE FROM audit_log WHERE order_id IS NULL AND ts < ?")
    .bind(cutoff)
    .run();

  return {
    ordersDeleted: ordersResult.meta?.changes ?? 0,
    sessionsDeleted: sessionsResult.meta?.changes ?? 0,
    orphanAuditDeleted: auditResult.meta?.changes ?? 0,
  };
}
