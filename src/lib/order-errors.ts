export function isUniqueOnIdempotency(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE/i.test(msg) && /idempotency_key/i.test(msg);
}

export function isUniqueOnOrderId(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE/i.test(msg) && (/order_id/i.test(msg) || /PRIMARY/i.test(msg));
}
