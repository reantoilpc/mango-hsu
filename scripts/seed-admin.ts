// Generate SQL to seed admin_users with manually-rolled accounts.
//
// Run: bun run scripts/seed-admin.ts > seed-admin.sql
// Apply: wrangler d1 execute mango-hsu-stage --file=seed-admin.sql --remote
//   (or --env stage / --env prod accordingly)
//
// Customize the ACCOUNTS list below before running. Initial passwords are
// random and printed to stderr so you can hand them to family via LINE.

import { hashPassword } from "../src/lib/auth";

type SeedAccount = { email: string; role: "admin" | "operator" };

const ACCOUNTS: SeedAccount[] = [
  { email: "rayhsu@example.com", role: "admin" },
  // { email: "mom@example.com", role: "operator" },
  // { email: "dad@example.com", role: "operator" },
];

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes))
    .replace(/[+/=]/g, "")
    .slice(0, 12);
}

const lines: string[] = [];
const credentials: Array<{ email: string; password: string }> = [];

for (const acct of ACCOUNTS) {
  const password = randomPassword();
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  lines.push(
    `INSERT INTO admin_users (email, password_hash, role, must_change_password, created_at) VALUES ('${acct.email}', '${hash}', '${acct.role}', 1, '${now}');`,
  );
  credentials.push({ email: acct.email, password });
}

process.stdout.write(lines.join("\n") + "\n");
process.stderr.write("\n=== INITIAL CREDENTIALS (LINE these to family) ===\n");
for (const c of credentials) {
  process.stderr.write(`  ${c.email}  ${c.password}\n`);
}
process.stderr.write(
  "\nCopy SQL into seed-admin.sql then:\n" +
    "  wrangler d1 execute mango-hsu-prod --file=seed-admin.sql --remote\n",
);
