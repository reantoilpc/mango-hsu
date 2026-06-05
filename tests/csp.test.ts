// Regression test for the LIFF-binding CSP.
//
// The 2026-05-03 security hardening (c7c837e) let the LIFF SDK LOAD
// (script-src https://static.line-scdn.net) but forgot to let it CONNECT
// (connect-src https://api.line.me). So liff.init()'s call to
// api.line.me/liff/v2/apps/<id>/contextToken was blocked by CSP and LINE
// shipment-notification binding silently broke. These asserts fail if either
// LINE domain is dropped again. Pure unit test — no env / network.

import { describe, expect, it } from "bun:test";
import { CSP } from "../src/lib/csp";

// Split "directive a b c; directive2 d e" into { directive: [a,b,c], ... }.
function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...values] = tokens;
    out[name!] = values;
  }
  return out;
}

describe("CSP", () => {
  const d = directives(CSP);

  it("lets the LIFF SDK load (script-src static.line-scdn.net)", () => {
    expect(d["script-src"]).toContain("https://static.line-scdn.net");
  });

  it("lets the LIFF SDK reach LINE at runtime (connect-src api.line.me)", () => {
    // liff.init → contextToken and getProfile → /v2/profile both hit api.line.me.
    expect(d["connect-src"]).toContain("https://api.line.me");
  });

  it("still allows same-origin connect for /api/liff/bind", () => {
    expect(d["connect-src"]).toContain("'self'");
  });
});
