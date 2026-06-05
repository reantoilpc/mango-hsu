// Patch the Astro-generated dist/server/wrangler.json with env-specific bindings,
// then run `wrangler deploy`. Astro 6 + @astrojs/cloudflare 13 generate a flattened
// wrangler.json that ignores root env.* sections, so we splice in the right values
// here based on TARGET (stage|prod).
//
// Usage:
//   bun run scripts/deploy.mjs stage
//   bun run scripts/deploy.mjs prod

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadEnv } from "vite";
import { validateOrderToken } from "./order-token-guard.mjs";

const STAGE = {
  name: "mango-hsu-stage",
  d1: {
    database_name: "mango-hsu-stage",
    database_id: "abd4a95a-ba94-4a32-851d-c5eeb13199c0",
  },
  ratelimit_kv_id: "3c7807740837434688a43ab8cda83bb8",
  session_kv_id: "fc11f54aa027461d895c35ce6afa0c7d",
  bank_account_display: "808 玉山銀行 / 0901979086154 (STAGE)",
  allow_test_bypass: "1",
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
// ALLOW_TEST_BYPASS must be reset on every deploy. dist/server/wrangler.json
// can carry stale vars from a prior `bun run deploy:stage` (the spread above
// inherits anything Astro emitted plus any prior patch). Without an explicit
// delete, a `deploy:stage` followed by `deploy:prod` from the same dist would
// ship stage's bypass flag to prod, neutering the rate limit on /api/orders.
if (cfg.allow_test_bypass) {
  wrangler.vars.ALLOW_TEST_BYPASS = cfg.allow_test_bypass;
} else {
  delete wrangler.vars.ALLOW_TEST_BYPASS;
}

writeFileSync(path, JSON.stringify(wrangler, null, 2));
console.log(`patched dist/server/wrangler.json → ${target} (worker: ${cfg.name})`);

// Guard: if .env.local lacks PUBLIC_ORDER_TOKEN at build time, Astro substitutes
// the wrangler.jsonc placeholder "REPLACE_AT_BUILD_TIME" as the literal value
// into the customer JS bundle (src/lib/api.ts reads import.meta.env.PUBLIC_ORDER_TOKEN).
// Every customer order then fails server-side with INVALID_TOKEN, silently. Catch
// it here. Scope: dist/client/ only — dist/server/wrangler.json's PUBLIC_ORDER_TOKEN
// var carries the placeholder by design (server never reads it; auth uses env.ORDER_TOKEN
// secret instead), so a hit there is benign.
const PLACEHOLDER = "REPLACE_AT_BUILD_TIME";
function findPlaceholderIn(dir) {
  const hits = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      hits.push(...findPlaceholderIn(full));
    } else if (
      /\.(mjs|js|html)$/.test(name) &&
      readFileSync(full, "utf8").includes(PLACEHOLDER)
    ) {
      hits.push(full);
    }
  }
  return hits;
}
const placeholderHits = findPlaceholderIn("dist/client");
if (placeholderHits.length > 0) {
  console.error(
    `\n✗ aborting deploy — '${PLACEHOLDER}' still in client bundle after build.\n` +
      `  Files: ${placeholderHits.join(", ")}\n` +
      `  Cause: .env.local is missing PUBLIC_ORDER_TOKEN, so import.meta.env.PUBLIC_ORDER_TOKEN\n` +
      `  resolved to the wrangler.jsonc placeholder. Set PUBLIC_ORDER_TOKEN in .env.local\n` +
      `  to the target env's ORDER_TOKEN secret value, then re-run.\n`,
  );
  process.exit(1);
}

// Guard 2 (2026-06-05 incident): import.meta.env.PUBLIC_ORDER_TOKEN ?? "" bakes an
// EMPTY string into the client bundle whenever the build has no PUBLIC_ORDER_TOKEN —
// note this is "" , NOT the REPLACE_AT_BUILD_TIME placeholder (that placeholder lives
// in wrangler.jsonc vars, which only feed the SERVER binding, never the client
// import.meta.env inlining). So Guard 1 never fires for this case. Every customer
// order then POSTs token:"" and the server rejects it with INVALID_TOKEN, silently.
// The incident build ran where no env file was present (.env is gitignored), so the
// token resolved to "". Resolve the token the SAME way the build did — vite's loadEnv
// reads the full cascade (.env, .env.local, .env.[mode], .env.[mode].local) plus
// process.env and strips quotes — so the guard can never disagree with what Astro
// actually inlined. astro build runs in production mode, so use that here too.
const viteEnv = loadEnv("production", process.cwd(), "PUBLIC_");
const expectedToken = validateOrderToken(viteEnv.PUBLIC_ORDER_TOKEN);
if (!expectedToken) {
  console.error(
    `\n✗ aborting deploy — no non-empty PUBLIC_ORDER_TOKEN available for the build.\n` +
      `  The client bundle would bake an empty token (import.meta.env.PUBLIC_ORDER_TOKEN ?? "")\n` +
      `  and EVERY customer order would fail server-side with INVALID_TOKEN.\n` +
      `  Set PUBLIC_ORDER_TOKEN (to the ${target} env's ORDER_TOKEN secret value) in .env\n` +
      `  or .env.local, then clean-build and retry:\n` +
      `    rm -rf dist .astro node_modules/.vite && bun run deploy:${target}\n`,
  );
  process.exit(1);
}
// Backstop: require the resolved token to actually appear in the client bundle. This
// catches a stale build cache that re-shipped a previous env's token (Vite skips
// re-inlining import.meta.env when only an env file changed but the source didn't).
function clientBundleContains(dir, needle) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (clientBundleContains(full, needle)) return true;
    } else if (/\.(mjs|js)$/.test(name) && readFileSync(full, "utf8").includes(needle)) {
      return true;
    }
  }
  return false;
}
if (!clientBundleContains("dist/client", expectedToken)) {
  console.error(
    `\n✗ aborting deploy — the expected PUBLIC_ORDER_TOKEN is NOT in the client bundle.\n` +
      `  A stale build cache re-shipped the previous env's token (Vite skips re-inlining\n` +
      `  import.meta.env when only .env.local changed). Customer orders would fail with\n` +
      `  INVALID_TOKEN. Clean-build and retry:\n` +
      `    rm -rf dist .astro node_modules/.vite && bun run deploy:${target}\n`,
  );
  process.exit(1);
}

const result = spawnSync("bunx", ["wrangler", "deploy"], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
