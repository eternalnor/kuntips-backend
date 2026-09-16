// index.ts
import type { Env } from "./env";  // instead of declaring Env again
import { corsJson, corsPreflight, CORS_HEADERS } from "./http";
import { checkRateLimit } from "./rateLimit";
import { applyDailyTierDowngrade, computeEffectiveTierForCreator } from "./tier";
import {
  	getCreatorByUsername,
  	createCreator,
  	updateCreatorStripeAccount,
	updateCreatorProfile,
} from "./db/creators";
import { getSessionFromRequest } from "./db/passwordAuth";
import { isAdminAuthed, getAdminSessionFromRequest } from "./db/adminAuth";
import { handleAdminBootstrap } from "./admin/bootstrap";
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminMe,
} from "./admin/auth";
import { handleGetCreatorDashboard } from "./creatorDashboard";
import {
  handleAuthLogin,
  handleAuthMe,
  handleChangePassword,
  handleRegister,
  handleVerifyEmail,
  handleResendVerification,
  handleForgotPassword,
  handleResetPassword,
} from "./auth";
import { containsBlockedContent } from "./utils/wordFilter";
import {
  handleCreateAccountLink,
  handleCreateTipSession,
	updateTipStatusByPaymentIntentId,
} from "./stripe";
import { handleStripeWebhook } from "./stripewebhooks";
import { getCreatorPayoutPreview } from "./payouts/payoutPreview";
import { createCreatorPayoutRequest } from "./payouts/payoutRequest";
import { getPayoutStatement } from "./payouts/payoutStatement";


export async function handleGetCreatorPublicProfile(
  env: Env,
  username: string,
): Promise<Response> {
  const creator = await getCreatorByUsername(env, username);

  if (!creator || !creator.is_active) {
    return corsJson(
      {
        error: "creator_not_found",
        message: `Det finnes ingen aktiv side på ${username}.`,
      },
      404,
    );
  }

  // Compute effective tier (includes all boosts: referral, join, temp, global event)
  const effectiveTierInfo = await computeEffectiveTierForCreator(
    env.kuntips_db,
    creator.id,
    env.kuntips_rl,
  );
  const platformFeeBps = creator.platform_fee_bps ?? 500;
  const keptPercent = effectiveTierInfo.effectiveKeepPercent;

  return corsJson({
    username: creator.username,
    displayName: creator.display_name ?? creator.username,
    bio: creator.bio ?? "",
    avatarUrl: creator.avatar_url ?? null,
    isActive: !!creator.is_active,
    hasStripeAccount: !!creator.psp_subaccount_id,
    platformFeeBps,
    keptPercent,
  });

}

// Fetch public creator profile by username
async function handleGetCreator(env: Env, username: string): Promise<Response> {
  const normalized = username.trim().toLowerCase();
  if (!normalized) {
    return corsJson(
      { error: "invalid_request", message: "username is required" },
      400,
    );
  }

  const creator = await getCreatorByUsername(env, normalized);

  // Either no creator, or not active yet
  if (!creator || creator.is_active !== 1) {
    return corsJson(
      {
        error: "creator_not_found",
        message: "Fant ingen aktiv skaper",
      },
      404,
    );
  }

  // Stripe readiness.
  //
  // Tips are DESTINATION CHARGES, so the gate is the connected account's
  // `transfers` capability — not payouts_enabled (which only governs bank
  // withdrawals, and our payout schedule is manual anyway). Gating on payouts
  // here would hide the tip form from creators who can happily take money but
  // have not finished adding a bank account.
  //
  // Until we have actually asked Stripe (stripe_state_synced_at IS NULL) we
  // must NOT treat 0 as "no" — during rollout that would blank every tip page
  // on the platform. Unknown falls back to the previous behaviour; the backfill
  // and the account.updated webhook replace it with the truth within minutes.
  const hasStripeAccount = !!creator.psp_subaccount_id;
  const everSynced = creator.stripe_state_synced_at != null;
  const canReceiveTips = everSynced
    ? creator.stripe_transfers_active === 1
    : hasStripeAccount;
  const stripeConnected = canReceiveTips;

  // Tier + fee → what the creator keeps (effective tier includes all boosts)
  const platformFeeBps = creator.platform_fee_bps ?? 500;
  const effectiveTierInfo = await computeEffectiveTierForCreator(
    env.kuntips_db,
    creator.id,
    env.kuntips_rl,
  );
  const keptPercent = effectiveTierInfo.effectiveKeepPercent;

  // Only expose public fields
  const publicCreator = {
    id: creator.id,
    username: creator.username,
    display_name: creator.display_name,
    bio: creator.bio ?? "",
    avatar_url: creator.avatar_url ?? null,
    current_tier: creator.current_tier ?? 1,
    stripe_connected: stripeConnected,
    can_receive_tips: canReceiveTips,
    platformFeeBps,
    keptPercent,
  };

  return corsJson(publicCreator);
}

// ---------- Worker entry ----------

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") {
    return corsPreflight();
  }

	if (request.method === "GET" && pathname === "/health") {
      return corsJson({ ok: true, env: "worker" });
    }

  // GET /stats — public platform stats (no auth)
  if (request.method === "GET" && pathname === "/stats") {
    const { handlePublicStats } = await import("./publicStats");
    const stats = await handlePublicStats(env);
    return corsJson(stats);
  }

  // POST /referral/visit — top-of-funnel logging (no auth).
  // Called by the Pages Function on kuntips.no, not by the browser directly:
  // the cookie has to be set first-party, and this Worker is a different origin.
  if (request.method === "POST" && pathname === "/referral/visit") {
    const { handleReferralVisit } = await import("./referralVisit");
    const res = await handleReferralVisit(request, env);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
    return out;
  }

  // POST /visit — landing ping for every visitor, once per browser session
  // (no auth). Gives /admin/stats its denominators; see siteVisit.ts.
  if (request.method === "POST" && pathname === "/visit") {
    const { handleSiteVisit } = await import("./siteVisit");
    const res = await handleSiteVisit(request, env);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
    return out;
  }

  // GET /settings/tips — public tip min/max/preset config (no auth)
  if (request.method === "GET" && pathname === "/settings/tips") {
    const { getTipsSettings } = await import("./settings");
    const data = await getTipsSettings(env);
    return corsJson(data);
  }

	// PUT /creators/:username/profile  (update display name + bio)
	if (request.method === "PUT" && pathname.startsWith("/creators/") && pathname.endsWith("/profile")) {
	  const raw = pathname.slice("/creators/".length);
	  const normalizedUsername = raw.replace(/\/profile$/, "").trim().toLowerCase();

	  // Require a valid session that belongs to this exact creator
	  const session = await getSessionFromRequest(env, request);
	  if (!session || session.username !== normalizedUsername) {
		return corsJson(
		  { error: "forbidden", message: "Du kan ikke endre denne profilen." },
		  403,
		);
	  }

	  const body = await request.json().catch(() => null) as Record<string, unknown> | null;

	  if (!body || typeof body !== "object") {
		return corsJson({ message: "Invalid JSON body" }, 400);
	  }

	  const displayName = ((body.displayName as string) || "").trim();
	  const bio = ((body.bio as string) || "").trim();

	  if (!displayName) {
		return corsJson({ message: "Visningsnavn må fylles ut" }, 400);
	  }

	  if (displayName.length > 80) {
		return corsJson({ message: "Visningsnavnet kan være maks 80 tegn" }, 400);
	  }

	  if (bio.length > 160) {
		return corsJson({ message: "Bioen kan være maks 160 tegn." }, 400);
	  }

	  if (bio && containsBlockedContent(bio)) {
		return corsJson({ message: "Bioen inneholder noe som ikke er tillatt." }, 400);
	  }

	  try {
		await updateCreatorProfile(env.kuntips_db, normalizedUsername, displayName, bio);
		return corsJson({ success: true }, 200);
	  } catch {
		return corsJson({ message: "Vi fikk ikke lagret profilen" }, 500);
	  }
	}


	if (request.method === "POST" && pathname === "/auth/login") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const allowed = await checkRateLimit(env.kuntips_rl, "login", ip, 10, 900); // 10 per 15 min
      if (!allowed) {
        return corsJson({ error: "rate_limited", message: "For mange innloggingsforsøk. Vennligst prøv igjen senere." }, 429);
      }
      return handleAuthLogin(request, env);
    }

	// POST /auth/change-password
    if (request.method === "POST" && pathname === "/auth/change-password") {
      return handleChangePassword(request, env);
    }

    // GET /auth/verify-email?token=...
    if (request.method === "GET" && pathname === "/auth/verify-email") {
      return handleVerifyEmail(request, env);
    }

    // POST /auth/resend-verification
    if (request.method === "POST" && pathname === "/auth/resend-verification") {
      return handleResendVerification(request, env);
    }

    // POST /auth/forgot-password
    if (request.method === "POST" && pathname === "/auth/forgot-password") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const allowed = await checkRateLimit(env.kuntips_rl, "forgot-password", ip, 5, 900);
      if (!allowed) {
        return corsJson({ error: "rate_limited", message: "For mange forespørsler. Vennligst prøv igjen senere." }, 429);
      }
      return handleForgotPassword(request, env);
    }

    // POST /auth/reset-password
    if (request.method === "POST" && pathname === "/auth/reset-password") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const allowed = await checkRateLimit(env.kuntips_rl, "reset-password", ip, 10, 900);
      if (!allowed) {
        return corsJson({ error: "rate_limited", message: "For mange forespørsler. Vennligst prøv igjen senere." }, 429);
      }
      return handleResetPassword(request, env);
    }

    // POST /auth/logout — kills the server-side session (see privacy docs)
    if (request.method === "POST" && pathname === "/auth/logout") {
      const { handleAuthLogout } = await import("./auth");
      return handleAuthLogout(request, env);
    }

    if (request.method === "GET" && pathname === "/auth/me") {
      return handleAuthMe(request, env);
    }

	if (request.method === "POST" && pathname === "/auth/register") {
	  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
	  const allowed = await checkRateLimit(env.kuntips_rl, "register", ip, 5, 3600); // 5 per hour
	  if (!allowed) {
	    return corsJson({ error: "rate_limited", message: "For mange registreringsforsøk. Vennligst prøv igjen senere." }, 429);
	  }
	  return handleRegister(request, env);
	}


	// Creator payout preview: /creators/:username/payouts/preview
	if (
	  request.method === "GET" &&
	  pathname.startsWith("/creators/") &&
	  pathname.endsWith("/payouts/preview")
	) {
	  const raw = pathname.slice("/creators/".length); // e.g. "testcreator/payouts/preview"
	  const username = raw.replace(/\/payouts\/preview$/, "");

	  // Require a valid session matching this username (case-insensitive)
	  const session = await getSessionFromRequest(env, request);
	  const normalizedUsername = username.toLowerCase();

	  if (!session || session.username !== normalizedUsername) {
		return corsJson(
		  {
			error: "forbidden",
			message: "You are not allowed to view this payout preview.",
		  },
		  403,
		);
	  }

	  const creator = await getCreatorByUsername(env, normalizedUsername);

	  if (!creator) {
		return corsJson(
		  { error: "creator_not_found", message: "Creator not found." },
		  404,
		);
	  }

	  const preview = await getCreatorPayoutPreview({
		env,
		creatorId: creator.id,
	  });

	  return corsJson(preview, 200);
	}

	// Creator payout request: /creators/:username/payouts/request
	if (
	  request.method === "POST" &&
	  pathname.startsWith("/creators/") &&
	  pathname.endsWith("/payouts/request")
	) {
	  const raw = pathname.slice("/creators/".length); // e.g. "testcreator/payouts/request"
	  const username = raw.replace(/\/payouts\/request$/, "");

	  const session = await getSessionFromRequest(env, request);
	  const normalizedUsername = username.toLowerCase();

	  if (!session || session.username !== normalizedUsername) {
		return corsJson(
		  {
			error: "forbidden",
			message: "You are not allowed to request a payout for this creator.",
		  },
		  403,
		);
	  }

	  const creator = await getCreatorByUsername(env, normalizedUsername);
	  if (!creator) {
		return corsJson(
		  { error: "creator_not_found", message: "Creator not found." },
		  404,
		);
	  }

	  const result = await createCreatorPayoutRequest({
		env,
		creatorId: creator.id,
	  });

	  if (!result.ok) {
		// Not eligible -> 409 so frontend can treat it as a “blocked by policy” state
		return corsJson(result, 409);
	  }

	  return corsJson(result, 200);
	}


	// Payout statement: GET /creators/:username/payouts/:payoutId/statement
	if (
	  request.method === "GET" &&
	  pathname.startsWith("/creators/") &&
	  /\/payouts\/\d+\/statement$/.test(pathname)
	) {
	  const match = pathname.match(/^\/creators\/([^/]+)\/payouts\/(\d+)\/statement$/);
	  if (match) {
	    const username = match[1].toLowerCase();
	    const payoutId = Number(match[2]);

	    const session = await getSessionFromRequest(env, request);
	    if (!session || session.username !== username) {
	      return corsJson({ error: "forbidden", message: "Not allowed." }, 403);
	    }

	    const creator = await getCreatorByUsername(env, username);
	    if (!creator) {
	      return corsJson({ error: "creator_not_found", message: "Creator not found." }, 404);
	    }

	    const statement = await getPayoutStatement(env, payoutId, creator.id);
	    if (!statement) {
	      return corsJson({ error: "not_found", message: "Payout not found." }, 404);
	    }

	    return corsJson(statement, 200);
	  }
	}

	// Creator dashboard: /creators/:username/dashboard
    if (
      request.method === "GET" &&
      pathname.startsWith("/creators/") &&
      pathname.endsWith("/dashboard")
    ) {
      const raw = pathname.slice("/creators/".length); // e.g. "testcreator/dashboard"
      const username = raw.replace(/\/dashboard$/, ""); // "testcreator"

      // Require a valid session matching this username (case-insensitive)
      const session = await getSessionFromRequest(env, request);
      const normalizedUsername = username.toLowerCase();

      if (!session || session.username !== normalizedUsername) {
        return corsJson(
          {
            error: "forbidden",
            message: "You are not allowed to view this dashboard.",
          },
          403,
        );
      }

      return handleGetCreatorDashboard(env, username);
    }

    // Public creator profile endpoint: /creators/:username
    if (request.method === "GET" && pathname.startsWith("/creators/")) {
      const username = pathname.slice("/creators/".length);
      return handleGetCreator(env, username);
    }

    if (
      request.method === "POST" &&
      pathname === "/connect/create-account-link"
    ) {
      return handleCreateAccountLink(request, env);
    }

    if (request.method === "POST" && pathname === "/tips/session") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const allowed = await checkRateLimit(env.kuntips_rl, "tip", ip, 20, 600); // 20 per 10 min
      if (!allowed) {
        return corsJson({ error: "rate_limited", message: "For mange forespørsler. Vennligst vent litt." }, 429);
      }
      return handleCreateTipSession(request, env);
    }

	if (request.method === "POST" && pathname === "/webhooks/stripe") {
      // Stripe will not send CORS preflights here; plain JSON response is fine
      return handleStripeWebhook(request, env, ctx);
    }

  // ────────────────────────────────────────────────────────────────────────
  // Admin panel — bootstrap + auth (ADMIN_SECRET only for bootstrap; session
  // for subsequent endpoints; existing admin endpoints accept either).
  // ────────────────────────────────────────────────────────────────────────

  // POST /admin/bootstrap — one-off first admin creation (ADMIN_SECRET required)
  if (request.method === "POST" && pathname === "/admin/bootstrap") {
    const result = await handleAdminBootstrap(env, request);
    if (!result.ok) return corsJson({ error: result.error }, result.status);
    return corsJson({ ok: true, adminId: result.adminId, username: result.username });
  }

  // POST /admin/auth/login
  if (request.method === "POST" && pathname === "/admin/auth/login") {
    const result = await handleAdminLogin(env, request);
    if (!result.ok) return corsJson({ error: result.error }, result.status);
    return corsJson({ sessionToken: result.sessionToken, username: result.username });
  }

  // POST /admin/auth/logout
  if (request.method === "POST" && pathname === "/admin/auth/logout") {
    const result = await handleAdminLogout(env, request);
    if (!result.ok) return corsJson({ error: result.error }, result.status);
    return corsJson({ ok: true });
  }

  // GET /admin/me
  if (request.method === "GET" && pathname === "/admin/me") {
    const result = await handleAdminMe(env, request);
    if (!result.ok) return corsJson({ error: result.error }, result.status);
    return corsJson({
      adminId: result.adminId,
      username: result.username,
      via: result.via,
    });
  }

  // GET /admin/overview — dashboard aggregate stats (session or ADMIN_SECRET)
  if (request.method === "GET" && pathname === "/admin/overview") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const { handleAdminOverview } = await import("./admin/overview");
    const data = await handleAdminOverview(env);
    return corsJson(data);
  }

  // GET /admin/stats?days=7|30|90 — marketing statistics dashboard
  if (request.method === "GET" && pathname === "/admin/stats") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const { handleAdminStats } = await import("./admin/stats");
    const data = await handleAdminStats(env, url.searchParams.get("days"));
    return corsJson(data);
  }

  // POST /admin/sync-stripe-accounts — backfill/refresh Stripe capability flags
  if (request.method === "POST" && pathname === "/admin/sync-stripe-accounts") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const { handleAdminSyncStripeAccounts } = await import("./admin/syncStripe");
    const data = await handleAdminSyncStripeAccounts(env);
    return corsJson(data);
  }

  // GET /admin/creators — paginated list
  if (request.method === "GET" && pathname === "/admin/creators") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const { handleAdminCreatorsList } = await import("./admin/creators");
    const data = await handleAdminCreatorsList(env, url);
    return corsJson(data);
  }

  // GET /admin/creators/:id — detail
  if (request.method === "GET" && pathname.startsWith("/admin/creators/")) {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const idStr = pathname.slice("/admin/creators/".length);
    const id = Number(idStr);
    if (!id || Number.isNaN(id)) {
      return corsJson({ error: "invalid_id" }, 400);
    }
    const { handleAdminCreatorDetail } = await import("./admin/creators");
    const data = await handleAdminCreatorDetail(env, id);
    if (!data.creator) return corsJson({ error: "not_found" }, 404);
    return corsJson(data);
  }

  // GET /admin/referral-codes — list codes with stats
  if (request.method === "GET" && pathname === "/admin/referral-codes") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const { handleListReferralCodes } = await import("./admin/referralCodes");
    const data = await handleListReferralCodes(env);
    return corsJson(data);
  }

  // POST /admin/referral-codes — create new code
  if (request.method === "POST" && pathname === "/admin/referral-codes") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    let body: any = {};
    try { body = await request.json(); } catch { /* ignore */ }
    const adminSession = await getAdminSessionFromRequest(env, request);
    const { handleCreateReferralCode } = await import("./admin/referralCodes");
    const result = await handleCreateReferralCode(env, adminSession, body);
    if (!result.ok) return corsJson({ error: result.error }, result.status);
    return corsJson({ ok: true, id: result.id, code: result.code });
  }

  // PATCH /admin/referral-codes/:id — toggle is_active
  if (request.method === "PATCH" && pathname.startsWith("/admin/referral-codes/")) {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const idStr = pathname.slice("/admin/referral-codes/".length);
    const id = Number(idStr);
    if (!id || Number.isNaN(id)) {
      return corsJson({ error: "invalid_id" }, 400);
    }
    let body: any = {};
    try { body = await request.json(); } catch { /* ignore */ }
    const isActive = !!Number(body?.is_active);
    const { handleToggleReferralCode } = await import("./admin/referralCodes");
    await handleToggleReferralCode(env, id, isActive);
    return corsJson({ ok: true });
  }

  // GET /admin/settings/tips — current tip min/max/presets
  if (request.method === "GET" && pathname === "/admin/settings/tips") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const { getTipsSettings } = await import("./settings");
    const data = await getTipsSettings(env);
    return corsJson(data);
  }

  // PUT /admin/settings/tips — update tip min/max/presets
  if (request.method === "PUT" && pathname === "/admin/settings/tips") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    let body: any = {};
    try { body = await request.json(); } catch { /* ignore */ }
    const { validateTipsSettings, setTipsSettings, getTipsSettings } = await import("./settings");
    const validationError = validateTipsSettings(body);
    if (validationError) {
      return corsJson({ error: "invalid_request", message: validationError }, 400);
    }
    await setTipsSettings(env, {
      min_nok: Number(body.min_nok),
      max_nok: Number(body.max_nok),
      presets: (body.presets as number[]).map((p) => Number(p)),
    });
    const fresh = await getTipsSettings(env);
    return corsJson({ ok: true, settings: fresh });
  }

  // POST /admin/test-email — send a test email to verify Resend integration
  if (request.method === "POST" && pathname === "/admin/test-email") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    let body: any = {};
    try { body = await request.json(); } catch { /* ignore */ }
    const to = String(body?.to ?? "").trim();
    if (!to || !to.includes("@")) {
      return corsJson({ error: "invalid_request", message: "to (email address) is required" }, 400);
    }
    const { sendEmail } = await import("./email");
    const ok = await sendEmail(env.RESEND_API_KEY, {
      to,
      subject: "KunTips email test ✅",
      html: `<p style="font-family:sans-serif;">This is a test email from the KunTips Worker.<br>If you received this, Resend is working correctly.</p>`,
    });
    return corsJson({ ok, to }, ok ? 200 : 500);
  }

  // POST /admin/resend-payout-email — resend payout confirmation email
  if (request.method === "POST" && pathname === "/admin/resend-payout-email") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    let body: any = {};
    try { body = await request.json(); } catch { /* ignore */ }
    const payoutId = Number(body?.payoutId);
    const creatorId = Number(body?.creatorId);
    if (!payoutId || !creatorId) {
      return corsJson({ error: "invalid_request", message: "payoutId and creatorId required" }, 400);
    }
    const { sendPayoutConfirmationEmail } = await import("./payouts/payoutEmail");
    try {
      await sendPayoutConfirmationEmail(env, payoutId, creatorId);
      return corsJson({ ok: true, payoutId, creatorId }, 200);
    } catch (err: any) {
      return corsJson({ ok: false, error: err?.message ?? "unknown" }, 500);
    }
  }

  // POST /admin/platform-event — activate a global tier boost for all creators
  if (request.method === "POST" && pathname === "/admin/platform-event") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    let body: any = {};
    try { body = await request.json(); } catch { /* ignore */ }
    const boostTiers = Number(body?.boost_tiers);
    const expiresAt = String(body?.expires_at ?? "");
    const label = String(body?.label ?? "");
    if (!boostTiers || boostTiers < 1 || !expiresAt) {
      return corsJson({ error: "invalid_request", message: "boost_tiers (≥1) and expires_at (ISO string) are required" }, 400);
    }
    const event = { boost_tiers: boostTiers, expires_at: expiresAt, label };
    await env.kuntips_rl.put("event:platform", JSON.stringify(event));
    return corsJson({ ok: true, event });
  }

  // DELETE /admin/platform-event — deactivate the global tier boost
  if (request.method === "DELETE" && pathname === "/admin/platform-event") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    await env.kuntips_rl.delete("event:platform");
    return corsJson({ ok: true, message: "Platform event cleared" });
  }

  // GET /admin/platform-event — check current active event
  if (request.method === "GET" && pathname === "/admin/platform-event") {
    if (!(await isAdminAuthed(env, request))) {
      return corsJson({ error: "unauthorized" }, 401);
    }
    const raw = await env.kuntips_rl.get("event:platform");
    if (!raw) return corsJson({ active: false });
    const event = JSON.parse(raw);
    const expired = new Date(event.expires_at) < new Date();
    return corsJson({ active: !expired, event });
  }

  return corsJson({ error: "not_found" }, 404);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const response = await route(request, env, ctx);

    // Restrict CORS to the configured frontend origin.
    // Falls back to wildcard if FRONTEND_BASE_URL is not set (e.g. local dev without wrangler.toml).
    const requestOrigin = request.headers.get("Origin") ?? "";
    const allowedOrigin = env.FRONTEND_BASE_URL;
    const newHeaders = new Headers(response.headers);

    if (!allowedOrigin) {
      // Not configured — keep the existing wildcard header unchanged
    } else if (requestOrigin && requestOrigin === allowedOrigin) {
      newHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
    } else {
      newHeaders.delete("Access-Control-Allow-Origin");
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil((async () => {
      const rows = await env.kuntips_db
        .prepare(`SELECT id FROM creators`)
        .all<{ id: number }>();
      for (const row of rows.results ?? []) {
        await applyDailyTierDowngrade(env.kuntips_db, row.id);
      }
    })());
  },
};
