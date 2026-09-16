// src/auth.ts
import type { Env } from "./env";
import { corsJson } from "./http";
import { getCreatorByEmail, getCreatorByIdForAuth } from "./db/creatorAuth";
import {
  createSession,
  getSessionFromRequest,
  deleteSessionByToken,
  hashPassword,
  verifyPassword,
} from "./db/passwordAuth";
import { createCreator, getCreatorByUsername } from "./db/creators";
import { sendEmail } from "./email";
import { containsBlockedContent } from "./utils/wordFilter";

// ----------- Password-strength-helper

function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) {
    return "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";
  }
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
    return "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";
  }
  return null;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}


// ---------- Auth handler functions --------------

export async function handleAuthLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return corsJson({ message: "Ugyldig forespørsel." }, 400);
  }

  const email = (body?.email || "").toString().trim().toLowerCase();
  const password = (body?.password || "").toString();

  if (!email || !password) {
    return corsJson(
      { message: "E-post og passord må fylles ut." },
      400,
    );
  }

  const creator = await getCreatorByEmail(env, email);

  // Generic error to avoid leaking whether email exists
  const invalidMessage = { message: "Feil e-post eller passord." };

  if (!creator || !creator.passwordHash || !creator.passwordSalt) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return corsJson(invalidMessage, 401);
  }

  const ok = await verifyPassword(
    password,
    creator.passwordSalt,
    creator.passwordHash,
  );

  if (!ok) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return corsJson(invalidMessage, 401);
  }

  const sessionToken = await createSession(env, creator.id, creator.username);

  // Update last_login_at if the column exists
  try {
    await env.kuntips_db
      .prepare(
        `
        UPDATE creators
        SET last_login_at = datetime('now')
        WHERE id = ?
        `,
      )
      .bind(creator.id)
      .run();
  } catch {
    // fail-safe: don't break login if column missing
  }

  return corsJson({
    sessionToken,
    creator: {
      id: creator.id,
      username: creator.username,
      email: creator.email,
      displayName: creator.displayName || creator.username,
      twofaEnabled: Boolean(creator.twofaEnabled),
    },
  });
}



export async function handleRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return corsJson({ message: "Ugyldig forespørsel" }, 400);
  }

  const rawEmail =
    typeof body?.email === "string" ? body.email.trim() : "";
  const rawPassword =
    typeof body?.password === "string" ? body.password : "";
  const rawUsername =
    typeof body?.username === "string" ? body.username.trim() : "";
  const rawDisplayName =
    typeof body?.displayName === "string"
      ? body.displayName.trim()
      : rawUsername;

  // Optional referral code (from body; frontend can pass this later)
  const rawReferralCode =
    typeof body?.referralCode === "string"
      ? body.referralCode.trim()
      : "";

  const email = rawEmail.toLowerCase();
  const username = rawUsername.toLowerCase();
  const displayName = rawDisplayName || username;
  // Keep the original casing for admin-code lookup; also hold a lowercase version for legacy
  // (creator-username) referral fallback.
  const referralCodeRaw = rawReferralCode;
  const referralCode = rawReferralCode.toLowerCase();

  // Required fields
  if (!email || !rawPassword || !username) {
    return corsJson(
      {
        message: "E-post, brukernavn og passord må fylles ut.",
      },
      400,
    );
  }

  // Basic email sanity check
  if (!email.includes("@") || !email.includes(".")) {
    return corsJson(
      {
        message: "Skriv inn en gyldig e-postadresse.",
      },
      400,
    );
  }

  // Username rules
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return corsJson(
      {
        message:
          "Username must be 3–32 characters, lowercase letters, numbers, or underscore only.",
      },
      400,
    );
  }

  // Password strength
  const pwError = validatePasswordStrength(rawPassword);
  if (pwError) {
    return corsJson({ message: pwError }, 400);
  }

  // Uniqueness checks
  const existingByEmail = await getCreatorByEmail(env, email);
  if (existingByEmail) {
    return corsJson(
      { message: "Denne e-postadressen er allerede registrert. Logg inn i stedet." },
      409,
    );
  }

  const existingByUsername = await getCreatorByUsername(env, username);
  if (existingByUsername) {
    return corsJson(
      { message: "Dette brukernavnet er opptatt. Velg et annet." },
      409,
    );
  }

  // 1) Create the creator row (username + displayName)
  const creator = await createCreator(env, username, displayName);

  // 2) Hash password
  const { salt, hash } = await hashPassword(rawPassword);

  // 3) Store email + password hash directly on creators
  await env.kuntips_db
    .prepare(
      `
      UPDATE creators
      SET email = ?, password_salt = ?, password_hash = ?
      WHERE id = ?
    `,
    )
    .bind(email, salt, hash, creator.id)
    .run();

  // 3a) Attribution facts of the visit that became this signup, so /admin/stats
  //     can join visit → registered → verified → Stripe-connected per source,
  //     per ad creative, per device and per in-app browser. Non-critical.
  try {
    const { classifyRequest, sanitizeAdId, sanitizeVisitorId } = await import(
      "./visitMeta"
    );
    const meta = classifyRequest(request);
    await env.kuntips_db
      .prepare(
        `UPDATE creators
           SET visitor_id = ?, signup_ad_id = ?, signup_device = ?,
               signup_os = ?, signup_in_app = ?, signup_country = ?
         WHERE id = ?`,
      )
      .bind(
        sanitizeVisitorId(body?.visitorId),
        sanitizeAdId(body?.adId),
        meta.device,
        meta.os,
        meta.inApp,
        meta.country,
        creator.id,
      )
      .run();
  } catch (err) {
    console.error("[register] failed to persist attribution:", err);
  }

  // 3b) Optional referral handling (if a referralCode was provided).
  //     First check admin-managed `referral_codes`, then fall back to
  //     legacy creator-username referrals.
  if (referralCodeRaw) {
    try {
      const { lookupActiveReferralCode } = await import(
        "./admin/referralCodes"
      );

      const adminCode = await lookupActiveReferralCode(env, referralCodeRaw);

      if (adminCode) {
        // Admin-managed code. Always give the new creator a 30-day join boost
        // and record the code on the creator row for tracking.
        const nowIso = new Date().toISOString();
        const joinBoostExpires = new Date();
        joinBoostExpires.setDate(joinBoostExpires.getDate() + 30);
        const joinBoostIso = joinBoostExpires.toISOString();

        await env.kuntips_db
          .prepare(
            `
            UPDATE creators
            SET signup_code = ?,
                referred_by_creator_id = ?,
                referral_join_boost_expires_at = ?
            WHERE id = ?
          `,
          )
          .bind(
            adminCode.code,
            adminCode.referrer_creator_id ?? null,
            joinBoostIso,
            creator.id,
          )
          .run();

        // If the code has an actual referrer creator attached, also log the
        // referral row (kept NULL for admin-only codes so no creator gets credit).
        if (adminCode.referrer_creator_id) {
          await env.kuntips_db
            .prepare(
              `
              INSERT OR IGNORE INTO creator_referrals
                (referrer_creator_id, referred_creator_id, created_at)
              VALUES (?, ?, ?)
            `,
            )
            .bind(adminCode.referrer_creator_id, creator.id, nowIso)
            .run();
        }
      } else if (referralCode && referralCode !== username) {
        // Legacy path: referralCode is a creator username.
        const referrer = await getCreatorByUsername(env, referralCode);
        if (referrer && referrer.id !== creator.id) {
          const nowIso = new Date().toISOString();
          const joinBoostExpires = new Date();
          joinBoostExpires.setDate(joinBoostExpires.getDate() + 30);
          const joinBoostIso = joinBoostExpires.toISOString();

          await env.kuntips_db
            .prepare(
              `
              INSERT OR IGNORE INTO creator_referrals
                (referrer_creator_id, referred_creator_id, created_at)
              VALUES (?, ?, ?)
            `,
            )
            .bind(referrer.id, creator.id, nowIso)
            .run();

          await env.kuntips_db
            .prepare(
              `
              UPDATE creators
              SET referred_by_creator_id = ?,
                  referral_join_boost_expires_at = ?
              WHERE id = ?
            `,
            )
            .bind(referrer.id, joinBoostIso, creator.id)
            .run();
        }
      }
    } catch (err) {
      // Referral is non-critical – never block signup on this.
      console.error("Referral handling failed during register:", err);
    }
  }

  // 4) Auto-login: create a session
  const sessionToken = await createSession(env, creator.id, creator.username);

  // 4b) Send email verification
  const verificationToken = generateToken();
  const verificationNowIso = new Date().toISOString();
  try {
    await env.kuntips_db
      .prepare(
        `UPDATE creators SET email_verified = 0, email_verification_token = ?, email_verification_sent_at = ? WHERE id = ?`,
      )
      .bind(verificationToken, verificationNowIso, creator.id)
      .run();
    const verifyUrl = `${env.FRONTEND_BASE_URL}/creators/verify-email?token=${verificationToken}`;
    await sendEmail(env.RESEND_API_KEY, {
      to: email,
      subject: "Bekreft e-postadressen din",
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
  <h2 style="color:#1e1b4b;">Velkommen til KunTips, ${displayName}</h2>
  <p>Bekreft e-postadressen din for å fullføre registreringen og kunne motta utbetalinger.</p>
  <p style="margin:2rem 0;">
    <a href="${verifyUrl}" style="background:#6366f1;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">Bekreft e-postadressen</a>
  </p>
  <p style="color:#888;font-size:0.85em;">Eller kopier denne linken inn i nettleseren:<br>${verifyUrl}</p>
  <p style="color:#888;font-size:0.85em;margin-top:1.5rem;">Hvis du ikke har opprettet konto hos KunTips, kan du se bort fra denne e-posten.</p>
</div>`,
    });
  } catch (err) {
    // Non-fatal: account is created, email verification can be resent from dashboard
    console.error("[register] Failed to send verification email:", err);
  }

  // 5) Shape a creator object similar to /auth/me
  const publicCreator = {
    id: creator.id,
    username: creator.username,
    email,
    displayName: creator.display_name ?? creator.username,
    bio: creator.bio ?? "",
    avatarUrl: creator.avatar_url ?? null,
    currentTier: creator.current_tier ?? 1,
  };

  // 6) Server-side "Lead" conversion (consent-gated, non-critical).
  //    Deduped with the client pixel via the shared eventId from the frontend.
  const marketingConsent = body?.marketingConsent === true;
  const trackingEventId =
    typeof body?.eventId === "string" && body.eventId ? body.eventId : null;

  // Store the choice. This is the only moment the browser — and therefore the
  // consent — is available; anything fired later (notably the `account.updated`
  // conversion, which arrives server-to-server days afterwards) has to read it
  // from here. Non-critical: never block signup on it.
  if (marketingConsent) {
    try {
      await env.kuntips_db
        .prepare(
          `UPDATE creators
             SET marketing_consent = 1, marketing_consent_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(creator.id)
        .run();
    } catch (err) {
      console.error("[register] failed to persist marketing consent:", err);
    }
  }

  if (marketingConsent && trackingEventId) {
    try {
      const { fireLead } = await import("./tracking");
      await fireLead(env, {
        eventId: trackingEventId,
        email,
        clientIp: request.headers.get("CF-Connecting-IP"),
        userAgent: request.headers.get("User-Agent"),
      }).catch((err) =>
        console.error("[register] fireLead failed:", err),
      );
    } catch (err) {
      console.error("[register] tracking import/lead failed:", err);
    }
  }

  return corsJson(
    {
      sessionToken,
      creator: publicCreator,
    },
    201,
  );
}

/**
 * POST /auth/logout — invalidate the server-side session.
 * Idempotent and always 200: a logout must never fail from the user's point of
 * view, even with a stale or already-deleted token.
 */
export async function handleAuthLogout(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth =
    request.headers.get("Authorization") ??
    request.headers.get("authorization");
  const [scheme, token] = (auth ?? "").split(" ");
  if (scheme === "Bearer" && token) {
    try {
      await deleteSessionByToken(env, token.trim());
    } catch (err) {
      console.error("[logout] session delete failed:", err);
    }
  }
  return corsJson({ ok: true });
}

export async function handleAuthMe(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await getSessionFromRequest(env, request);
  if (!session) {
    return corsJson({ message: "Du er ikke logget inn." }, 401);
  }

  const creator = await getCreatorByIdForAuth(env, session.creatorId);
  if (!creator) {
    return corsJson({ message: "Fant ikke kontoen." }, 404);
  }

  return corsJson({
    creator: {
      id: creator.id,
      username: creator.username,
      email: creator.email,
      displayName: creator.displayName || creator.username,
      twofaEnabled: Boolean(creator.twofaEnabled),
    },
    session: {
      username: session.username,
    },
  });
}

export async function handleDebugHashPassword(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return corsJson({ message: "Ugyldig forespørsel." }, 400);
  }

  const password = (body?.password || "").toString();
  if (!password) {
    return corsJson({ message: "Passord må fylles ut." }, 400);
  }

  const { salt, hash } = await hashPassword(password);

  // TEMP: for testing only
  return corsJson({
    salt,
    hash,
  });
}

export async function handleDebugCheckLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return corsJson({ stage: "bad_json" }, 400);
  }

  const email = (body?.email || "").toString().trim().toLowerCase();
  const password = (body?.password || "").toString();

  if (!email || !password) {
    return corsJson({ stage: "missing_fields" }, 400);
  }

  const creator = await getCreatorByEmail(env, email);
  if (!creator) {
    return corsJson({ stage: "no_creator_for_email" }, 200);
  }

  if (!creator.passwordHash || !creator.passwordSalt) {
    return corsJson(
      {
        stage: "creator_found_but_no_password",
        creatorId: creator.id,
        username: creator.username,
      },
      200,
    );
  }

  const ok = await verifyPassword(
    password,
    creator.passwordSalt,
    creator.passwordHash,
  );

  return corsJson({
    stage: "creator_found_password_checked",
    creatorId: creator.id,
    username: creator.username,
    email: creator.email,
    password_ok: ok,
  });
}

// ---------- Password change handler -----------

export async function handleChangePassword(
  request: Request,
  env: Env,
): Promise<Response> {
  // 1) Require valid session (same pattern as /auth/me)
  const session = await getSessionFromRequest(env, request);
  if (!session) {
    return corsJson({ message: "Du er ikke logget inn." }, 401);
  }

  // 2) Parse and validate body
  let body: any;
  try {
    body = await request.json();
  } catch {
    return corsJson({ message: "Ugyldig forespørsel." }, 400);
  }

  const currentPassword = (body?.currentPassword || "").toString();
  const newPassword = (body?.newPassword || "").toString();

  if (!currentPassword || !newPassword) {
    return corsJson(
      { message: "Nåværende og nytt passord må fylles ut." },
      400,
    );
  }

  const pwError = validatePasswordStrength(newPassword);
  if (pwError) {
    return corsJson({ message: pwError }, 400);
  }

  // 3) Load creator auth row
  const creator = await getCreatorByIdForAuth(env, session.creatorId);
  // creatorAuth.ts returns passwordSalt/passwordHash in camelCase
  if (!creator || !creator.passwordSalt || !creator.passwordHash) {
    // defensive: if something is weird, treat as bad password
    return corsJson({ message: "Nåværende passord er feil." }, 400);
  }


  // 4) Verify current password
  const ok = await verifyPassword(
    currentPassword,
    creator.passwordSalt,
    creator.passwordHash,
  );

  if (!ok) {
    return corsJson({ message: "Nåværende passord er feil." }, 400);
  }

  // 5) Hash + store the new password
  const { salt, hash } = await hashPassword(newPassword);

  await env.kuntips_db
    .prepare(
      `
      UPDATE creators
      SET password_salt = ?, password_hash = ?
      WHERE id = ?
    `,
    )
    .bind(salt, hash, creator.id)
    .run();

  // 6) Revoke all sessions so any leaked tokens are invalidated
  await env.kuntips_db
    .prepare(`DELETE FROM creator_sessions WHERE creator_id = ?`)
    .bind(creator.id)
    .run();

  return corsJson({ message: "Passordet er oppdatert." });
}

// ---------- Email verification -----------

export async function handleVerifyEmail(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  if (!token) {
    return corsJson({ message: "Bekreftelseskode mangler." }, 400);
  }

  const row = await env.kuntips_db
    .prepare(
      `SELECT id, email_verified FROM creators WHERE email_verification_token = ? LIMIT 1`,
    )
    .bind(token)
    .first<{ id: number; email_verified: number }>();

  if (!row) {
    return corsJson(
      { message: "Linken er ugyldig eller har utløpt." },
      400,
    );
  }

  if (row.email_verified === 1) {
    return corsJson({ message: "E-postadressen er allerede bekreftet." });
  }

  await env.kuntips_db
    .prepare(
      `UPDATE creators SET email_verified = 1, email_verification_token = NULL WHERE id = ?`,
    )
    .bind(row.id)
    .run();

  return corsJson({ message: "E-postadressen er bekreftet." });
}

export async function handleResendVerification(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await getSessionFromRequest(env, request);
  if (!session) {
    return corsJson({ message: "Du er ikke logget inn." }, 401);
  }

  const row = await env.kuntips_db
    .prepare(
      `SELECT id, email, email_verified, display_name FROM creators WHERE id = ? LIMIT 1`,
    )
    .bind(session.creatorId)
    .first<{
      id: number;
      email: string | null;
      email_verified: number;
      display_name: string | null;
    }>();

  if (!row || !row.email) {
    return corsJson({ message: "Fant ikke kontoen." }, 404);
  }

  if (row.email_verified === 1) {
    return corsJson({ message: "E-postadressen er allerede bekreftet." });
  }

  // Rate limit: one resend per 60 seconds per creator
  const rlKey = `resend-verify:${session.creatorId}`;
  const existing = await env.kuntips_rl.get(rlKey);
  if (existing) {
    return corsJson(
      {
        message:
          "Vennligst vent litt før du ber om en ny bekreftelse.",
      },
      429,
    );
  }
  await env.kuntips_rl.put(rlKey, "1", { expirationTtl: 60 });

  const verificationToken = generateToken();
  const nowIso = new Date().toISOString();
  await env.kuntips_db
    .prepare(
      `UPDATE creators SET email_verification_token = ?, email_verification_sent_at = ? WHERE id = ?`,
    )
    .bind(verificationToken, nowIso, row.id)
    .run();

  const verifyUrl = `${env.FRONTEND_BASE_URL}/creators/verify-email?token=${verificationToken}`;
  await sendEmail(env.RESEND_API_KEY, {
    to: row.email,
    subject: "Bekreft e-postadressen din",
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
  <h2 style="color:#1e1b4b;">Bekreft e-postadressen din</h2>
  <p>Trykk på linken under for å bekrefte e-postadressen din.</p>
  <p style="margin:2rem 0;">
    <a href="${verifyUrl}" style="background:#6366f1;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">Bekreft e-postadressen</a>
  </p>
  <p style="color:#888;font-size:0.85em;">Eller kopier denne linken inn i nettleseren:<br>${verifyUrl}</p>
  <p style="color:#888;font-size:0.85em;margin-top:1.5rem;">If you didn't request this, you can safely ignore this email.</p>
</div>`,
  });

  return corsJson({ message: "Bekreftelsen er sendt." });
}

// ---------- Password reset -----------

export async function handleForgotPassword(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return corsJson({ message: "Ugyldig forespørsel." }, 400);
  }

  const email = (
    ((body as Record<string, unknown>)?.email as string) || ""
  )
    .trim()
    .toLowerCase();

  if (!email) {
    return corsJson({ message: "E-post må fylles ut." }, 400);
  }

  // Always return the same message — never reveal whether the email exists
  const genericOk = corsJson({
    message:
      "If that email is registered, you'll receive a password reset link shortly.",
  });

  const row = await env.kuntips_db
    .prepare(
      `SELECT id, email, display_name FROM creators WHERE lower(email) = ? LIMIT 1`,
    )
    .bind(email)
    .first<{ id: number; email: string; display_name: string | null }>();

  if (!row) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return genericOk;
  }

  // Rate limit: one reset request per creator per 5 minutes
  const rlKey = `pwd-reset:${row.id}`;
  const existing = await env.kuntips_rl.get(rlKey);
  if (existing) {
    return genericOk;
  }
  await env.kuntips_rl.put(rlKey, "1", { expirationTtl: 300 });

  const resetToken = generateToken();
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  await env.kuntips_db
    .prepare(
      `UPDATE creators SET password_reset_token = ?, password_reset_token_expires_at = ? WHERE id = ?`,
    )
    .bind(resetToken, expiresAt, row.id)
    .run();

  const resetUrl = `${env.FRONTEND_BASE_URL}/creators/reset-password?token=${resetToken}`;
  await sendEmail(env.RESEND_API_KEY, {
    to: row.email,
    subject: "Tilbakestill KunTips-passordet ditt",
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
  <h2 style="color:#1e1b4b;">Tilbakestill passordet ditt</h2>
  <p>Vi har mottatt en forespørsel om nytt passord til din KunTips-konto. Trykk på linken under for å lage et nytt. Linken varer i én time.</p>
  <p style="margin:2rem 0;">
    <a href="${resetUrl}" style="background:#6366f1;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">Reset password</a>
  </p>
  <p style="color:#888;font-size:0.85em;">Eller kopier denne linken inn i nettleseren:<br>${resetUrl}</p>
  <p style="color:#888;font-size:0.85em;margin-top:1.5rem;">If you didn't request a password reset, you can safely ignore this email. Your password will not change.</p>
</div>`,
  });

  return genericOk;
}

export async function handleResetPassword(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return corsJson({ message: "Ugyldig forespørsel." }, 400);
  }

  const b = body as Record<string, unknown>;
  const token = ((b?.token as string) || "").trim();
  const newPassword = (b?.newPassword as string) || "";

  if (!token || !newPassword) {
    return corsJson(
      { message: "Kode og nytt passord må fylles ut." },
      400,
    );
  }

  const pwError = validatePasswordStrength(newPassword);
  if (pwError) {
    return corsJson({ message: pwError }, 400);
  }

  const row = await env.kuntips_db
    .prepare(
      `SELECT id, password_reset_token_expires_at FROM creators WHERE password_reset_token = ? LIMIT 1`,
    )
    .bind(token)
    .first<{ id: number; password_reset_token_expires_at: string | null }>();

  if (!row) {
    return corsJson(
      { message: "Invalid or expired password reset link." },
      400,
    );
  }

  if (
    !row.password_reset_token_expires_at ||
    new Date(row.password_reset_token_expires_at) < new Date()
  ) {
    return corsJson(
      {
        message:
          "Linken har utløpt. Vennligst be om en ny.",
      },
      400,
    );
  }

  const { salt, hash } = await hashPassword(newPassword);

  await env.kuntips_db
    .prepare(
      `UPDATE creators
       SET password_salt = ?, password_hash = ?,
           password_reset_token = NULL,
           password_reset_token_expires_at = NULL
       WHERE id = ?`,
    )
    .bind(salt, hash, row.id)
    .run();

  // Revoke all sessions
  await env.kuntips_db
    .prepare(`DELETE FROM creator_sessions WHERE creator_id = ?`)
    .bind(row.id)
    .run();

  return corsJson({
    message:
      "Password reset successfully. You can now log in with your new password.",
  });
}
