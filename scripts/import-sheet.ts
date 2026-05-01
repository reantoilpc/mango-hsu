// Import V1 Google Sheet CSV exports into D1.
//
// Workflow:
//   1. Export 4 tabs from `mango-hsu-orders` Sheet:
//      File → Download → Comma Separated Values (.csv)
//      Save to /private/v1-export-YYYYMMDD/{settings,products,orders,errors}.csv
//   2. bun run scripts/import-sheet.ts /private/v1-export-YYYYMMDD > import.sql
//   3. Inspect import.sql then:
//      wrangler d1 execute mango-hsu-prod --file=import.sql --remote
//
// V1 schema reference (from apps-script/Code.gs):
//   orders: order_id | created_at | name | phone | address | items_json |
//           subtotal | shipping | total | expected_memo | pdpa_accepted |
//           paid | shipped | tracking_no | notes | idempotency_key
//   products: sku | 品名 | 規格 | 單價 | available

import { readFile } from "node:fs/promises";
import { join } from "node:path";

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function bool(s: string): "1" | "0" {
  const v = s.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" ? "1" : "0";
}

// Convert V1 timestamp (likely Asia/Taipei wall clock string) to UTC ISO Z.
// V1 Apps Script uses `new Date().toISOString()` which IS UTC, so values
// SHOULD already be UTC. If they're not (e.g. Sheet auto-formatted), this
// function returns the value as-is and prints a warning to stderr.
function toUtcIso(s: string): string {
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return s;
  // Try to coerce
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    process.stderr.write(`  warn: cannot parse timestamp ${s}, keeping raw\n`);
    return s;
  }
  return d.toISOString();
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: bun run scripts/import-sheet.ts <export-dir>\n");
    process.exit(1);
  }

  const productsCsv = parseCsv(
    await readFile(join(dir, "products.csv"), "utf8"),
  );
  const ordersCsv = parseCsv(await readFile(join(dir, "orders.csv"), "utf8"));

  const stmts: string[] = [];
  stmts.push("BEGIN TRANSACTION;");
  stmts.push("PRAGMA foreign_keys = ON;");

  // products
  let displayOrder = 0;
  for (const r of productsCsv) {
    const sku = r["sku"]!;
    const name = r["品名"] ?? r["name"] ?? "";
    const variant = r["規格"] ?? r["variant"] ?? "";
    const price = parseInt(r["單價"] ?? r["price"] ?? "0", 10);
    const available = bool(r["available"] ?? "false");
    stmts.push(
      `INSERT INTO products (sku, name, variant, price, available, display_order) VALUES (${sqlString(sku)}, ${sqlString(name)}, ${sqlString(variant)}, ${price}, ${available}, ${displayOrder++});`,
    );
  }

  // orders + order_items
  for (const r of ordersCsv) {
    const orderId = r["order_id"]!;
    if (!orderId) continue;

    const created = toUtcIso(r["created_at"] ?? "");
    const name = r["name"] ?? "";
    const phone = r["phone"] ?? "";
    const address = r["address"] ?? "";
    const notes = r["notes"] ?? "";
    const subtotal = parseInt(r["subtotal"] ?? "0", 10);
    const shipping = parseInt(r["shipping"] ?? "0", 10);
    const total = parseInt(r["total"] ?? "0", 10);
    const expectedMemo = r["expected_memo"] ?? "";
    const pdpa = bool(r["pdpa_accepted"] ?? "false");
    const paid = bool(r["paid"] ?? "false");
    const shipped = bool(r["shipped"] ?? "false");
    const trackingNo = r["tracking_no"] ?? "";
    const idempotencyKey = r["idempotency_key"] ?? `imported-${orderId}`;

    stmts.push(
      `INSERT INTO orders (order_id, created_at, name, phone, address, notes, subtotal, shipping, total, expected_memo, pdpa_accepted, paid, shipped, tracking_no, idempotency_key) VALUES (` +
        [
          sqlString(orderId),
          sqlString(created),
          sqlString(name),
          sqlString(phone),
          sqlString(address),
          notes ? sqlString(notes) : "NULL",
          subtotal,
          shipping,
          total,
          sqlString(expectedMemo),
          pdpa,
          paid,
          shipped,
          trackingNo ? sqlString(trackingNo) : "NULL",
          sqlString(idempotencyKey),
        ].join(", ") +
        `);`,
    );

    // Parse items_json into order_items
    const itemsJson = r["items_json"] ?? "[]";
    let items: Array<{ sku: string; qty: number }> = [];
    try {
      const parsed = JSON.parse(itemsJson);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      process.stderr.write(`  warn: order ${orderId} items_json unparseable, skipping items\n`);
    }

    for (const item of items) {
      const product = productsCsv.find((p) => p["sku"] === item.sku);
      const unitPrice = product
        ? parseInt(product["單價"] ?? product["price"] ?? "0", 10)
        : 0;
      stmts.push(
        `INSERT INTO order_items (order_id, sku, qty, unit_price) VALUES (${sqlString(orderId)}, ${sqlString(item.sku)}, ${item.qty}, ${unitPrice});`,
      );
    }
  }

  stmts.push("COMMIT;");

  process.stdout.write(stmts.join("\n") + "\n");
  process.stderr.write(
    `\n  imported ${productsCsv.length} products, ${ordersCsv.length} orders\n` +
      `  next: wrangler d1 execute mango-hsu-stage --file=import.sql --remote\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
