// src/email.ts
// Sends transactional email via Resend (https://resend.com)
// Set API key via: wrangler secret put RESEND_API_KEY

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

/**
 * Send a transactional email via Resend.
 * Returns true on success, false on failure (never throws — email errors are non-fatal).
 */
export async function sendEmail(
  apiKey: string | undefined,
  payload: EmailPayload,
): Promise<boolean> {
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping email send.");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "KunTips <no-reply@kuntips.no>",
        to: [payload.to],
        reply_to: payload.replyTo ?? "support@kuntips.no",
        subject: payload.subject,
        html: payload.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      console.error(`[email] Resend error ${res.status}: ${body}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[email] Failed to send email:", err);
    return false;
  }
}

/** Format øre (minor units) as "1 234 NOK" */
export function formatNok(minor: number): string {
  const nok = Math.round(minor / 100);
  return nok.toLocaleString("nb-NO") + " NOK";
}

/** Format an ISO datetime string as "31. mars 2026, 14:22" (Norwegian) */
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("nb-NO", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Oslo",
    });
  } catch {
    return iso;
  }
}
