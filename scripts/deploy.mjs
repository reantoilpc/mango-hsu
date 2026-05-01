// Patch the Astro-generated dist/server/wrangler.json with env-specific bindings,
// then run `wrangler deploy`. Astro 6 + @astrojs/cloudflare 13 generate a flattened
// wrangler.json that ignores root env.* sections, so we splice in the right values
// here based on TARGET (stage|prod).
//
// Usage:
//   bun run scripts/deploy.mjs stage
//   bun run scripts/deploy.mjs prod

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const STAGE = {
  name: "mango-hsu-stage",
  d1: {
    database_name: "mango-hsu-stage",
    database_id: "abd4a95a-ba94-4a32-851d-c5eeb13199c0",
  },
  ratelimit_kv_id: "3c7807740837434688a43ab8cda83bb8",
  session_kv_id: "fc11f54aa027461d895c35ce6afa0c7d",
  bank_account_display: "808 玉山銀行 / 0901979086154 (STAGE)",
};

const PROD = {
  name: "mango-hsu",
  d1: {
    database_name: "mango-hsu-prod",
    database_id: "5e62f4ee-1cd6-4495-b476-b95fa756e2c8",
  },
  ratelimit_kv_id: "91b765a3001a47a1a4ee61ac97d9d051",
  session_kv_id: "8e44dd95296e425eaca981d2a211261c",
  bank_account_display: "808 玉山銀行 / 0901979086154",
};

const target = process.argv[2];
if (target !== "stage" && target !== "prod") {
  console.error("usage: bun run scripts/deploy.mjs stage|prod");
  process.exit(1);
}
const cfg = target === "stage" ? STAGE : PROD;

const path = "dist/server/wrangler.json";
const wrangler = JSON.parse(readFileSync(path, "utf8"));

wrangler.name = cfg.name;
wrangler.d1_databases = [
  {
    binding: "DB",
    database_name: cfg.d1.database_name,
    database_id: cfg.d1.database_id,
    migrations_dir: "drizzle",
  },
];
wrangler.kv_namespaces = [
  { binding: "SESSION", id: cfg.session_kv_id },
  { binding: "RATELIMIT", id: cfg.ratelimit_kv_id },
];
wrangler.vars = {
  ...wrangler.vars,
  BANK_ACCOUNT_DISPLAY: cfg.bank_account_display,
};

writeFileSync(path, JSON.stringify(wrangler, null, 2));
console.log(`patched dist/server/wrangler.json → ${target} (worker: ${cfg.name})`);

const result = spawnSync("bunx", ["wrangler", "deploy"], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
