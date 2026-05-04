# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, save state, save my work → invoke context-save
- Resume, where was I, pick up where I left off → invoke context-restore
- Code quality, health check → invoke health

## Commands

Package manager is **bun**. Use `bun install` to install deps.

| Task | Command |
|---|---|
| Local dev server (with Cloudflare bindings via platformProxy) | `bun run dev` |
| Type-check + build | `bun run build` |
| Preview built worker | `bun run preview` |
| Generate Drizzle migration from schema diff | `bun run db:generate` |
| Apply migrations to stage D1 | `bun run db:migrate:stage` |
| Apply migrations to prod D1 | `bun run db:migrate:prod` |
| Snapshot prod D1 to `backups/mango-YYYYMMDD.sqlite` | `bun run db:export:prod` |
| Build + deploy main worker to stage | `bun run deploy:stage` |
| Build + deploy main worker to prod | `bun run deploy:prod` |
| Deploy standalone cron worker | `bunx wrangler deploy --env cron` |

Secrets are set with `bunx wrangler secret put NAME` (per environment with `--env stage`). Required secrets: `ORDER_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `LINE_OA_TOKEN`, `LINE_LIFF_ID`, `LINE_OA_ADD_FRIEND_URL`, `LIFF_BIND_HMAC_SECRET`, plus session-related ones.

### Pre-commit hook (one-time per clone)

```
git config core.hooksPath .githooks
brew install gitleaks   # or platform equivalent
```

The hook runs `gitleaks protect --staged`. Bypass only with `git commit --no-verify` and only for verified false positives — real leaks must be rotated.

## Architecture

### Stack
- **Astro 6** with `output: 'server'` and `@astrojs/cloudflare` adapter — every route is SSR on Cloudflare Workers; no static prerender.
- **Cloudflare D1** (SQLite) via **Drizzle ORM**. Schema is the source of truth (`src/db/schema.ts`); migrations in `drizzle/` are committed.
- **Cloudflare KV** for `RATELIMIT` and (in deploy script) `SESSION` bindings.
- **Tailwind CSS v4** via `@tailwindcss/vite`.
- **TypeScript** throughout, including `.astro` frontmatter.

### Two workers, one repo
1. **Main Astro worker** (default `wrangler.jsonc` top-level + `env.stage`): serves the customer site, admin UI, and `/api/*`. `main` is intentionally omitted at the top level — `@astrojs/cloudflare` 13.x writes it during build to `dist/_worker.js/index.js`.
2. **Cron worker** (`env.cron`, `main: ./src/cron-worker.ts`): runs `0 18 * * 0` (weekly Sun 18:00 UTC) and calls `purgeOldOrders` (PDPA 6-month deletion). Deployed independently because adapter support for `scheduled()` is uneven.

### Deploy pipeline quirk — read this before touching deploy
`@astrojs/cloudflare` 13.x produces a flattened `dist/server/wrangler.json` and does **not** honor the root `env.*` sections of `wrangler.jsonc`. `scripts/deploy.mjs` patches the generated file post-build with stage-vs-prod values (worker name, D1 IDs, KV IDs, `BANK_ACCOUNT_DISPLAY`) before invoking `wrangler deploy`. If you add a per-env binding, update both `wrangler.jsonc` (for local platformProxy / docs) **and** the `STAGE`/`PROD` blocks in `scripts/deploy.mjs`.

### Env access
Astro 6 removed `Astro.locals.runtime.env`. Use the typed re-export from `src/lib/env.ts` (`import { env } from '...'`) — it wraps `cloudflare:workers`'s request-scoped `env` with the `AppEnv` type defined in `src/db/client.ts`. Never cast `Astro.locals` directly.

### Auth & middleware
- `src/middleware.ts` runs on every request: applies CSP + security headers, and gates `/admin/**` (except `/admin/login`) behind a session cookie. CSP allows `'unsafe-inline'` for scripts because the LIFF bind page uses `<script define:vars is:inline>` and Astro hydration; all inline content is server-controlled.
- Session = 32-byte hex token in `sessions` table. Cookie `mh_session` is `HttpOnly; Secure; SameSite=Strict`. Helpers in `src/lib/auth.ts`.
- Passwords: PBKDF2-SHA256, 20k iterations (pinned — see comment in `src/lib/auth.ts` for the Workers-CPU-budget reasoning before changing). Format `pbkdf2$<iters>$<base64-salt>$<base64-hash>`.
- CSRF: `requireSameOrigin()` in `src/lib/csrf.ts` is the second-line Origin/Referer check on mutating endpoints, complementing `SameSite=Strict`.

### Domain conventions
- **Order IDs** are `M-YYYYMMDD-NNN` where the date is **Asia/Taipei calendar day** (preserves V1 behavior). All other timestamp columns are **UTC ISO-8601 with `Z` suffix**. Don't mix timezones — see `src/db/schema.ts` and `src/lib/order-id.ts`.
- `nextOrderId` counts same-day rows; concurrent inserts can collide. The `orders.order_id` PRIMARY KEY catches it; callers must retry once on collision.
- Audit log: `audit_log.user_email` is **intentionally not** an FK (admins can be deleted but audit history must remain); `audit_log.order_id` **is** FK with cascade so PDPA purge cleans tied audit rows.
- Money columns are integers (TWD).

### Routing layout
- Customer: `/`, `/products`, `/order`, `/status` (lookup by `?id=M-...`, returns only `paid`/`shipped`/`tracking_no` — no PII).
- Admin (gated by middleware): `/admin/*` — orders list/detail, products, batches, audit, change-password.
- LIFF: `/liff/bind` — LINE Login binds a `line_user_id` to an order via an HMAC-signed URL. Payload is `${order}:${phoneLast4}:${exp}` so a leaked URL alone is insufficient (see `src/lib/line.ts`).
- API: `/api/site/status`, `/api/orders` (POST create), `/api/orders/[id]/public|liff-url`, `/api/admin/**`, `/api/liff/bind`.

### Notifications & external integrations
- New-order Telegram push to a family group chat — token + chat_id are secrets, not in `wrangler.jsonc`.
- LINE Messaging API push for status updates (paid/shipped). Monthly cap tracking lives in `src/lib/line.ts` (200 cap, 160 alert threshold).
- `apps-script/Code.gs` is the legacy V1 backend (Apps Script + Google Sheets). V2 has migrated off it; the file remains for reference and the cutover-window fallback in `src/lib/api.ts` (`PUBLIC_APPS_SCRIPT_URL`).

### Operations docs
`docs/family-runbook.md` — Chinese ops manual for non-technical family operators (Telegram setup, daily reconciliation, SKU availability toggling, season open/close). `docs/design-v1.md` — original product design doc with rationale for many constraints (信任圈, no SEO, available-only stock, Asia/Taipei order IDs).
