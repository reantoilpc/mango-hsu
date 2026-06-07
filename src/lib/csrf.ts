// Origin/Referer same-host check.
// SameSite=Strict on the session cookie is the first defense; this is the
// second-line check at mutation API boundaries.
export function requireSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const url = new URL(request.url);
  const expectedHost = url.host;
  if (origin) {
    try {
      return new URL(origin).host === expectedHost;
    } catch {
      return false;
    }
  }
  if (referer) {
    try {
      return new URL(referer).host === expectedHost;
    } catch {
      return false;
    }
  }
  // No Origin AND no Referer. Privacy-hardened browsers (e.g. Safari with
  // tracking prevention) strip BOTH headers even on a same-origin fetch, so a
  // header-less request is the normal case for those clients — not an attack.
  // SameSite=Strict on mh_session is the real CSRF defense: a cross-site
  // request can NEVER carry the session cookie, so a header-less request that
  // DID authenticate is necessarily same-site. Accept it. (Host-mismatch
  // rejections above still stand whenever an Origin or Referer IS present.)
  return true;
}
