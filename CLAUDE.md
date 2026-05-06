# CLAUDE.md

## Skill routing
Invoke matching skill via Skill tool FIRST.

- brainstorm → office-hours
- bugs / 500s → investigate
- ship / deploy / PR → ship
- QA → qa
- code review → review
- post-ship docs → document-release
- weekly retro → retro
- design system → design-consultation
- visual audit → design-review
- architecture review → plan-eng-review
- save / restore session → context-save / context-restore
- code health → health

## Commands
See `package.json` scripts (bun + wrangler). Cron worker: `bunx wrangler deploy --env cron`. Secrets via `wrangler secret put` — see `AppEnv` in `src/db/client.ts`.

## Architecture
Astro 6 SSR on Cloudflare Workers + D1/Drizzle + KV + Tailwind v4. Two workers: main Astro (`env.stage`) and cron (`env.cron`, `src/cron-worker.ts`, weekly PDPA `purgeOldOrders`).

**Deploy quirk:** `@astrojs/cloudflare` flattens `dist/server/wrangler.json` and ignores root `env.*`. `scripts/deploy.mjs` patches it post-build. **Per-env bindings must update both `wrangler.jsonc` and `scripts/deploy.mjs`.**

**Env access:** Astro 6 dropped `Astro.locals.runtime.env`. Import typed `env` from `src/lib/env.ts` (wraps `cloudflare:workers`).

**Auth (`src/middleware.ts`, `src/lib/auth.ts`, `src/lib/csrf.ts`):** Cookie `mh_session` gates `/admin/**` except `/admin/login`; CSP + security headers site-wide. PBKDF2-SHA256 20k iters pinned (Workers CPU budget). `requireSameOrigin()` is second-line CSRF on mutations.

**Conventions:** Order IDs `M-YYYYMMDD-NNN` use **Asia/Taipei** calendar; other timestamps are **UTC ISO-8601 + Z**. `audit_log.user_email` intentionally not an FK (history survives admin deletion); `audit_log.order_id` is FK-cascaded for PDPA purge.

**Notifications (`src/lib/line.ts`):** Telegram new-order push, LINE status push (monthly cap 200), LIFF bind HMAC URL.

## Testing
- `bun test` runs all tests; `bun test:watch` for dev mode.
- Pure units (`tests/stock-helper.test.ts`) need no env.
- Integration tests (`tests/stock-d1.test.ts`, `tests/admin-idempotency.test.ts`, `tests/regression-cancelled-orders.test.ts`) hit the **stage** worker over HTTP and use `wrangler d1 execute --remote` to seed/cleanup. They require:
  - `MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev` env var
  - `TEST_TOKEN=<stage ORDER_TOKEN>` env var (NEVER use prod's)
  - `wrangler login` completed (or `CLOUDFLARE_API_TOKEN`)
- Test data uses `test-` prefix on SKUs / customer names — `cleanupTestData()` only deletes those rows.
- See `tests/_setup.ts` for helpers (`seedSku`, `getSkuStock`, `createTestAdminSession`, `cleanupTestData`).
