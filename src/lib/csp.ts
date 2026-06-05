// Content-Security-Policy applied to all HTML responses (wired up in
// src/middleware.ts). Kept in its own module — with no `astro:middleware`
// import — so it can be unit-tested in plain bun (tests/csp.test.ts).
//
// The LIFF bind flow (src/pages/liff/bind.astro) needs BOTH LINE domains:
//   - script-src  https://static.line-scdn.net  → load the LIFF SDK
//   - connect-src https://api.line.me            → the SDK's runtime calls
//       (liff.init → GET /liff/v2/apps/<id>/contextToken; getProfile → /v2/profile)
// The 2026-05-03 hardening (c7c837e) added the script-src domain but omitted the
// connect-src one, so liff.init was blocked ("violates connect-src 'self'") and
// binding silently broke. The regression test guards both — do not drop either.
export const CSP =
  "default-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; " +
  "script-src 'self' 'unsafe-inline' https://static.line-scdn.net; " +
  "connect-src 'self' https://api.line.me; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self';";
