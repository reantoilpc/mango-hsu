// Pure unit tests for the deploy-time PUBLIC_ORDER_TOKEN guard.
// No D1 / network / env required — these run anywhere bun is installed.
//
// Regression for the 2026-06-05 prod incident: a deploy whose build had no
// PUBLIC_ORDER_TOKEN baked import.meta.env.PUBLIC_ORDER_TOKEN ?? "" → "" into the
// client bundle, so every customer order POSTed token:"" and the server rejected
// it with INVALID_TOKEN ("驗證失敗，請重新整理頁面再試。").
//
// deploy.mjs resolves the token Vite ACTUALLY bakes via vite's loadEnv (reads the
// whole .env cascade + process.env, strips quotes — the source of truth, no drift),
// then calls validateOrderToken() on the result. This file locks that validator:
// a build with no usable token must yield null so the deploy hard-aborts before
// `wrangler deploy`.

import { describe, expect, it } from "bun:test";
import { validateOrderToken } from "../scripts/order-token-guard.mjs";

describe("validateOrderToken", () => {
  it("returns a real token unchanged", () => {
    expect(validateOrderToken("6debd1c4da83256a4c67d37f9adfd7a3")).toBe(
      "6debd1c4da83256a4c67d37f9adfd7a3",
    );
  });

  it("returns null for an empty string (the 2026-06-05 case)", () => {
    expect(validateOrderToken("")).toBeNull();
  });

  it("returns null for a whitespace-only value", () => {
    expect(validateOrderToken("   ")).toBeNull();
  });

  it("returns null for undefined (loadEnv key absent)", () => {
    expect(validateOrderToken(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(validateOrderToken(null)).toBeNull();
  });

  it("returns null for the build-time placeholder", () => {
    expect(validateOrderToken("REPLACE_AT_BUILD_TIME")).toBeNull();
  });

  it("trims surrounding whitespace from an otherwise valid token", () => {
    expect(validateOrderToken("  abc123def456  ")).toBe("abc123def456");
  });

  it("returns null for a non-string input", () => {
    expect(validateOrderToken(12345 as unknown as string)).toBeNull();
  });
});
