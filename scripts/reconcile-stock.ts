// V5.2 stock reconciliation tool.
//
// What it does:
//   For each `product_groups` row, sum all `audit_log` rows where
//   `action='group_stock_change'` and `details.group_id = pg.id`, and compare against
//   `pg.stock_fen`. Prints a report; exits 0 if no drift, exits 1 if drift detected.
//
// Why it exists:
//   v5.2 design (D3=A) requires every stock_fen mutation to write a complete audit_log
//   row with delta_fen. If that invariant holds, SUM(deltas) == current stock_fen for
//   every group. Drift means an audit row was missed somewhere — either a bug in the
//   mutation site, or someone manually edited the DB, or a Phase B batch failed leaving
//   the stock un-restored without an audit (cancel.ts Known Hole).
//
// When to run:
//   - After every prod deploy
//   - Whenever you suspect inventory looks off
//   - As part of CI smoke tests against stage
//
// Usage:
//   bun run scripts/reconcile-stock.ts --env stage|prod
//
// Implementation note:
//   This shells out to `wrangler d1 execute` rather than connecting to D1 directly,
//   matching tests/_setup.ts pattern. Avoids needing API tokens or worker bindings
//   when run from a dev machine.

import { spawnSync } from "node:child_process";
import { argv, exit } from "node:process";

const envArgIdx = argv.indexOf("--env");
const envName = envArgIdx >= 0 ? argv[envArgIdx + 1] : "stage";
if (envName !== "stage" && envName !== "prod") {
  console.error("Usage: bun run scripts/reconcile-stock.ts --env stage|prod");
  exit(2);
}

const D1_DATABASE = envName === "prod" ? "mango-hsu-prod" : "mango-hsu-stage";

interface GroupRow {
  id: number;
  name: string;
  stock_fen: number;
  season_id: number;
  season_code: string;
}

interface AuditRow {
  group_id: number;
  delta_fen: number;
  ts: string;
  reason: string | null;
}

function d1Execute<T>(sql: string): T[] {
  const args = [
    "wrangler",
    "d1",
    "execute",
    D1_DATABASE,
    "--remote",
    "--json",
    "--command",
    sql,
  ];
  // stage uses --env flag too; prod uses root binding
  if (envName === "stage") args.splice(4, 0, "--env", "stage");
  const r = spawnSync("bunx", args, { encoding: "utf-8" });
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
  const arr = parsed as Array<{ success: boolean; results: T[]; error?: string }>;
  if (!arr[0]?.success) {
    throw new Error(`d1 query failed: ${arr[0]?.error ?? JSON.stringify(arr[0])}`);
  }
  return arr[0].results;
}

console.log(`Reconciling stock_fen for ${envName} (${D1_DATABASE})...`);
console.log("");

// Pull all product_groups + their season info
const groups = d1Execute<GroupRow>(
  `SELECT pg.id, pg.name, pg.stock_fen, pg.season_id, s.code AS season_code
     FROM product_groups pg
     JOIN seasons s ON s.id = pg.season_id
    ORDER BY s.code, pg.display_order, pg.id`,
);

// Pull all stock_change audit rows and parse details JSON in script (no jsonb in SQLite).
// For larger datasets (millions of rows) this would need pagination, but mango-hsu
// produces tens of audit rows per day max — fine.
const auditRows = d1Execute<{ details: string; ts: string }>(
  `SELECT details, ts FROM audit_log WHERE action = 'group_stock_change' ORDER BY ts ASC`,
);

const auditByGroup = new Map<number, AuditRow[]>();
for (const r of auditRows) {
  if (!r.details) continue;
  let parsed: { group_id?: number; delta_fen?: number; reason?: string };
  try {
    parsed = JSON.parse(r.details);
  } catch {
    console.warn(`! malformed audit details: ${r.details}`);
    continue;
  }
  if (typeof parsed.group_id !== "number" || typeof parsed.delta_fen !== "number") {
    console.warn(`! audit row missing group_id/delta_fen: ${r.details}`);
    continue;
  }
  const list = auditByGroup.get(parsed.group_id) ?? [];
  list.push({
    group_id: parsed.group_id,
    delta_fen: parsed.delta_fen,
    ts: r.ts,
    reason: parsed.reason ?? null,
  });
  auditByGroup.set(parsed.group_id, list);
}

let driftCount = 0;
const driftReports: string[] = [];

for (const g of groups) {
  const audits = auditByGroup.get(g.id) ?? [];
  const expected = audits.reduce((s, a) => s + a.delta_fen, 0);
  const actual = g.stock_fen;
  const diff = actual - expected;

  const fenToJin = (n: number) => (n / 100).toFixed(2);
  const status = diff === 0 ? "OK" : "DRIFT";

  console.log(
    `[${status}] season ${g.season_code} | group ${g.id} ${g.name} | ` +
      `stock_fen=${actual} (${fenToJin(actual)}斤) ` +
      `audit_sum=${expected} (${fenToJin(expected)}斤) ` +
      `diff=${diff}`,
  );
  if (diff !== 0) {
    driftCount++;
    driftReports.push(
      `Group ${g.id} (${g.name}, season ${g.season_code}): expected ${expected} fen, actual ${actual} fen, diff=${diff}`,
    );
    // List most recent 5 audits for context
    const recent = audits.slice(-5);
    for (const a of recent) {
      console.log(`    audit: ts=${a.ts} delta=${a.delta_fen} reason=${a.reason}`);
    }
  }
}

console.log("");
if (driftCount === 0) {
  console.log(`✓ All ${groups.length} groups reconcile cleanly.`);
  exit(0);
} else {
  console.log(`✗ ${driftCount} group(s) with drift:`);
  driftReports.forEach((r) => console.log(`    ${r}`));
  console.log("");
  console.log(
    "Recovery: investigate the missing audit row (most likely cancel.ts Step 2 batch failure or manual SQL)\n" +
      "and run adjustGroupStock with positive/negative delta + reason='correction' to bring pool back into sync.",
  );
  exit(1);
}
