// Deploy-time guard helper for the customer-facing PUBLIC_ORDER_TOKEN.
//
// Extracted from deploy.mjs so the validation is pure and unit-testable
// (tests/deploy-token-guard.test.ts). See that file for the 2026-06-05 incident
// this guards against: a build with no PUBLIC_ORDER_TOKEN bakes "" into the client
// bundle (import.meta.env.PUBLIC_ORDER_TOKEN ?? ""), every order POSTs token:"",
// and the server rejects with INVALID_TOKEN.
//
// deploy.mjs resolves the value Vite ACTUALLY inlines via vite's loadEnv (which
// reads the whole .env cascade — .env, .env.local, .env.[mode] — plus process.env,
// and strips quotes, exactly as the build did) and passes the result here. This
// helper only decides whether that resolved value is usable.

export const ORDER_TOKEN_PLACEHOLDER = "REPLACE_AT_BUILD_TIME";

// Validate the token Vite resolved for the build. Returns the trimmed token when
// it is a non-empty, non-placeholder string; otherwise null — and a null result
// means the build would bake an empty/unusable token, so the deploy MUST abort
// before every customer order starts failing with INVALID_TOKEN.
export function validateOrderToken(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === ORDER_TOKEN_PLACEHOLDER) return null;
  return trimmed;
}
