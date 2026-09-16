// src/admin/auth.ts
// Admin login / logout / me endpoints.

import type { Env } from "../env";
import {
  getAdminByUsername,
  createAdminSession,
  deleteAdminSession,
  getAdminSessionFromRequest,
  bearerTokenFromRequest,
  touchAdminLastLogin,
  verifyPassword,
} from "../db/adminAuth";

type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; status: number };

/**
 * POST /admin/auth/login
 * Body: { username, password }
 * Returns: { sessionToken, username }
 */
export async function handleAdminLogin(
  env: Env,
  request: Request,
): Promise<Result<{ sessionToken: string; username: string }>> {
  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }

  const username =
    typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return { ok: false, error: "missing_credentials", status: 400 };
  }

  const admin = await getAdminByUsername(env, username);
  if (!admin) {
    return { ok: false, error: "invalid_credentials", status: 401 };
  }

  const valid = await verifyPassword(
    password,
    admin.passwordSalt,
    admin.passwordHash,
  );
  if (!valid) {
    return { ok: false, error: "invalid_credentials", status: 401 };
  }

  const sessionToken = await createAdminSession(
    env,
    admin.id,
    admin.username,
  );
  await touchAdminLastLogin(env, admin.id);

  return { ok: true, sessionToken, username: admin.username };
}

/**
 * POST /admin/auth/logout
 * Deletes the admin session row.
 */
export async function handleAdminLogout(
  env: Env,
  request: Request,
): Promise<Result<{}>> {
  const token = bearerTokenFromRequest(request);
  if (!token) {
    return { ok: false, error: "no_token", status: 400 };
  }
  // Only deletes if the token is an admin session; harmless if ADMIN_SECRET.
  await deleteAdminSession(env, token);
  return { ok: true };
}

/**
 * GET /admin/me
 * Returns the current admin's identity if the session is valid.
 */
export async function handleAdminMe(
  env: Env,
  request: Request,
): Promise<
  Result<{ adminId: number; username: string; via: "session" | "secret" }>
> {
  const token = bearerTokenFromRequest(request);
  if (!token) {
    return { ok: false, error: "unauthorized", status: 401 };
  }

  // If it's the admin secret, report that — useful for CLI sanity checks.
  if (env.ADMIN_SECRET && token === env.ADMIN_SECRET) {
    return {
      ok: true,
      adminId: 0,
      username: "admin_secret",
      via: "secret",
    };
  }

  const session = await getAdminSessionFromRequest(env, request);
  if (!session) {
    return { ok: false, error: "unauthorized", status: 401 };
  }

  return {
    ok: true,
    adminId: session.adminId,
    username: session.username,
    via: "session",
  };
}
