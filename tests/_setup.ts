// V4 test infra. See docs/design-v4.md "Testing" section.
//
// Required env (read from process.env):
//   MANGO_STAGE_URL  — base URL of the stage worker (e.g. https://mango-hsu-stage.workers.dev)
//   TEST_TOKEN       — stage's ORDER_TOKEN secret (NEVER prod's)
//
// Required local state:
//   wrangler login completed (or CLOUDFLARE_API_TOKEN env var set)
//
// Helpers spawn `wrangler d1 execute` rather than calling D1 over HTTP — the
// stage worker has no privileged seed/cleanup endpoint by design (Codex F6
// catch — opening a backdoor would be a security gift to anyone reading the
// public stage URL).

import { spawnSync } from "node:child_process";

export const STAGE_URL = process.env.MANGO_STAGE_URL ?? "";
export const TEST_TOKEN = process.env.TEST_TOKEN ?? "";

const D1_DATABASE = "mango-hsu-stage";

// Skip the entire suite if env not configured. `bun test` runs this preload
// before each test file; if env is missing we want to fail loud once instead
// of letting every test file fail with cryptic fetch errors.
if (!STAGE_URL || !TEST_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n⚠️  V4 tests need MANGO_STAGE_URL + TEST_TOKEN env. " +
      "See docs/design-v4.md → Testing.\n" +
      "Skipping non-unit tests; pure unit tests (stock-helper.test.ts) still run.\n",
  );
}

export function d1Execute(sql: string): string {
  const r = spawnSync(
    "wrangler",
    ["d1", "execute", D1_DATABASE, "--remote", "--command", sql],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`,
    );
  }
  return r.stdout;
}

// Test data uses a `test-` prefix on SKUs and customer names so cleanup
// can target only test rows without touching real production data
// (we never run these against prod, but defense in depth).
export const TEST_SKU_PREFIX = "test-";
export const TEST_NAME_PREFIX = "test-";

export function seedSku(sku: string, opts: { stock: number; price?: number; available?: boolean }) {
  if (!sku.startsWith(TEST_SKU_PREFIX)) {
    throw new Error(`seedSku: sku must start with "${TEST_SKU_PREFIX}" (got "${sku}")`);
  }
  const price = opts.price ?? 100;
  const available = opts.available === false ? 0 : 1;
  d1Execute(
    `INSERT OR REPLACE INTO products (sku, name, variant, price, available, stock, display_order)
     VALUES ('${sku}', 'test product', 'test', ${price}, ${available}, ${opts.stock}, 99)`,
  );
}

export function setSkuStock(sku: string, stock: number) {
  if (!sku.startsWith(TEST_SKU_PREFIX)) {
    throw new Error(`setSkuStock: sku must start with "${TEST_SKU_PREFIX}"`);
  }
  d1Execute(`UPDATE products SET stock = ${stock} WHERE sku = '${sku}'`);
}

export function getSkuStock(sku: string): number {
  const out = d1Execute(`SELECT stock FROM products WHERE sku = '${sku}'`);
  // wrangler d1 execute --remote returns formatted ASCII table; parse the stock column
  // by finding the first numeric value after a newline. Fragile but family-scale OK.
  const match = out.match(/(\d+)/g);
  if (!match || match.length === 0) {
    throw new Error(`getSkuStock("${sku}"): no number in output:\n${out}`);
  }
  return Number(match[match.length - 1]);
}

export function cleanupTestData() {
  // FK cascade handles order_items + audit_log when an order goes.
  // Order matters: delete orders first (cascades), then products.
  d1Execute(
    `DELETE FROM orders WHERE name LIKE '${TEST_NAME_PREFIX}%' OR idempotency_key LIKE '${TEST_NAME_PREFIX}%'`,
  );
  d1Execute(`DELETE FROM products WHERE sku LIKE '${TEST_SKU_PREFIX}%'`);
}

// Simple wrapper for fetching the stage worker. Tests pass headers / body etc.
export async function stageFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${STAGE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
  // Insert (or upsert) admin user
  d1Execute(
    `INSERT OR REPLACE INTO admin_users (email, password_hash, role, must_change_password, created_at)
     VALUES ('${email}', 'test-hash-not-real', 'admin', 0, '${new Date().toISOString()}')`,
  );
  // Insert session
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
