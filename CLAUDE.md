# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
Bun + wrangler. Full list in `package.json`; the ones used most:

- `bun run dev` — Astro dev server with Cloudflare bindings via `platformProxy`
- `bun run build` — type-check + build (also runs inside `deploy:*`)
- `bun run deploy:stage` / `bun run deploy:prod` — build, then `scripts/deploy.mjs` patches `dist/server/wrangler.json` and runs `wrangler deploy`. Before either: `.env.local`'s `PUBLIC_ORDER_TOKEN` must equal the **target env's** `ORDER_TOKEN` wrangler secret. Stage and prod have different secrets, build is single-pass, so swap the active line in `.env.local` per cross-env deploy. The script aborts if `dist/client/` still contains the literal `REPLACE_AT_BUILD_TIME` (which means `.env.local` was missing the var entirely)
- `bunx wrangler deploy --env cron --config wrangler.jsonc` — deploy the standalone cron worker. The `--config` flag is REQUIRED: without it, wrangler picks up Astro's leftover `dist/server/wrangler.json` (named `mango-hsu-stage` or `mango-hsu` from the last main-worker deploy), silently ignores `--env cron`, and redeploys the main worker instead of the cron. Cron schedule uses Cloudflare ISO weekday convention (1=MON..7=SUN), not Unix (0=SUN) — `0 18 * * 7` means Sunday 18:00 UTC.
- `bun run db:generate` — regenerate Drizzle migration after editing `src/db/schema.ts`
- `bun run db:migrate:stage` / `bun run db:migrate:prod` — apply migrations to D1 (remote)
- `bun test` / `bun test:watch` — see **Testing** below for required env

Secrets: `wrangler secret put NAME --env <stage|prod>` (and `--env cron` if the cron worker reads it). Canonical list lives in `AppEnv` in `src/db/client.ts`.

## Architecture
Astro 6 SSR on Cloudflare Workers + D1/Drizzle + KV + Tailwind v4. Two separate workers:

- **Main worker** (`mango-hsu` prod / `mango-hsu-stage` stage): everything under `src/pages/**` — public site, `/admin/**`, `/api/**`.
- **Cron worker** (`mango-hsu-cron`, `src/cron-worker.ts`): standalone scheduled handler. Sunday 18:00 UTC runs `purgeOldOrders` (PDPA 6-month delete; FK cascades to `order_items` + `audit_log` — `PRAGMA foreign_keys = ON` is set explicitly because D1 doesn't default to it).

### Deploy quirk (read before touching bindings)
`@astrojs/cloudflare` 13 flattens `dist/server/wrangler.json` and ignores root `env.*` overrides. `scripts/deploy.mjs` patches the flattened file post-build with per-env D1/KV/vars, then runs `wrangler deploy`. **Adding or changing any per-env binding requires updating BOTH `wrangler.jsonc` AND `scripts/deploy.mjs`.** The cron worker is exempt — it deploys directly from `wrangler.jsonc` via `--env cron`. The script also explicitly resets `ALLOW_TEST_BYPASS` because `dist/server/wrangler.json` can carry stale vars from a prior deploy and silently ship stage's bypass flag to prod.

### Env access
Astro 6 dropped `Astro.locals.runtime.env`. Import the typed `env` from `src/lib/env.ts` (it wraps `cloudflare:workers`'s request-scoped AsyncLocalStorage) — don't reach into `Astro.locals.runtime`.

### Auth (`src/middleware.ts`, `src/lib/auth.ts`, `src/lib/admin-api.ts`, `src/lib/csrf.ts`)
- Cookie `mh_session` (HttpOnly + Secure + SameSite=Strict) gates `/admin/**` except `/admin/login`; middleware redirects unauthed requests and applies CSP + security headers site-wide.
- `/api/admin/**` mutation endpoints **re-check** the session via `authorizeAdmin()` (don't trust middleware alone) and run `requireSameOrigin()` as second-line CSRF defense (Origin/Referer host match).
- PBKDF2-SHA256 pinned at **20k iters** — deliberate trade-off for Workers free-tier 10ms CPU/req cap (~6ms at 20k on V8 isolate). OWASP 2026 recommends 600k; rationale documented in `src/lib/auth.ts`.
- CSP allows `'unsafe-inline'` on script-src/style-src for the LIFF SDK bridge and Astro hydration bootstrap; all inline content is server-controlled. Migrate to nonce/hash-based CSP if user-generated HTML is ever introduced.

### Order pipeline patterns
Both `/api/orders` (customer) and `/api/admin/orders` (admin-relayed) follow the same race-aware sequence:

1. **Idempotency precheck** — replay the existing order if `idempotency_key` already inserted (admin path checks BEFORE stock decrement so a double-submit doesn't consume stock twice).
2. **Atomic stock reserve** via `tryDecrementStock()` — `UPDATE products SET stock = stock - ?1 WHERE sku = ?2 AND stock >= ?1` per item, in one `env.DB.batch()`. D1 batch is all-or-nothing for commits, but a 0-row UPDATE is still a "successful" stmt — inspect `meta.changes` per row and compensate via `restoreStock()` on partial failure.
3. **`nextOrderId()` retry loop (max 3)** — two concurrent inserts at the same Taipei second compute the same N; the `orders.order_id` PK catches it. On collision, retry WITHOUT restoring stock (same items[] reused). On `idempotency_key` UNIQUE collision, DO restore and return the winning order.

Status-change endpoints (`mark-paid.ts`, `mark-shipped.ts`, `cancel.ts`) and the V5 `save.ts` editable-fields endpoint use a **gate-first batch** pattern: separate SELECT validates `expected_state`, then a single `env.DB.batch([...])` writes everything (data + audit row), with application-level stock compensation if the batch throws. Don't gate mid-batch — `mark-paid.ts` had a 0-row-UPDATE bug from doing that.

`save.ts` (V5 sticky-save) extras to know about:
- Accepts an optional `items_hash` (V5.1) inside `expected_state` — server compares against `itemsHash(currentItems)` to detect concurrent two-tab item edits that paid/shipped/cancelled flags can't see. Legacy clients without it fall through to last-write-wins.
- Idempotency replay scans the **last 10** `audit_log` rows for the same `order_id` within a 60s window matching `details.idempotency_key`. Scanning more than just the latest row is intentional — an interleaved status event between save and retry must not knock the retry out of the cache.
- Server-side field diff: address/notes are compared against the DB row before being audited — clients can't lie about "what changed".

### Conventions
- Order IDs `M-YYYYMMDD-NNN` use **Asia/Taipei** calendar day. **All other timestamps are UTC ISO-8601 with `Z` suffix.**
- `audit_log.user_email` is **intentionally NOT a FK** — audit history must survive admin account deletion. `audit_log.order_id` IS a FK with `onDelete: cascade` so the PDPA purge removes tied audit rows (potentially containing PII in `details`).
- `audit_log.details` is a free-form JSON blob; idempotency replay reads `details.idempotency_key` from it.
- `available=false` hides a SKU regardless of stock; `available=true && stock=0` renders "售完".

### Rate limits (`src/lib/rate-limit.ts`)
KV-backed buckets, separate windows: `/api/orders` 3/60s/IP, `/admin/login` 5/15min/IP + 10/15min/email (two layers — IP catches single-source brute force, email catches cross-IP attempts), `/api/orders/:id/liff-url` 10/60s/IP, public status 30/hr/IP. Stage worker honors `X-Test-Mode: 1` to bypass `/api/orders` rate limit, gated on `ALLOW_TEST_BYPASS === "1"` (set ONLY on stage by `scripts/deploy.mjs`, never on prod) AND a valid `ORDER_TOKEN`.

### Notifications (`src/lib/line.ts`, `src/lib/telegram.ts`)
- Telegram fire-and-forget on new order via `ctx.waitUntil()`.
- LINE OA push on shipment with **monthly cap of 200** (KV-tracked, alerts at 160); cap-hit writes `line_push_capped` to audit instead of pushing.
- LIFF bind URL is HMAC-signed over `${order_id}:${phone_last_4}:${exp}` — URL alone is insufficient to bind, the customer must know their own phone last-4 (closes a leak vector where the URL is screenshot/forwarded).

## Testing
- `bun test` runs all tests; `bun test:watch` for dev mode.
- Pure units (`tests/stock-helper.test.ts`) need no env.
- Integration tests (`tests/stock-d1.test.ts`, `tests/admin-idempotency.test.ts`, `tests/regression-cancelled-orders.test.ts`, `tests/save-endpoint.test.ts`, `tests/products-batch.test.ts`) hit the **stage** worker over HTTP and shell out to `wrangler d1 execute --remote` for seed/cleanup. They require:
  - `MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev`
  - `TEST_TOKEN=<stage ORDER_TOKEN>` (NEVER prod's)
  - `wrangler login` completed (or `CLOUDFLARE_API_TOKEN` set)
- Test data uses `TEST-` prefix on SKUs (uppercase — admin product validators enforce `[A-Z0-9_-]+`) and `test-` on customer names. `cleanupTestData()` only deletes those rows.
- See `tests/_setup.ts` for helpers: `seedSku`, `getSkuStock`, `createTestAdminSession`, `cleanupTestData`, `clearOrderRateLimit` (wipes `rl:order:*` KV keys between tests since stage's 60s TTL is slower than test traffic).

## Pre-commit hook
One-time per clone: `git config core.hooksPath .githooks` and install `gitleaks` (`brew install gitleaks` on macOS). The hook runs `gitleaks protect --staged` to block token-shaped staged content. Use `--no-verify` only when truly necessary; if a finding is real, rotate the secret too — assume it's already leaked.
