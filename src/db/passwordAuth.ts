// src/db/passwordAuth.ts
import type { Env } from "../env";

/**
 * Helpers: time + random + hashing
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

function fromBase64Url(str: string): Uint8Array {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(
    (str.length + 3) % 4,
  );
  const bin = atob(normalized);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations = 100_000,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt,
    },
    keyMaterial,
    256,
  );

  return new Uint8Array(bits);
}

/**
 * Public password helpers
 */

export async function hashPassword(
  password: string,
): Promise<{ salt: string; hash: string }> {
  const saltBytes = randomBytes(32);
  const hashBytes = await pbkdf2(password, saltBytes);
  return {
    salt: toBase64Url(saltBytes),
    hash: toBase64Url(hashBytes),
  };
}

export async function verifyPassword(
  password: string,
  saltB64: string,
  hashB64: string,
): Promise<boolean> {
  try {
    const salt = fromBase64Url(saltB64);
    const expected = fromBase64Url(hashB64);
    const actual = await pbkdf2(password, salt);

    if (actual.length !== expected.length) return false;
    // constant-time-ish compare
    let diff = 0;
    for (let i = 0; i < actual.length; i++) {
      diff |= actual[i] ^ expected[i];
    }
    return diff === 0;
  } catch {
    return false;
  }
}

/**
 * Session helpers (Bearer tokens stored in creator_sessions)
 */

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

export type CreatorSession = {
  creatorId: number;
  username: string;
};

export async function createSession(
  env: Env,
  creatorId: number,
  username: string,
  ttlDays = 30,
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
      INSERT INTO creator_sessions (creator_id, username, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .bind(creatorId, username, tokenHash, now, expiresAt)
    .run();

  return rawToken;
}

/**
 * Server-side logout: delete the session row so the token is dead even if a
 * copy survives in some browser's local storage. Without this, "logout" only
 * cleared the client and the token stayed valid until its 30-day expiry —
 * which contradicted what the privacy documents told users.
 * Opportunistically sweeps expired rows so the table doesn't grow forever.
 */
export async function deleteSessionByToken(
  env: Env,
  rawToken: string,
): Promise<void> {
  const tokenHash = await sha256hex(rawToken);
  await env.kuntips_db
    .prepare(`DELETE FROM creator_sessions WHERE token_hash = ?`)
    .bind(tokenHash)
    .run();
  await env.kuntips_db
    .prepare(`DELETE FROM creator_sessions WHERE expires_at <= ?`)
    .bind(nowIso())
    .run();
}

export async function getSessionByToken(
  env: Env,
  rawToken: string,
): Promise<CreatorSession | null> {
  const tokenHash = await sha256hex(rawToken);
  const now = nowIso();

  const row = (await env.kuntips_db
    .prepare(
      `
      SELECT creator_id, username, expires_at
      FROM creator_sessions
      WHERE token_hash = ?
      LIMIT 1
    `,
    )
    .bind(tokenHash)
    .first()) as
    | {
        creator_id: number;
        username: string;
        expires_at: string;
      }
    | null;

  if (!row) return null;
  if (row.expires_at <= now) return null;

  await env.kuntips_db
    .prepare(
      `
      UPDATE creator_sessions
      SET last_used_at = ?
      WHERE token_hash = ?
    `,
    )
    .bind(now, tokenHash)
    .run();

  return {
    creatorId: row.creator_id,
    username: row.username,
  };
}

export async function getSessionFromRequest(
  env: Env,
  request: Request,
): Promise<CreatorSession | null> {
  const auth =
    request.headers.get("Authorization") ??
    request.headers.get("authorization");
  if (!auth) return null;

  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) return null;

  return getSessionByToken(env, token.trim());
}
