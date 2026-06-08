# 6-digit OTP Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the V6 Telegram link-based forgot-password flow with a 6-digit OTP: enter email → receive a 6-digit code on the store Telegram → enter the code + a new password on one page → reset.

**Architecture:** Reuse the existing two endpoints, the `reset_token`/`reset_token_expires_at` columns, the Telegram push helper, and the 3/hr/email request throttle. The code is stored as `HMAC-SHA256(RESET_OTP_SECRET, "email:code")` (keyed so a DB leak can't reverse a 6-digit value; bound to email so two users with the same code don't collide). Because a 6-digit code has only 1,000,000 combinations, verification is attempt-capped (5 wrong → invalidate) via a new `reset_attempts` column, plus a per-IP verify throttle. The flow is one page (`/admin/forgot-password`) with progressive reveal; `/admin/reset-password` is removed.

**Tech Stack:** Astro 6 SSR on Cloudflare Workers, D1 + Drizzle, KV (rate limit), Web Crypto (`crypto.subtle` HMAC), Bun test (unit local; integration against stage worker).

**Spec:** `docs/superpowers/specs/2026-06-08-otp-password-reset-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/db/schema.ts` | `admin_users`: add `reset_attempts`, drop `reset_token` unique index | Modify |
| `drizzle/0008_*.sql` | Migration: `ADD COLUMN reset_attempts` + `DROP INDEX` | Generate |
| `src/db/client.ts` | `AppEnv` secret `RESET_OTP_SECRET` | Modify |
| `src/lib/auth.ts` | `generateOtpCode`, `hmacResetCode`, `timingSafeEqualHex`; later remove `generateResetToken`/`sha256Hex` | Modify |
| `src/lib/rate-limit.ts` | `checkResetVerifyRate` (per-IP verify throttle) | Modify |
| `src/pages/api/admin/auth/request-reset.ts` | Mint 6-digit code, store HMAC, push code | Rewrite |
| `src/pages/api/admin/auth/reset-password.ts` | Verify `{email,code}`, attempt-cap, reset | Rewrite |
| `src/pages/admin/forgot-password.astro` | Single-page two-state flow | Rewrite |
| `src/pages/admin/reset-password.astro` | Removed | Delete |
| `src/middleware.ts` | Drop `/admin/reset-password` from public paths | Modify |
| `src/lib/telegram.ts` | Comment tweak (payload is a code, not a link) | Modify |
| `tests/auth-reset-helper.test.ts` | Unit tests for the new helpers | Rewrite |
| `tests/_setup.ts` | `setResetToken`/`getResetTokenRow` attempts; `resetCodeHmac`; verify-limit cleanup | Modify |
| `tests/password-reset.test.ts` | Integration tests for the OTP flow | Rewrite |
| `tests/migration-idempotency.test.ts` | Add `reset_attempts` re-ALTER case | Modify (Task 11) |

**Branch:** `feature/otp-password-reset` (already created; spec already committed).

---

### Task 1: Foundation — schema column, drop index, `AppEnv` secret, generate migration

**Files:**
- Modify: `src/db/schema.ts:1-2` (imports), `src/db/schema.ts:84-105` (`admin_users`)
- Modify: `src/db/client.ts:16-23` (`AppEnv` secrets)
- Generate: `drizzle/0008_*.sql`

- [ ] **Step 1: Edit `admin_users` — add `reset_attempts`, remove the unique index**

In `src/db/schema.ts`, replace the whole `admin_users` definition (currently lines 84-105) with:

```ts
export const admin_users = sqliteTable("admin_users", {
  email: text("email").primaryKey(),
  password_hash: text("password_hash").notNull(), // "pbkdf2$<iters>$<base64-salt>$<base64-hash>"
  role: text("role", { enum: ["admin", "operator"] }).notNull(),
  must_change_password: integer("must_change_password", { mode: "boolean" })
    .notNull()
    .default(true),
  created_at: text("created_at").notNull(),
  // 6-digit OTP forgot-password (replaces the V6 link flow). All three are cleared after a
  // successful reset OR when the 5-attempt cap is hit.
  reset_token: text("reset_token"), // HMAC-SHA256(RESET_OTP_SECRET, "email:code") hex — never plaintext
  reset_token_expires_at: text("reset_token_expires_at"), // UTC ISO-8601 + Z; 10-min TTL set by request-reset
  reset_attempts: integer("reset_attempts").notNull().default(0), // wrong-code count; cap 5 → invalidate code
});
```

Note: the third `sqliteTable` argument (the index callback with `uqResetToken`) is gone entirely — the new lookup is by email + HMAC compare, so a globally-unique `reset_token` is no longer needed and would collide when two users draw the same code.

- [ ] **Step 2: Remove the now-unused `sql` import**

The partial index was the only `sql` consumer in this file. In `src/db/schema.ts`, delete line 2:

```ts
import { sql } from "drizzle-orm";
```

Leave line 1 (`import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";`) untouched — `uniqueIndex` is still used by `product_groups` and `products`.

- [ ] **Step 3: Add the `RESET_OTP_SECRET` secret to `AppEnv`**

In `src/db/client.ts`, inside the `// Secrets (set via \`wrangler secret put\`)` block (after `LIFF_BIND_HMAC_SECRET: string;`), add:

```ts
  // HMAC key for 6-digit OTP password-reset codes (set via `wrangler secret put RESET_OTP_SECRET`).
  RESET_OTP_SECRET: string;
```

- [ ] **Step 4: Generate the migration**

Run: `bun run db:generate`
Expected: a new file `drizzle/0008_<adjective_noun>.sql` is created and `_journal.json` gains an entry.

- [ ] **Step 5: Verify the migration SQL**

Run: `cat drizzle/0008_*.sql`
Expected: it contains BOTH an add-column and a drop-index statement, e.g.:

```sql
ALTER TABLE `admin_users` ADD `reset_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX `admin_users_reset_token_unique`;
```

If the `DROP INDEX` line is missing (drizzle occasionally omits index-only diffs), hand-append it to the generated file:

```sql
DROP INDEX `admin_users_reset_token_unique`;
```

- [ ] **Step 6: Typecheck**

Run: `bun run build`
Expected: build succeeds, no type errors (unused-import error would mean Step 2 was skipped).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/client.ts drizzle/
git commit -m "feat(auth): add reset_attempts, drop reset_token unique index, RESET_OTP_SECRET"
```

---

### Task 2: Rate limit — per-IP verify throttle

**Files:**
- Modify: `src/lib/rate-limit.ts` (append after `checkResetRequestRate`, ~line 84)

- [ ] **Step 1: Add `checkResetVerifyRate`**

Append to `src/lib/rate-limit.ts`:

```ts
// /api/admin/auth/reset-password (the verify step) throttle. 10 attempts per 15 min per IP.
// Secondary defense behind the per-code 5-attempt cap (reset_attempts): stops one IP from
// hammering the verify endpoint across accounts. On limit-hit the endpoint returns the SAME
// generic 400 as a bad code (never 429 — a distinct status would itself be a signal).
const RESET_VERIFY_LIMIT = 10;
const RESET_VERIFY_WINDOW_SECONDS = 15 * 60;

export async function checkResetVerifyRate(env: AppEnv, ip: string): Promise<boolean> {
  const key = `rl:reset_verify:${ip}`;
  const cur = await env.RATELIMIT.get(key);
  const count = cur ? parseInt(cur, 10) : 0;
  if (!Number.isFinite(count)) return false;
  if (count >= RESET_VERIFY_LIMIT) return false;
  await env.RATELIMIT.put(key, String(count + 1), {
    expirationTtl: RESET_VERIFY_WINDOW_SECONDS,
  });
  return true;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rate-limit.ts
git commit -m "feat(auth): add per-IP verify throttle for OTP reset"
```

---

### Task 3: `auth.ts` — new OTP helpers (TDD)

**Files:**
- Test: `tests/auth-reset-helper.test.ts` (rewrite — pure unit, no env)
- Modify: `src/lib/auth.ts` (add helpers near the existing reset section, ~line 55)

- [ ] **Step 1: Write the failing unit tests**

Replace the entire contents of `tests/auth-reset-helper.test.ts` with:

```ts
// Unit tests for the 6-digit OTP reset helpers. Pure — no stage env required.
import { describe, expect, it } from "bun:test";
import { generateOtpCode, hmacResetCode, timingSafeEqualHex } from "../src/lib/auth";

describe("generateOtpCode", () => {
  it("returns a 6-digit numeric string", () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateOtpCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("is not constant (covers a wide range)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(generateOtpCode());
    expect(seen.size).toBeGreaterThan(200);
  });
});

describe("hmacResetCode", () => {
  const secret = "test-secret-please-ignore-0123456789";

  it("is deterministic and returns 64-hex", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode(secret, "a@local", "123456");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is bound to the email (same code, different email → different mac)", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode(secret, "b@local", "123456");
    expect(a).not.toBe(b);
  });

  it("changes when the code changes", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode(secret, "a@local", "654321");
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode("a-different-secret-value", "a@local", "123456");
    expect(a).not.toBe(b);
  });

  it("normalizes email case and whitespace", async () => {
    const a = await hmacResetCode(secret, "  A@Local  ", "123456");
    const b = await hmacResetCode(secret, "a@local", "123456");
    expect(a).toBe(b);
  });
});

describe("timingSafeEqualHex", () => {
  it("true for equal strings", () => expect(timingSafeEqualHex("abcd", "abcd")).toBe(true));
  it("false for different same-length strings", () => expect(timingSafeEqualHex("abcd", "abce")).toBe(false));
  it("false for different lengths", () => expect(timingSafeEqualHex("ab", "abcd")).toBe(false));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/auth-reset-helper.test.ts`
Expected: FAIL — `generateOtpCode`/`hmacResetCode`/`timingSafeEqualHex` are not exported.

- [ ] **Step 3: Implement the helpers**

In `src/lib/auth.ts`, immediately after `generateResetToken` (ends ~line 55), add:

```ts
// 6-digit numeric OTP via CSPRNG with rejection sampling (avoids modulo bias). Range
// 000000–999999, left-padded. The plaintext code travels only inside the Telegram message; we
// store hmacResetCode(code), never the code itself.
export function generateOtpCode(): string {
  const LIMIT = 1_000_000;
  const MAX = Math.floor(0x100000000 / LIMIT) * LIMIT; // largest multiple of LIMIT ≤ 2^32
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= MAX);
  return String(n % LIMIT).padStart(6, "0");
}

// HMAC-SHA256(secret, "lower(trim(email)):code") → hex. Keyed with a server secret so a DB leak
// can't brute-reverse the low-entropy 6-digit code, and bound to the email so two users who draw
// the same code produce different stored values.
export async function hmacResetCode(secret: string, email: string, code: string): Promise<string> {
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign("HMAC", key, enc.encode(`${email.trim().toLowerCase()}:${code}`));
  return bytesToHex(new Uint8Array(mac));
}

// Constant-time compare of two equal-length hex strings (HMAC outputs). Length mismatch → false.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

(`subtle`, `enc`, and `bytesToHex` are already defined at the top of `auth.ts`. Do NOT remove `generateResetToken`/`sha256Hex` yet — endpoints and the old integration test still import them until Task 10.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/auth-reset-helper.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run build` → Expected: success.

```bash
git add src/lib/auth.ts tests/auth-reset-helper.test.ts
git commit -m "feat(auth): generateOtpCode, hmacResetCode, timingSafeEqualHex (TDD)"
```

---

### Task 4: Rewrite `request-reset.ts` — mint 6-digit code, store HMAC, push code

**Files:**
- Rewrite: `src/pages/api/admin/auth/request-reset.ts`
- Modify: `src/lib/telegram.ts:74-79` (comment only)

- [ ] **Step 1: Replace the endpoint**

Replace the entire contents of `src/pages/api/admin/auth/request-reset.ts` with:

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { generateOtpCode, hmacResetCode } from "../../../../lib/auth";
import { checkResetRequestRate } from "../../../../lib/rate-limit";
import { sendTelegramMessage } from "../../../../lib/telegram";

// 6-digit OTP forgot-password request endpoint (Telegram channel). Replaces the V6 link flow.
//
// Auth model: NO session (the user forgot their password). Defenses:
//   1. requireSameOrigin() — block cross-site POSTs.
//   2. checkResetRequestRate() — 3/hour/email throttle.
//   3. Enumeration consistency — ALWAYS respond 200 {ok:true} whether the email exists or the
//      rate limit tripped. Signals go to audit_log only, never to the client.
//
// Code handling: generateOtpCode() makes a 6-digit code; we store hmacResetCode(secret,email,code)
// (never the plaintext), set a 10-min TTL, and reset reset_attempts to 0. The Telegram push is
// fire-and-forget and is NOT awaited on the response path (awaiting it would make "email exists"
// measurably slower and leak existence via timing).
const RESET_TTL_MS = 10 * 60_000;

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();

  const ok = () => json({ ok: true });

  if (!email) {
    await audit("password_reset_failed", "<unknown>", { reason: "missing_email" });
    return ok();
  }

  if (!(await checkResetRequestRate(env, email))) {
    await audit("password_reset_failed", email, { reason: "rate_limited" });
    return ok();
  }

  const db = makeDb(env);
  const rows = await db
    .select({ email: admin_users.email })
    .from(admin_users)
    .where(eq(admin_users.email, email))
    .limit(1);
  const user = rows[0];

  if (!user) {
    await audit("password_reset_failed", email, { reason: "unknown_email" });
    return ok();
  }

  const code = generateOtpCode();
  const hash = await hmacResetCode(env.RESET_OTP_SECRET, email, code);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

  await db
    .update(admin_users)
    .set({ reset_token: hash, reset_token_expires_at: expiresAt, reset_attempts: 0 })
    .where(eq(admin_users.email, email));

  await audit("password_reset_requested", email, { email });

  const msg = [
    "🔐 後台密碼重設",
    `帳號:${email}`,
    `驗證碼:${code}`,
    "10 分鐘內有效,最多輸入 5 次。",
    "若非你本人申請,請忽略本訊息並通知管理員。",
  ].join("\n");

  // Fire-and-forget: do NOT await (timing-leak guard). sendTelegramMessage swallows its own errors.
  void sendTelegramMessage(env, msg);

  return ok();
};
```

- [ ] **Step 2: Tweak the telegram.ts comment**

In `src/lib/telegram.ts`, the `sendTelegramMessage` doc comment (lines 74-79) says "reset link". Replace the first comment line:

```ts
// V6 §5.6: generic Telegram push (forgot-password reset link, future alerts). Reuses the same
```

with:

```ts
// Generic Telegram push (forgot-password 6-digit OTP code, takeover alert, future alerts). Reuses the same
```

(Body unchanged.)

- [ ] **Step 3: Typecheck**

Run: `bun run build`
Expected: success. (`generateResetToken` is now unused by this file but still exported, so no error.)

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/admin/auth/request-reset.ts src/lib/telegram.ts
git commit -m "feat(auth): request-reset mints 6-digit OTP, pushes code not link"
```

---

### Task 5: Rewrite `reset-password.ts` — verify `{email,code}`, attempt-cap, reset

**Files:**
- Rewrite: `src/pages/api/admin/auth/reset-password.ts`

- [ ] **Step 1: Replace the endpoint**

Replace the entire contents of `src/pages/api/admin/auth/reset-password.ts` with:

```ts
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users, sessions } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { hashPassword, hmacResetCode, timingSafeEqualHex } from "../../../../lib/auth";
import { checkResetVerifyRate } from "../../../../lib/rate-limit";
import { sendTelegramMessage } from "../../../../lib/telegram";

// 6-digit OTP forgot-password completion endpoint. Replaces the V6 link flow.
//
// Auth model: NO session. Defenses = requireSameOrigin + per-IP verify throttle + possession of a
// valid, unexpired, not-attempt-exhausted code (matched by HMAC against the stored value). On
// success: rotate password, clear reset_token/expiry/attempts (single-use), wipe ALL sessions,
// audit, and push a takeover alert. We do NOT mint a session (the user wasn't logged in).
//
// Password policy mirrors change-password.ts: 12-char min, 200 max.

const MAX_ATTEMPTS = 5;
// Generic message reused for unknown email / no code / expired / exhausted / throttle — never
// distinguishes these states to the client (enumeration + brute-force signal safety).
const GENERIC_ERR = "驗證碼錯誤或已過期,請重新發送";

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkResetVerifyRate(env, ip))) {
    // Same generic 400 as a bad code — never 429 (a distinct status would itself be a signal).
    return text(GENERIC_ERR, 400);
  }

  let body: { email?: string; code?: string; new_password?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const code = String(body.code ?? "").trim();
  const next = String(body.new_password ?? "");

  const db = makeDb(env);
  const rows = await db
    .select({
      email: admin_users.email,
      reset_token: admin_users.reset_token,
      reset_token_expires_at: admin_users.reset_token_expires_at,
      reset_attempts: admin_users.reset_attempts,
    })
    .from(admin_users)
    .where(eq(admin_users.email, email))
    .limit(1);
  const user = rows[0];

  // Always compute a candidate HMAC (dummy inputs when the row/code is missing) so the response
  // time doesn't reveal whether the email exists.
  const candidate = await hmacResetCode(env.RESET_OTP_SECRET, email || "<none>", code || "<none>");

  if (!user || !user.reset_token || !user.reset_token_expires_at) {
    await audit("password_reset_failed", email, { reason: "no_active_code" });
    return text(GENERIC_ERR, 400);
  }

  const expired = new Date(user.reset_token_expires_at).getTime() < Date.now();
  if (expired || user.reset_attempts >= MAX_ATTEMPTS) {
    // Invalidate the dead/exhausted code so the row is clean for the next request.
    await env.DB
      .prepare("UPDATE admin_users SET reset_token = NULL, reset_token_expires_at = NULL WHERE email = ?")
      .bind(user.email)
      .run();
    await audit("password_reset_failed", user.email, {
      reason: expired ? "expired" : "attempts_exhausted",
    });
    return text(GENERIC_ERR, 400);
  }

  if (!timingSafeEqualHex(candidate, user.reset_token)) {
    const attempts = user.reset_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Final wrong try: increment AND invalidate the code in one statement.
      await env.DB
        .prepare(
          "UPDATE admin_users SET reset_attempts = reset_attempts + 1, reset_token = NULL, reset_token_expires_at = NULL WHERE email = ?",
        )
        .bind(user.email)
        .run();
    } else {
      await env.DB
        .prepare("UPDATE admin_users SET reset_attempts = reset_attempts + 1 WHERE email = ? AND reset_token IS NOT NULL")
        .bind(user.email)
        .run();
    }
    await audit("password_reset_failed", user.email, { reason: "bad_code", attempts });
    const remaining = Math.max(MAX_ATTEMPTS - attempts, 0);
    return text(`驗證碼錯誤,還剩 ${remaining} 次`, 400);
  }

  // Code correct → password policy. Do NOT consume the code on a policy failure (let the user fix
  // the password and retry the same code).
  if (next.length < 12) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too short (min 12)", 400);
  }
  if (next.length > 200) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too long", 400);
  }

  const newHash = await hashPassword(next);

  // Race-guarded completion: guard on reset_token so a concurrent second submit of the same code
  // changes 0 rows on the loser (token already cleared) — see FIX #11 lineage.
  const done = await env.DB
    .prepare(
      "UPDATE admin_users SET password_hash = ?, must_change_password = 0, reset_token = NULL, reset_token_expires_at = NULL, reset_attempts = 0 WHERE email = ? AND reset_token = ?",
    )
    .bind(newHash, user.email, user.reset_token)
    .run();

  if ((done.meta?.changes ?? 0) === 0) {
    await audit("password_reset_failed", user.email, { reason: "token_consumed_race" });
    return text(GENERIC_ERR, 400);
  }

  await db.delete(sessions).where(eq(sessions.user_email, user.email));
  await audit("password_reset_success", user.email, { email: user.email, rotated: true });

  // Takeover alert (sendTelegramMessage swallows its own errors).
  void sendTelegramMessage(
    env,
    ["⚠️ 後台密碼已被重設", `帳號:${user.email}`, "若不是你本人操作,請立即聯絡管理員並重新申請重設。"].join("\n"),
  );

  return json({ ok: true });
};
```

- [ ] **Step 2: Typecheck**

Run: `bun run build`
Expected: success. (`sha256Hex` is now unused by this file but still exported — no error yet.)

- [ ] **Step 3: Commit**

```bash
git add src/pages/api/admin/auth/reset-password.ts
git commit -m "feat(auth): reset-password verifies {email,code} with 5-attempt cap"
```

---

### Task 6: Rewrite `forgot-password.astro` — single-page two-state flow

**Files:**
- Rewrite: `src/pages/admin/forgot-password.astro`

- [ ] **Step 1: Replace the page**

Replace the entire contents of `src/pages/admin/forgot-password.astro` with:

```astro
---
import Layout from "../../layouts/Layout.astro";
// Logged-out reachable (middleware PUBLIC_ADMIN_PATHS). Single-page OTP reset: step 1 POSTs
// /api/admin/auth/request-reset (enumeration-consistent); step 2 POSTs /api/admin/auth/reset-password
// with {email, code, new_password}. The email stays in a JS variable across steps — never in the URL.
---

<Layout title="忘記密碼">
  <main class="mx-auto max-w-sm px-4 py-12">
    <h1 class="mb-2 text-2xl font-bold">忘記密碼</h1>

    <div id="msg" class="mb-4 hidden rounded px-3 py-2 text-sm"></div>

    <!-- Step 1: request a code -->
    <form id="request-form" class="space-y-4">
      <p class="text-sm text-gray-600">
        輸入你的後台電子信箱。若該帳號存在,系統會把 6 位數驗證碼推送到店家的 Telegram,10 分鐘內有效。
      </p>
      <div>
        <label for="email" class="block text-sm font-medium mb-1">電子信箱</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autocomplete="username"
          class="w-full rounded border border-gray-300 px-3 py-2 text-base"
        />
      </div>
      <button
        type="submit"
        class="w-full rounded bg-orange-600 px-4 py-3 text-base font-medium text-white hover:bg-orange-700"
      >
        發送驗證碼
      </button>
    </form>

    <!-- Step 2: enter code + new password (hidden until a code is requested) -->
    <form id="reset-form" class="hidden space-y-4">
      <p class="text-sm text-gray-600">
        驗證碼已發送到店家 Telegram(10 分鐘內有效,最多輸入 5 次)。請輸入驗證碼與新密碼。
      </p>
      <div>
        <label for="code" class="block text-sm font-medium mb-1">驗證碼(6 位數字)</label>
        <input
          id="code"
          name="code"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="6"
          required
          autocomplete="one-time-code"
          class="w-full rounded border border-gray-300 px-3 py-2 text-base tracking-[0.4em]"
        />
      </div>
      <div>
        <label for="new" class="block text-sm font-medium mb-1">新密碼(至少 12 字元)</label>
        <input
          id="new"
          name="new_password"
          type="password"
          required
          minlength="12"
          autocomplete="new-password"
          class="w-full rounded border border-gray-300 px-3 py-2 text-base"
        />
      </div>
      <div>
        <label for="confirm" class="block text-sm font-medium mb-1">再輸入一次新密碼</label>
        <input
          id="confirm"
          name="confirm_password"
          type="password"
          required
          minlength="12"
          autocomplete="new-password"
          class="w-full rounded border border-gray-300 px-3 py-2 text-base"
        />
      </div>
      <button
        type="submit"
        class="w-full rounded bg-orange-600 px-4 py-3 text-base font-medium text-white hover:bg-orange-700"
      >
        確認重設
      </button>
      <button
        type="button"
        id="resend"
        class="w-full rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
      >
        重新發送驗證碼
      </button>
    </form>

    <p class="mt-6 text-center text-sm">
      <a href="/admin/login" class="text-gray-600 underline">返回登入</a>
    </p>
  </main>

  <script>
    const requestForm = document.getElementById("request-form") as HTMLFormElement;
    const resetForm = document.getElementById("reset-form") as HTMLFormElement;
    const emailInput = document.getElementById("email") as HTMLInputElement;
    const msg = document.getElementById("msg") as HTMLDivElement;
    const resendBtn = document.getElementById("resend") as HTMLButtonElement;
    let email = "";

    function showMsg(textValue: string, kind: "ok" | "err") {
      msg.textContent = textValue;
      msg.className =
        "mb-4 rounded px-3 py-2 text-sm " +
        (kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700");
    }

    async function requestCode(addr: string): Promise<boolean> {
      try {
        const res = await fetch("/api/admin/auth/request-reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: addr }),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    requestForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const addr = emailInput.value.trim();
      if (!addr) {
        showMsg("請輸入電子信箱。", "err");
        return;
      }
      const ok = await requestCode(addr);
      if (!ok) {
        showMsg("發送失敗,請稍後再試。", "err");
        return;
      }
      email = addr;
      // Enumeration-consistent: same UI whether or not the account exists.
      showMsg("若該帳號存在,驗證碼已發送到店家 Telegram(10 分鐘內有效)。", "ok");
      requestForm.classList.add("hidden");
      resetForm.classList.remove("hidden");
      (document.getElementById("code") as HTMLInputElement).focus();
    });

    resendBtn.addEventListener("click", async () => {
      if (!email) return;
      resendBtn.disabled = true;
      const ok = await requestCode(email);
      showMsg(ok ? "已重新發送驗證碼,請查收 Telegram。" : "發送失敗,請稍後再試。", ok ? "ok" : "err");
      setTimeout(() => (resendBtn.disabled = false), 3000);
    });

    resetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(resetForm);
      const code = String(fd.get("code") ?? "").trim();
      const nw = String(fd.get("new_password") ?? "");
      const cf = String(fd.get("confirm_password") ?? "");
      if (!/^[0-9]{6}$/.test(code)) {
        showMsg("驗證碼為 6 位數字。", "err");
        return;
      }
      if (nw !== cf) {
        showMsg("兩次新密碼不一致。", "err");
        return;
      }
      if (nw.length < 12) {
        showMsg("新密碼至少 12 個字。", "err");
        return;
      }
      try {
        const res = await fetch("/api/admin/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code, new_password: nw }),
        });
        if (res.ok) {
          showMsg("密碼已重設,2 秒後前往登入⋯", "ok");
          (resetForm.querySelector("button[type=submit]") as HTMLButtonElement).disabled = true;
          setTimeout(() => (location.href = "/admin/login"), 2000);
        } else {
          showMsg("重設失敗:" + (await res.text()), "err");
        }
      } catch {
        showMsg("重設失敗,請稍後再試。", "err");
      }
    });
  </script>
</Layout>
```

- [ ] **Step 2: Typecheck**

Run: `bun run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/pages/admin/forgot-password.astro
git commit -m "feat(auth): single-page OTP forgot-password flow"
```

---

### Task 7: Remove `/admin/reset-password` page + public path

**Files:**
- Delete: `src/pages/admin/reset-password.astro`
- Modify: `src/middleware.ts:36-40`

- [ ] **Step 1: Delete the page**

```bash
git rm src/pages/admin/reset-password.astro
```

- [ ] **Step 2: Drop it from `PUBLIC_ADMIN_PATHS`**

In `src/middleware.ts`, change the set (currently lines 36-40) to remove the `reset-password` entry:

```ts
  const PUBLIC_ADMIN_PATHS = new Set([
    "/admin/login",
    "/admin/forgot-password",
  ]);
```

- [ ] **Step 3: Typecheck**

Run: `bun run build`
Expected: success (nothing imports the deleted page; `login.astro` links to `forgot-password`, not `reset-password`).

- [ ] **Step 4: Commit**

```bash
git add src/middleware.ts
git commit -m "feat(auth): remove /admin/reset-password (folded into single-page flow)"
```

---

### Task 8: Update test helpers in `_setup.ts`

**Files:**
- Modify: `tests/_setup.ts` (reset helpers at lines 353, 372-396, 427-465)

- [ ] **Step 1: Import `hmacResetCode` alongside `hashPassword`**

In `tests/_setup.ts`, change the import at line 353:

```ts
import { hashPassword } from "../src/lib/auth";
```

to:

```ts
import { hashPassword, hmacResetCode } from "../src/lib/auth";
```

- [ ] **Step 2: Add the test-secret + HMAC helper**

Immediately after that import line, add:

```ts
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
```

- [ ] **Step 3: Add `reset_attempts` to `getResetTokenRow`**

Replace `getResetTokenRow` (lines 372-382) with:

```ts
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
```

- [ ] **Step 4: Add an `attempts` parameter to `setResetToken`**

Replace `setResetToken` (lines 384-396) with:

```ts
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
```

- [ ] **Step 5: Extend `clearResetRateLimit` to also wipe the verify-limit keys**

Replace `clearResetRateLimit` (lines 427-465) with a version that clears BOTH prefixes:

```ts
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
```

- [ ] **Step 6: Typecheck**

Run: `bun run build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add tests/_setup.ts
git commit -m "test(auth): _setup helpers for OTP reset (attempts, HMAC, verify-limit cleanup)"
```

---

### Task 9: Rewrite `password-reset.test.ts` — integration tests for the OTP flow

**Files:**
- Rewrite: `tests/password-reset.test.ts`

> These hit the deployed stage worker. The reset-submit cases inject a known code's HMAC, so they
> require `TEST_RESET_OTP_SECRET` to equal stage's `RESET_OTP_SECRET` (skip otherwise). They will
> stay skipped/red locally until Task 11 deploys the secret + migration to stage — that's expected;
> Task 11 runs them green.

- [ ] **Step 1: Replace the whole test file**

Replace the entire contents of `tests/password-reset.test.ts` with:

```ts
// 6-digit OTP forgot-password — stage integration.
//
// request-reset: enumeration-consistent response, 3/hr/email rate limit, HMAC persisted, 10-min TTL.
// reset-password: per-IP throttle, attempt cap, HMAC verify, single-use, session wipe.
//
// NOTE: request-reset pushes Telegram for existing emails. On stage the TELEGRAM_* secrets point at
// a throwaway chat (or are unset). The push is fire-and-forget, so the HTTP response + DB writes are
// deterministic regardless of delivery; these tests assert ONLY response + DB state + audit.
//
// Reset-submit cases inject a known code's HMAC via setResetToken, so they require
// TEST_RESET_OTP_SECRET === stage RESET_OTP_SECRET (skipIfNoResetSecret()).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  clearResetRateLimit,
  getResetTokenRow,
  getAdminPasswordHash,
  countSessions,
  seedSessionFor,
  setResetToken,
  seedAdminUser,
  resetCodeHmac,
  skipIfNoIntegration,
  skipIfNoResetSecret,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SKIP_SECRET = skipIfNoResetSecret();
const ADMIN_EMAIL = "test-reset-admin@local";
const UNKNOWN_EMAIL = "test-reset-nobody@local";
const GOOD_CODE = "246802";
const WRONG_CODE = "000000";

beforeEach(async () => {
  if (SKIP) return;
  cleanupTestAdmin();
  cleanupTestData();
  clearResetRateLimit();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestAdmin();
  cleanupTestData();
  clearResetRateLimit();
});

async function requestReset(email: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/auth/request-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: STAGE_URL, ...extraHeaders },
    body: JSON.stringify({ email }),
  });
}

async function submitReset(email: string, code: string, newPassword: string): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: STAGE_URL },
    body: JSON.stringify({ email, code, new_password: newPassword }),
  });
}

describe("OTP request-reset: enumeration consistency + persistence", () => {
  it("returns identical 200 {ok:true} for existing AND unknown email", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    const rExisting = await requestReset(ADMIN_EMAIL);
    const rUnknown = await requestReset(UNKNOWN_EMAIL);
    expect(rExisting.status).toBe(200);
    expect(rUnknown.status).toBe(200);
    expect(await rExisting.json()).toEqual({ ok: true });
    expect(await rUnknown.json()).toEqual({ ok: true });
  });

  it("persists an HMAC (64-hex, not plaintext), a ~10-min expiry, and resets attempts to 0", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    // Pre-dirty the attempt counter to prove request-reset resets it.
    setResetToken(ADMIN_EMAIL, "deadbeef".repeat(8), new Date(Date.now() + 60_000).toISOString(), 3);

    const r = await requestReset(ADMIN_EMAIL);
    expect(r.status).toBe(200);

    const after = getResetTokenRow(ADMIN_EMAIL);
    expect(after.reset_token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.reset_attempts).toBe(0);
    expect(after.reset_token_expires_at).not.toBeNull();
    const ttlMs = new Date(after.reset_token_expires_at!).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(5 * 60_000);
    expect(ttlMs).toBeLessThan(15 * 60_000);
  });

  it("rejects cross-origin POST with 403 and sets no code", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    const r = await fetch(`${STAGE_URL}/api/admin/auth/request-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
      body: JSON.stringify({ email: ADMIN_EMAIL }),
    });
    expect(r.status).toBe(403);
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBeNull();
  });

  it("4th request within the window still returns 200 (never 429 — enumeration-safe)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    for (let i = 0; i < 3; i++) expect((await requestReset(ADMIN_EMAIL)).status).toBe(200);
    const r4 = await requestReset(ADMIN_EMAIL);
    expect(r4.status).toBe(200);
    expect(await r4.json()).toEqual({ ok: true });
  });
});

describe("OTP reset-password: validation", () => {
  it("rejects when there is no active code (400)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "brand-new-password-9");
    expect(r.status).toBe(400);
  });

  it("rejects an EXPIRED code and leaves the password unchanged", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() - 60_000).toISOString(), 0);

    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "brand-new-password-9");
    expect(r.status).toBe(400);
    expect(getAdminPasswordHash(ADMIN_EMAIL)).toBe(hashBefore);
  });

  it("rejects a too-short new password (correct code, 400) WITHOUT consuming the code", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "short");
    expect(r.status).toBe(400);
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBe(hmac);
  });

  it("invalidates the code after 5 wrong attempts (correct code then fails)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    for (let i = 0; i < 5; i++) {
      expect((await submitReset(ADMIN_EMAIL, WRONG_CODE, "a-fresh-strong-password")).status).toBe(400);
    }
    // Code now cleared; even the correct code fails.
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBeNull();
    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, "a-fresh-strong-password")).status).toBe(400);
  });
});

describe("OTP reset-password: successful reset", () => {
  it("changes password, clears code+attempts, wipes sessions", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);
    seedSessionFor(ADMIN_EMAIL);
    seedSessionFor(ADMIN_EMAIL);
    expect(countSessions(ADMIN_EMAIL)).toBe(2);

    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "a-fresh-strong-password");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    expect(getAdminPasswordHash(ADMIN_EMAIL)).not.toBe(hashBefore);
    const row = getResetTokenRow(ADMIN_EMAIL);
    expect(row.reset_token).toBeNull();
    expect(row.reset_token_expires_at).toBeNull();
    expect(row.reset_attempts).toBe(0);
    expect(countSessions(ADMIN_EMAIL)).toBe(0);
  });

  it("a consumed code cannot be reused (second submit fails 400)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, "first-new-password-12")).status).toBe(200);
    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, "second-new-password-12")).status).toBe(400);
  });

  it("the new password works at /admin/login (end-to-end)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    const newPw = "login-after-reset-pw";
    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, newPw)).status).toBe(200);

    const form = new URLSearchParams();
    form.set("email", ADMIN_EMAIL);
    form.set("password", newPw);
    const login = await fetch(`${STAGE_URL}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: STAGE_URL },
      body: form.toString(),
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("set-cookie") ?? "").toContain("mh_session=");
  });
});
```

- [ ] **Step 2: Typecheck**

Run: `bun run build`
Expected: success. (The old `import { sha256Hex, generateResetToken }` is gone; nothing else imports them now.)

- [ ] **Step 3: Run the unit suite (integration cases skip locally)**

Run: `bun test tests/auth-reset-helper.test.ts`
Expected: PASS. (Full `bun test` will show the reset integration cases skipped without stage env — that's fine; they run in Task 11.)

- [ ] **Step 4: Commit**

```bash
git add tests/password-reset.test.ts
git commit -m "test(auth): rewrite reset integration tests for OTP flow"
```

---

### Task 10: Remove the dead link-flow helpers from `auth.ts`

**Files:**
- Modify: `src/lib/auth.ts:37-55` (remove `sha256Hex` + `generateResetToken`)

- [ ] **Step 1: Confirm nothing imports them**

Run: `grep -rn "generateResetToken\|sha256Hex" src tests`
Expected: NO matches (request-reset → `generateOtpCode`/`hmacResetCode`; reset-password → `hmacResetCode`; tests rewritten). If any match remains, stop and update that caller first.

- [ ] **Step 2: Delete the two helpers**

In `src/lib/auth.ts`, remove the `--- V6 forgot-password reset-token helpers ---` comment block and both functions (the `sha256Hex` export, ~lines 37-46, and the `generateResetToken` export, ~lines 48-55). Keep `bytesToHex`, `pbkdf2`, `hashPassword`, `verifyPassword`, session helpers, AND the new `generateOtpCode`/`hmacResetCode`/`timingSafeEqualHex`.

- [ ] **Step 3: Typecheck + unit tests**

Run: `bun run build && bun test tests/auth-reset-helper.test.ts`
Expected: build success; helper tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth.ts
git commit -m "refactor(auth): drop dead link-flow helpers (generateResetToken, sha256Hex)"
```

---

### Task 11: Stage rollout — secret, migration, deploy, integration verification

**Files:**
- Modify: `tests/migration-idempotency.test.ts` (add `reset_attempts` re-ALTER case)

> Requires: `wrangler login` done (or `CLOUDFLARE_API_TOKEN`), and `.env.local`'s active
> `PUBLIC_ORDER_TOKEN` line equal to STAGE's `ORDER_TOKEN` (see CLAUDE.md deploy trap).

- [ ] **Step 1: Generate a secret value and set it on stage**

```bash
openssl rand -hex 32   # copy the output
bunx wrangler secret put RESET_OTP_SECRET --env stage   # paste it when prompted
```

- [ ] **Step 2: Apply the migration to stage**

Run: `bun run db:migrate:stage`
Expected: the `0008_*` migration applies (adds `reset_attempts`, drops `admin_users_reset_token_unique`).

- [ ] **Step 3: Add the idempotency case for the new column**

In `tests/migration-idempotency.test.ts`, inside the `describe("V5.2 migration idempotency", ...)` block, append:

```ts
  it("reset_attempts ALTER re-run returns duplicate-column (migration runner skips applied)", async () => {
    if (SKIP) return;
    let threw = false;
    try {
      d1Execute(`ALTER TABLE admin_users ADD COLUMN reset_attempts integer DEFAULT 0 NOT NULL`);
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(/duplicate|already exists/i.test(msg)).toBe(true);
    }
    expect(threw).toBe(true);
  });
```

- [ ] **Step 4: Deploy the main worker to stage**

Run: `bun run deploy:stage`
Expected: clean build + `wrangler deploy` succeeds; the deploy script does not abort on the `PUBLIC_ORDER_TOKEN` guard.

- [ ] **Step 5: Run the full test suite against stage**

```bash
export MANGO_STAGE_URL=https://mango-hsu-stage.rhsu.workers.dev
export TEST_TOKEN=<stage ORDER_TOKEN>
export TEST_RESET_OTP_SECRET=<the value from Step 1>
bun test
```

Expected: ALL green — `auth-reset-helper` (unit), `password-reset` (OTP integration incl. the 5-attempt-cap and success cases), `migration-idempotency` (incl. the new `reset_attempts` case), and the existing suites.

- [ ] **Step 6: Manual smoke on stage**

Create a throwaway stage admin (standing approval per project memory), then: `/admin/forgot-password` → enter its email → confirm a 6-digit code arrives on the stage Telegram → enter code + new password → land on `/admin/login` → log in with the new password → confirm the "⚠️ 後台密碼已被重設" alert arrived. Delete the throwaway admin.

- [ ] **Step 7: Commit the idempotency test**

```bash
git add tests/migration-idempotency.test.ts
git commit -m "test(migration): idempotency case for reset_attempts column"
```

---

### Task 12: Production rollout

> Requires: `.env.local`'s active `PUBLIC_ORDER_TOKEN` swapped to PROD's `ORDER_TOKEN` before
> `deploy:prod` (Vite bakes it at build time — CLAUDE.md prod incident 2026-06-05).

- [ ] **Step 1: Set the secret on prod**

```bash
openssl rand -hex 32   # a fresh value (prod need NOT match stage)
bunx wrangler secret put RESET_OTP_SECRET --env prod
```

- [ ] **Step 2: Apply the migration to prod**

Run: `bun run db:migrate:prod`
Expected: `0008_*` applies on the prod D1.

- [ ] **Step 3: Deploy the main worker to prod**

Swap `.env.local` to the prod `PUBLIC_ORDER_TOKEN`, then run: `bun run deploy:prod`
Expected: clean build + deploy succeeds.

- [ ] **Step 4: Production smoke test**

On prod: `/admin/forgot-password` → enter the real owner email → 6-digit code arrives on the store Telegram → enter code + new password → log in with the new password → confirm the takeover alert. (Cron worker untouched — it does not read `RESET_OTP_SECRET`.)

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feature/otp-password-reset
gh pr create --title "feat(auth): 6-digit OTP password reset (replaces V6 link flow)" \
  --body "Replaces the Telegram link-based forgot-password with a single-page 6-digit OTP: HMAC-stored code bound to email, 5-attempt cap + per-IP verify throttle, 10-min TTL. Removes /admin/reset-password. Spec + plan in docs/superpowers/. Stage verified green; prod migration + secret applied."
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §3 single-page flow | Task 6 |
| §4 attempt cap 5 | Task 5 (MAX_ATTEMPTS) |
| §4 10-min TTL | Task 4 (RESET_TTL_MS) |
| §4 request 3/hr/email (reuse) | Task 4 (unchanged `checkResetRequestRate`) |
| §4 verify 10/15min/IP | Task 2 + Task 5 |
| §4 HMAC bound to email | Task 3 (`hmacResetCode`) |
| §4 single-use / clear on cap | Task 5 |
| §4 enumeration consistency + dummy HMAC | Task 4 + Task 5 |
| §4 wipe sessions + takeover alert | Task 5 |
| §5 `reset_attempts` + drop unique index | Task 1 |
| §6.1 request-reset rewrite | Task 4 |
| §6.2 reset-password rewrite | Task 5 |
| §7 lib helpers | Tasks 2, 3 |
| §7.3 `AppEnv` secret | Task 1 |
| §8 remove reset-password page + middleware | Task 7 |
| §9 Telegram copy | Task 4 (code) + Task 5 (alert) |
| §10 tests | Tasks 3, 8, 9, 11 |
| §11 deploy steps | Tasks 11, 12 |

No gaps.

**2. Placeholder scan:** No "TBD/TODO"; every code step shows full code; commands have expected output. Pass.

**3. Type consistency:** `generateOtpCode(): string`, `hmacResetCode(secret,email,code): Promise<string>`, `timingSafeEqualHex(a,b): boolean`, `checkResetVerifyRate(env,ip): Promise<boolean>` — used identically in request-reset (Task 4), reset-password (Task 5), and `_setup`/tests (Tasks 8, 9). `setResetToken(email,hash,exp,attempts=0)` and `getResetTokenRow → {reset_token, reset_token_expires_at, reset_attempts}` consistent across Tasks 8/9. Body shape `{email,code,new_password}` consistent between Task 5 endpoint, Task 6 page, and Task 9 tests. Pass.

---

## Notes / risks

- **TEST_RESET_OTP_SECRET coupling:** the reset-submit integration cases only pass when the test env's secret equals stage's. If they skip in CI, check `TEST_RESET_OTP_SECRET` is exported (Task 11 Step 5).
- **Drizzle DROP INDEX:** if `bun run db:generate` omits the index drop, hand-append it (Task 1 Step 5) — verified by the migration applying cleanly on stage (Task 11 Step 2).
- **Shared-Telegram threat model:** unchanged from V6 — anyone with store-chat access sees the code; the takeover alert is the compensating control (spec §4 note).
