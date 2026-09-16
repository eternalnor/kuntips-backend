// src/admin/bootstrap.ts
// One-off endpoint to create the first admin user.
// Protected by ADMIN_SECRET. Refuses once any admin exists.

import type { Env } from "../env";
import {
  countAdminUsers,
  createAdminUser,
  bearerTokenFromRequest,
} from "../db/adminAuth";

type Result =
  | { ok: true; adminId: number; username: string }
  | { ok: false; error: string; status: number };

export async function handleAdminBootstrap(
  env: Env,
  request: Request,
): Promise<Result> {
  // Gate: must supply ADMIN_SECRET (not admin session — chicken/egg)
  const token = bearerTokenFromRequest(request);
  if (!env.ADMIN_SECRET || token !== env.ADMIN_SECRET) {
    return { ok: false, error: "unauthorized", status: 401 };
  }

  // Gate: only works if no admin exists yet
  const existing = await countAdminUsers(env);
  if (existing > 0) {
    return { ok: false, error: "already_bootstrapped", status: 409 };
  }

  // Parse + validate payload
  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return {
      ok: false,
      error:
        "invalid_username (3-32 chars, letters, digits, underscore, hyphen)",
      status: 400,
    };
  }

  if (password.length < 12) {
    return {
      ok: false,
      error: "password_too_short (min 12 chars)",
      status: 400,
    };
  }

  const adminId = await createAdminUser(env, username, password);
  if (!adminId) {
    return { ok: false, error: "create_failed", status: 500 };
  }

  return { ok: true, adminId, username };
}
