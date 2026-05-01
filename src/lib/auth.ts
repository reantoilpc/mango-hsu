import { eq } from "drizzle-orm";
import { admin_users, sessions } from "../db/schema";
import type { AppEnv, Db } from "../db/client";

// PBKDF2 iters: pin AFTER Saturday spike (see scripts/measure-pbkdf2.ts).
// Candidates: 30k / 100k / 600k. Pick the highest that stays under ~8ms CPU on
// Workers free tier 10ms/req. Stored format: pbkdf2$<iters>$<base64-salt>$<base64-hash>
const DEFAULT_ITERS = 30_000;
const SALT_LEN = 16;
const HASH_LEN = 32; // 256 bits
const SESSION_TTL_DAYS = 7;

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(
  plaintext: string,
  salt: Uint8Array,
  iters: number,
): Promise<Uint8Array> {
  const key = await subtle.importKey(
    "raw",
    enc.encode(plaintext),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iters },
    key,
    HASH_LEN * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(plaintext: string, iters = DEFAULT_ITERS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hash = await pbkdf2(plaintext, salt, iters);
  return `pbkdf2$${iters}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = parseInt(parts[1]!, 10);
  if (!Number.isFinite(iters) || iters < 1000) return false;
  const salt = base64ToBytes(parts[2]!);
  const expected = base64ToBytes(parts[3]!);
  const actual = await pbkdf2(plaintext, salt, iters);
  if (actual.length !== expected.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export async function createSession(
  db: Db,
  email: string,
): Promise<{ token: string; expiresAt: string }> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(tokenBytes);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  await db.insert(sessions).values({ token, user_email: email, expires_at: expiresAt });
  return { token, expiresAt };
}

export type SessionInfo = { email: string; role: "admin" | "operator" };

export async function verifySession(db: Db, token: string): Promise<SessionInfo | null> {
  const rows = await db
    .select({
      token: sessions.token,
      expires_at: sessions.expires_at,
      email: admin_users.email,
      role: admin_users.role,
    })
    .from(sessions)
    .innerJoin(admin_users, eq(admin_users.email, sessions.user_email))
    .where(eq(sessions.token, token))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return null;
  }
  return { email: row.email, role: row.role };
}

export async function rotateSession(
  db: Db,
  oldToken: string,
): Promise<{ token: string; expiresAt: string } | null> {
  const session = await verifySession(db, oldToken);
  if (!session) return null;
  await db.delete(sessions).where(eq(sessions.token, oldToken));
  return createSession(db, session.email);
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

export const SESSION_COOKIE = "mh_session";

export function buildSessionCookie(token: string, expiresAt: string): string {
  const expires = new Date(expiresAt).toUTCString();
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Expires=${expires}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// Helper for skill-required env propagation
export type _AppEnvForAuth = AppEnv;
