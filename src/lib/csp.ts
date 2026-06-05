// Content-Security-Policy applied to all HTML responses (wired up in
// src/middleware.ts). Kept in its own module — with no `astro:middleware`
// import — so it can be unit-tested in plain bun (tests/csp.test.ts).
//
// The LIFF bind flow (src/pages/liff/bind.astro) needs these LINE origins:
//   - script-src  https://static.line-scdn.net   → load the LIFF SDK
//   - connect-src https://api.line.me             → liff.init contextToken, getProfile
//   - connect-src https://*.line-scdn.net         → SDK fetches liffsdk.line-scdn.net/xlt/manifest.json
// The 2026-05-03 hardening (c7c837e) added the script-src domain but NO connect-src
// LINE origins, so liff.init was CSP-blocked ("violates connect-src 'self'") and
// binding silently broke. Live QA on 2026-06-05 confirmed the SDK needs BOTH
// api.line.me and a *.line-scdn.net subdomain. The regression test guards them.
export const CSP =
  "default-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; " +
  "script-src 'self' 'unsafe-inline' https://static.line-scdn.net; " +
  "connect-src 'self' https://api.line.me https://*.line-scdn.net; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self';";
