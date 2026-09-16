// src/db/adminAuth.ts
// Admin sessions: separate from creator_sessions. Reuses password hashing helpers.

import type { Env } from "../env";
import { hashPassword, verifyPassword } from "./passwordAuth";

/**
 * Shared low-level helpers (mirrors passwordAuth.ts pattern).
 */

function nowIso(): string {
  return new Date().toISOString();
}

function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  crypto.getRandomValues(buf);
  return buf;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const arr = Array.from(new Uint8Array(hashBuf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSessionToken(): string {
  return toBase64Url(randomBytes(32));
}

export type AdminSession = {
  adminId: number;
  username: string;
};

/**
 * Create an admin session and return the raw bearer token.
 * The hash is what's stored in admin_sessions — the raw token is what the client sends.
 */
export async function createAdminSession(
  env: Env,
  adminId: number,
  username: string,
  ttlDays = 14,
): Promise<string> {
  const rawToken = randomSessionToken();
  const tokenHash = await sha256hex(rawToken);
  const now = nowIso();
  const expiresAt = new Date(
    Date.now() + ttlDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  await env.kuntips_db
    .prepare(
      `
      INSERT INTO admin_sessions (admin_id, username, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .bind(adminId, username, tokenHash, now, expiresAt)
    .run();

  return rawToken;
}

/**
 * Look up an admin session by raw bearer token.
 * Returns null if token is invalid or expired.
 */
export async function getAdminSessionByToken(
  env: Env,
  rawToken: string,
): Promise<AdminSession | null> {
  const tokenHash = await sha256hex(rawToken);
  const now = nowIso();

  const row = (await env.kuntips_db
    .prepare(
      `
      SELECT admin_id, username, expires_at
      FROM admin_sessions
      WHERE token_hash = ?
      LIMIT 1
    `,
    )
    .bind(tokenHash)
    .first()) as
    | { admin_id: number; username: string; expires_at: string }
    | null;

  if (!row) return null;
  if (row.expires_at <= now) return null;

  // Touch last_used_at (non-critical, fire-and-forget effect)
  await env.kuntips_db
    .prepare(
      `
      UPDATE admin_sessions
      SET last_used_at = ?
      WHERE token_hash = ?
    `,
    )
    .bind(now, tokenHash)
    .run();

  return {
    adminId: row.admin_id,
    username: row.username,
  };
}

/**
 * Delete a session (used for logout).
 */
export async function deleteAdminSession(
  env: Env,
  rawToken: string,
): Promise<void> {
  const tokenHash = await sha256hex(rawToken);
  await env.kuntips_db
    .prepare(`DELETE FROM admin_sessions WHERE token_hash = ?`)
    .bind(tokenHash)
    .run();
}

/**
 * Parse Authorization header and return the raw bearer token, or null.
 */
export function bearerTokenFromRequest(request: Request): string | null {
  const auth =
    request.headers.get("Authorization") ??
    request.headers.get("authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token.trim();
}

/**
 * Get admin session from request (Bearer token). Null if missing/invalid/expired.
 */
export async function getAdminSessionFromRequest(
  env: Env,
  request: Request,
): Promise<AdminSession | null> {
  const token = bearerTokenFromRequest(request);
  if (!token) return null;
  return getAdminSessionByToken(env, token);
}

/**
 * Dual-auth check: returns true if the request has EITHER a valid admin session
 * OR the Bearer token matches ADMIN_SECRET (CLI/emergency use).
 * Used by existing admin endpoints and new admin data endpoints.
 */
export async function isAdminAuthed(
  env: Env,
  request: Request,
): Promise<boolean> {
  const token = bearerTokenFromRequest(request);
  if (!token) return false;

  // Try ADMIN_SECRET first (fast path — no DB hit)
  if (env.ADMIN_SECRET && token === env.ADMIN_SECRET) {
    return true;
  }

  // Fall back to admin session lookup
  const session = await getAdminSessionByToken(env, token);
  return !!session;
}

/**
 * Look up an admin user by username.
 */
export async function getAdminByUsername(
  env: Env,
  username: string,
): Promise<{
  id: number;
  username: string;
  passwordHash: string;
  passwordSalt: string;
} | null> {
  const row = (await env.kuntips_db
    .prepare(
      `SELECT id, username, password_hash, password_salt FROM admin_users WHERE username = ? LIMIT 1`,
    )
    .bind(username)
    .first()) as
    | {
        id: number;
        username: string;
        password_hash: string;
        password_salt: string;
      }
    | null;

  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
  };
}

/**
 * Count admin users. Used by bootstrap endpoint.
 */
export async function countAdminUsers(env: Env): Promise<number> {
  const row = (await env.kuntips_db
    .prepare(`SELECT COUNT(*) AS cnt FROM admin_users`)
    .first()) as { cnt: number } | null;
  return Number(row?.cnt ?? 0);
}

/**
 * Insert a new admin user. Returns the new id.
 */
export async function createAdminUser(
  env: Env,
  username: string,
  password: string,
): Promise<number> {
  const { hash, salt } = await hashPassword(password);
  const inserted = (await env.kuntips_db
    .prepare(
      `
      INSERT INTO admin_users (username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, datetime('now'))
      RETURNING id
    `,
    )
    .bind(username, hash, salt)
    .first()) as { id: number } | null;

  return Number(inserted?.id ?? 0);
}

/**
 * Record last_login_at on the admin_users row.
 */
export async function touchAdminLastLogin(
  env: Env,
  adminId: number,
): Promise<void> {
  await env.kuntips_db
    .prepare(
      `UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?`,
    )
    .bind(adminId)
    .run();
}

// Re-export for convenience
export { verifyPassword };
