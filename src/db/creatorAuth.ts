// src/db/creatorAuth.ts
import type { Env } from "../env";

export type AuthCreator = {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  twofaEnabled: number;
};

export async function getCreatorByEmail(
  env: Env,
  email: string,
): Promise<AuthCreator | null> {
  const row = (await env.kuntips_db
    .prepare(
      `
      SELECT
        id,
        username,
        email,
        display_name AS displayName,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        twofa_enabled AS twofaEnabled
      FROM creators
      WHERE lower(email) = lower(?)
      LIMIT 1
      `,
    )
    .bind(email)
    .first()) as
    | {
        id: number;
        username: string;
        email: string | null;
        displayName: string | null;
        passwordHash: string | null;
        passwordSalt: string | null;
        twofaEnabled: number;
      }
    | null;

  if (!row) return null;
  return row;
}

export async function getCreatorByIdForAuth(
  env: Env,
  creatorId: number,
): Promise<AuthCreator | null> {
  const row = (await env.kuntips_db
    .prepare(
      `
      SELECT
        id,
        username,
        email,
        display_name AS displayName,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        twofa_enabled AS twofaEnabled
      FROM creators
      WHERE id = ?
      LIMIT 1
      `,
    )
    .bind(creatorId)
    .first()) as
    | {
        id: number;
        username: string;
        email: string | null;
        displayName: string | null;
        passwordHash: string | null;
        passwordSalt: string | null;
        twofaEnabled: number;
      }
    | null;

  if (!row) return null;
  return row;
}
