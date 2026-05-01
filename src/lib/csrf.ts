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
  // No Origin and no Referer: most modern browsers send at least one for
  // same-origin POST. Reject conservatively.
  return false;
}
