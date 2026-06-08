// V5.2 test infra. See docs/design-v4.md "Testing" section + design-v5.2 design doc.
//
// Required env (read from process.env):
//   MANGO_STAGE_URL  — base URL of the stage worker (e.g. https://mango-hsu-stage.rhsu.workers.dev)
//   TEST_TOKEN       — stage's ORDER_TOKEN secret (NEVER prod's)
//
// Required local state:
//   wrangler login completed (or CLOUDFLARE_API_TOKEN env var set)
//
// Helpers spawn `wrangler d1 execute` rather than calling D1 over HTTP — the stage worker
// has no privileged seed/cleanup endpoint by design.
//
// V5.2 changes:
//   - seedSku → seedProductInSeason (auto-creates a test season + group if not present)
//   - new helpers: seedSeason, seedGroup, getGroupStockFen, setGroupStockFen
//   - cleanupTestData covers the new tables and resets test season/group rows

import { spawnSync } from "node:child_process";

export const STAGE_URL = process.env.MANGO_STAGE_URL ?? "";
export const TEST_TOKEN = process.env.TEST_TOKEN ?? "";

const D1_DATABASE = "mango-hsu-stage";

if (!STAGE_URL || !TEST_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n⚠️  V5.2 tests need MANGO_STAGE_URL + TEST_TOKEN env. " +
      "See docs/design-v4.md → Testing.\n" +
      "Skipping non-unit tests; pure unit tests still run.\n",
  );
}

export function d1Execute(sql: string): unknown[] {
  const r = spawnSync(
    "bunx",
    [
      "wrangler",
      "d1",
      "execute",
      D1_DATABASE,
      "--env",
      "stage",
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`wrangler d1 execute returned non-JSON:\n${r.stdout}`);
  }
  const arr = parsed as Array<{ success: boolean; results: unknown[]; error?: string }>;
  if (!arr[0]?.success) {
    throw new Error(`d1 query failed: ${arr[0]?.error ?? JSON.stringify(arr[0])}`);
  }
  return arr[0].results;
}

// Stage rate-limit (KV-backed, 3 req / 60s per IP) trips on test traffic faster than the
// 60s TTL clears. Wipe `rl:order:*` keys before order-posting tests so each scenario starts
// clean.
export function clearOrderRateLimit() {
  const list = spawnSync(
    "bunx",
    [
      "wrangler",
      "kv",
      "key",
      "list",
      "--binding=RATELIMIT",
      "--env=stage",
      "--remote",
      "--prefix=rl:order:",
    ],
    { encoding: "utf-8" },
  );
  if (list.status !== 0) return;
  let keys: Array<{ name: string }>;
  try {
    keys = JSON.parse(list.stdout);
  } catch {
    return;
  }
  for (const { name } of keys) {
    spawnSync(
      "bunx",
      [
        "wrangler",
        "kv",
        "key",
        "delete",
        name,
        "--binding=RATELIMIT",
        "--env=stage",
        "--remote",
      ],
      { encoding: "utf-8" },
    );
  }
}

// Test data prefixes scoped per-column. SKUs go uppercase (`TEST-`) because the admin
// product validators enforce `[A-Z0-9_-]+`; customer names stay lowercase (`test-`)
// since names have no regex constraint. Groups + seasons use `test-` prefix slugs.
export const TEST_SKU_PREFIX = "TEST-";
export const TEST_NAME_PREFIX = "test-";
export const TEST_SEASON_PREFIX = "test-";
export const TEST_GROUP_PREFIX = "test-";

// V5.2: seed a season row. Returns the season id.
export function seedSeason(opts: {
  code: string;
  name?: string;
  status?: "draft" | "active" | "archived";
}): number {
  if (!opts.code.startsWith(TEST_SEASON_PREFIX)) {
    throw new Error(
      `seedSeason: code must start with "${TEST_SEASON_PREFIX}" (got "${opts.code}")`,
    );
  }
  const status = opts.status ?? "draft";
  const name = opts.name ?? `Test Season ${opts.code}`;
  const now = new Date().toISOString();
  d1Execute(
    `INSERT OR IGNORE INTO seasons (code, name, status, created_at) VALUES ('${opts.code}', '${name}', '${status}', '${now}')`,
  );
  const rows = d1Execute(
    `SELECT id FROM seasons WHERE code = '${opts.code}'`,
  ) as Array<{ id: number }>;
  if (rows.length === 0) {
    // INSERT OR IGNORE silently no-op'd. Most common cause: status='active' violated the
    // partial unique index (some other active season exists). seasons.test.ts asserts this
    // behavior, so don't auto-recover here — throw and let the test catch it.
    throw new Error(
      `seedSeason: failed to find ${opts.code} (likely UNIQUE constraint on partial active-singleton index — use seedActiveSeasonScenario which archives existing active first)`,
    );
  }
  return rows[0]!.id;
}

// V5.2: seed a product_groups row. Returns the group id.
export function seedGroup(opts: {
  season_id: number;
  slug: string;
  name?: string;
  stock_fen?: number;
}): number {
  if (!opts.slug.startsWith(TEST_GROUP_PREFIX)) {
    throw new Error(
      `seedGroup: slug must start with "${TEST_GROUP_PREFIX}" (got "${opts.slug}")`,
    );
  }
  const name = opts.name ?? `Test Group ${opts.slug}`;
  const stock_fen = opts.stock_fen ?? 0;
  const now = new Date().toISOString();
  d1Execute(
    `INSERT OR IGNORE INTO product_groups (season_id, slug, name, stock_fen, created_at)
     VALUES (${opts.season_id}, '${opts.slug}', '${name}', ${stock_fen}, '${now}')`,
  );
  const rows = d1Execute(
    `SELECT id FROM product_groups WHERE season_id = ${opts.season_id} AND slug = '${opts.slug}'`,
  ) as Array<{ id: number }>;
  if (rows.length === 0) throw new Error(`seedGroup: failed to find ${opts.slug}`);
  return rows[0]!.id;
}

// V5.2: seed a product within a (season, group). Returns the product id.
export function seedProductInSeason(opts: {
  season_id: number;
  group_id: number;
  sku: string;
  package_fen: number;
  price?: number;
  available?: boolean;
  name?: string;
  variant?: string;
}): number {
  if (!opts.sku.startsWith(TEST_SKU_PREFIX)) {
    throw new Error(
      `seedProductInSeason: sku must start with "${TEST_SKU_PREFIX}" (got "${opts.sku}")`,
    );
  }
  const price = opts.price ?? 100;
  const available = opts.available === false ? 0 : 1;
  const name = opts.name ?? "test product";
  const variant = opts.variant ?? `${opts.package_fen / 100} 斤`;
  d1Execute(
    `INSERT OR REPLACE INTO products (season_id, group_id, sku, name, variant, package_fen, price, available, display_order, stock)
     VALUES (${opts.season_id}, ${opts.group_id}, '${opts.sku}', '${name}', '${variant}', ${opts.package_fen}, ${price}, ${available}, 99, 0)`,
  );
  const rows = d1Execute(
    `SELECT id FROM products WHERE season_id = ${opts.season_id} AND sku = '${opts.sku}'`,
  ) as Array<{ id: number }>;
  if (rows.length === 0) {
    throw new Error(`seedProductInSeason: failed to find ${opts.sku}`);
  }
  return rows[0]!.id;
}

// Convenience for tests that just need ONE active season with ONE group + a few SKUs.
// Bundles the three steps and returns the ids. Caller can use TEST_SKU_PREFIX consts.
//
// V5.2: the seasons table has a partial unique index `WHERE status='active'` enforcing
// at-most-one-active-season. Stage already has a real `2026` season as active, so we must
// archive it before activating a test season. cleanupTestData() reactivates `2026` at the
// end of each test to restore the pre-test state.
export function seedActiveSeasonScenario(opts: {
  season_code: string;
  group_slug: string;
  initial_stock_fen: number;
  skus: Array<{ sku: string; package_fen: number; price?: number }>;
}): { season_id: number; group_id: number; product_ids: Map<string, number> } {
  d1Execute(`UPDATE seasons SET status = 'archived' WHERE status = 'active'`);
  const season_id = seedSeason({
    code: opts.season_code,
    status: "active",
  });
  const group_id = seedGroup({
    season_id,
    slug: opts.group_slug,
    stock_fen: opts.initial_stock_fen,
  });
  const product_ids = new Map<string, number>();
  for (const s of opts.skus) {
    const id = seedProductInSeason({
      season_id,
      group_id,
      sku: s.sku,
      package_fen: s.package_fen,
      price: s.price,
    });
    product_ids.set(s.sku, id);
  }
  return { season_id, group_id, product_ids };
}

// V5.2: get/set group stock_fen for assertions.
export function getGroupStockFen(group_id: number): number {
  const rows = d1Execute(
    `SELECT stock_fen FROM product_groups WHERE id = ${group_id}`,
  ) as Array<{ stock_fen: number }>;
  if (rows.length === 0) {
    throw new Error(`getGroupStockFen(${group_id}): no rows`);
  }
  return rows[0]!.stock_fen;
}

export function setGroupStockFen(group_id: number, stock_fen: number): void {
  d1Execute(
    `UPDATE product_groups SET stock_fen = ${stock_fen} WHERE id = ${group_id}`,
  );
}

// Legacy helper kept for cross-season tests that need to query by sku.
// Returns 0 if not found in active season (for compatibility with V4 test assertions).
export function getSkuStockInActiveSeason(sku: string): number {
  const rows = d1Execute(
    `SELECT pg.stock_fen, p.package_fen
       FROM products p
       JOIN seasons s ON s.id = p.season_id AND s.status = 'active'
       JOIN product_groups pg ON pg.id = p.group_id
      WHERE p.sku = '${sku}'
      LIMIT 1`,
  ) as Array<{ stock_fen: number; package_fen: number }>;
  if (rows.length === 0) return 0;
  return Math.floor(rows[0]!.stock_fen / rows[0]!.package_fen);
}

export function cleanupTestData() {
  // FK cascade handles order_items + audit_log when an order goes.
  // Order matters:
  //   1. delete orders with test names/idempotency_keys (cascades to order_items + audit_log)
  //   2. delete products + groups in test seasons (cascades not set; manual delete)
  //   3. delete test seasons
  d1Execute(
    `DELETE FROM orders WHERE name LIKE '${TEST_NAME_PREFIX}%' OR idempotency_key LIKE '${TEST_NAME_PREFIX}%'`,
  );
  // Audit log: clean up test-induced rows (intake, group_stock_change for test groups).
  // Use season_id as the discriminator.
  d1Execute(
    `DELETE FROM audit_log WHERE season_id IN (SELECT id FROM seasons WHERE code LIKE '${TEST_SEASON_PREFIX}%')`,
  );
  d1Execute(`DELETE FROM products WHERE sku LIKE '${TEST_SKU_PREFIX}%'`);
  d1Execute(
    `DELETE FROM product_groups WHERE slug LIKE '${TEST_GROUP_PREFIX}%' OR season_id IN (SELECT id FROM seasons WHERE code LIKE '${TEST_SEASON_PREFIX}%')`,
  );
  d1Execute(`DELETE FROM seasons WHERE code LIKE '${TEST_SEASON_PREFIX}%'`);
  // V5.2: seedActiveSeasonScenario archives the real 2026 active season; restore it here so
  // the next test (or real customer traffic) sees a valid active season. Idempotent — if 2026
  // is still active (test didn't touch it), this is a no-op.
  d1Execute(`UPDATE seasons SET status = 'active' WHERE code = '2026'`);
  clearOrderRateLimit();
}

// Simple wrapper for fetching the stage worker. Tests pass headers / body etc.
// `X-Test-Mode: 1` is added automatically; the stage worker honours it (with a valid
// ORDER_TOKEN) to bypass rate limits since all tests share one IP.
export async function stageFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${STAGE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Test-Mode": "1",
      ...(init.headers ?? {}),
    },
  });
}

// Test-only admin auth: spawns wrangler to insert a session row directly.
// Returns the session cookie string for use in admin endpoint tests.
// `expires_at` is set 1 hour in the future. Test cleanup removes the row.
export function createTestAdminSession(email = "test-admin@local"): string {
  const token = `test-${crypto.randomUUID()}`;
  const expires = new Date(Date.now() + 3600_000).toISOString();
  d1Execute(
    `INSERT OR REPLACE INTO admin_users (email, password_hash, role, must_change_password, created_at)
     VALUES ('${email}', 'test-hash-not-real', 'admin', 0, '${new Date().toISOString()}')`,
  );
  d1Execute(
    `INSERT INTO sessions (token, user_email, expires_at) VALUES ('${token}', '${email}', '${expires}')`,
  );
  return `mh_session=${token}`;
}

export function cleanupTestAdmin() {
  d1Execute(
    `DELETE FROM sessions WHERE token LIKE 'test-%' OR user_email LIKE '%@local'`,
  );
  d1Execute(`DELETE FROM admin_users WHERE email LIKE '%@local'`);
}

// Convenience: skip a test if integration env is missing.
export function skipIfNoIntegration(): boolean {
  return !STAGE_URL || !TEST_TOKEN;
}

// --- V6 §5.6 forgot-password test helpers ---

// Seed an admin_users row whose email is a test-prefixed address ('%@local' so cleanupTestAdmin
// removes it) with a REAL pbkdf2 hash for `password`. Used by reset tests that must verify
// login works with the NEW password after a successful reset. password_hash is computed locally
// via the same auth helper the app uses.
import { hashPassword, hmacResetCode } from "../src/lib/auth";

// Stage's RESET_OTP_SECRET, mirrored into the test env so tests can compute the SAME stored HMAC
// the server computes and inject it via setResetToken. Integration reset tests that inject a known
// code require this to equal stage's secret; without it, skip via skipIfNoResetSecret().
export const TEST_RESET_OTP_SECRET = process.env.TEST_RESET_OTP_SECRET ?? "";

export async function resetCodeHmac(email: string, code: string): Promise<string> {
  return hmacResetCode(TEST_RESET_OTP_SECRET, email, code);
}

export function skipIfNoResetSecret(): boolean {
  return skipIfNoIntegration() || !TEST_RESET_OTP_SECRET;
}

export async function seedAdminUser(opts: {
  email: string;
  password: string;
  role?: "admin" | "operator";
}): Promise<void> {
  if (!opts.email.endsWith("@local")) {
    throw new Error(`seedAdminUser: email must end with "@local" (got "${opts.email}")`);
  }
  const hash = await hashPassword(opts.password);
  const role = opts.role ?? "admin";
  const now = new Date().toISOString();
  d1Execute(
    `INSERT OR REPLACE INTO admin_users (email, password_hash, role, must_change_password, created_at)
     VALUES ('${opts.email}', '${hash}', '${role}', 0, '${now}')`,
  );
}

// Read the stored reset_token (HMAC), expiry, and attempt count for an admin.
export function getResetTokenRow(email: string): {
  reset_token: string | null;
  reset_token_expires_at: string | null;
  reset_attempts: number;
} {
  const rows = d1Execute(
    `SELECT reset_token, reset_token_expires_at, reset_attempts FROM admin_users WHERE email = '${email}'`,
  ) as Array<{ reset_token: string | null; reset_token_expires_at: string | null; reset_attempts: number }>;
  if (rows.length === 0) throw new Error(`getResetTokenRow: no admin ${email}`);
  return rows[0]!;
}

// Directly set an admin's reset_token (HMAC) + expiry + attempts — lets reset-submit tests install
// a known code's HMAC (and EXPIRED / partially-attempted states) without going through
// request-reset (which would push Telegram).
export function setResetToken(
  email: string,
  tokenHash: string | null,
  expiresAt: string | null,
  attempts = 0,
): void {
  const tk = tokenHash === null ? "NULL" : `'${tokenHash}'`;
  const ex = expiresAt === null ? "NULL" : `'${expiresAt}'`;
  d1Execute(
    `UPDATE admin_users SET reset_token = ${tk}, reset_token_expires_at = ${ex}, reset_attempts = ${attempts} WHERE email = '${email}'`,
  );
}

// Read an admin's current password_hash (to assert it CHANGED after a reset).
export function getAdminPasswordHash(email: string): string {
  const rows = d1Execute(
    `SELECT password_hash FROM admin_users WHERE email = '${email}'`,
  ) as Array<{ password_hash: string }>;
  if (rows.length === 0) throw new Error(`getAdminPasswordHash: no admin ${email}`);
  return rows[0]!.password_hash;
}

// Count live sessions for an admin (to assert reset wiped them).
export function countSessions(email: string): number {
  const rows = d1Execute(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_email = '${email}'`,
  ) as Array<{ n: number }>;
  return rows[0]!.n;
}

// Insert a session row for an admin (to assert reset deletes it). Token is test-prefixed.
export function seedSessionFor(email: string): string {
  const token = `test-sess-${crypto.randomUUID()}`;
  const expires = new Date(Date.now() + 3600_000).toISOString();
  d1Execute(
    `INSERT INTO sessions (token, user_email, expires_at) VALUES ('${token}', '${email}', '${expires}')`,
  );
  return token;
}

// Wipe rl:reset:* AND rl:reset_verify:* KV keys between reset tests. The request limit (3/hr/email)
// and the verify limit (10/15min/IP) both outlive test traffic and would otherwise carry across
// cases. Mirrors clearOrderRateLimit.
export function clearResetRateLimit() {
  for (const prefix of ["rl:reset:", "rl:reset_verify:"]) {
    const list = spawnSync(
      "bunx",
      [
        "wrangler",
        "kv",
        "key",
        "list",
        "--binding=RATELIMIT",
        "--env=stage",
        "--remote",
        `--prefix=${prefix}`,
      ],
      { encoding: "utf-8" },
    );
    if (list.status !== 0) continue;
    let keys: Array<{ name: string }>;
    try {
      keys = JSON.parse(list.stdout);
    } catch {
      continue;
    }
    for (const { name } of keys) {
      spawnSync(
        "bunx",
        ["wrangler", "kv", "key", "delete", name, "--binding=RATELIMIT", "--env=stage", "--remote"],
        { encoding: "utf-8" },
      );
    }
  }
}
