// src/payouts/payoutEmail.ts
// Sends a payout confirmation email to the creator when a payout is initiated.

import type { Env } from "../env";
import { sendEmail, formatNok, formatDate } from "../email";
import { getPayoutStatement, payoutReference } from "./payoutStatement";

export async function sendPayoutConfirmationEmail(
  env: Env,
  payoutId: number,
  creatorId: number,
): Promise<void> {

  // Get creator email
  const creatorRow = await env.kuntips_db
    .prepare(
      `SELECT email, display_name, username FROM creators WHERE id = ? LIMIT 1`,
    )
    .bind(creatorId)
    .first<{ email: string | null; display_name: string | null; username: string }>();

  if (!creatorRow?.email) {
    console.warn(`[payoutEmail] No email for creator ${creatorId}, skipping.`);
    return;
  }

  const statement = await getPayoutStatement(env, payoutId, creatorId);
  if (!statement) {
    console.warn(`[payoutEmail] No statement found for payout ${payoutId}, skipping.`);
    return;
  }

  const displayName = creatorRow.display_name ?? creatorRow.username;
  const reference = statement.reference;
  const payoutNok = Math.round(statement.payoutAmountMinor / 100);
  const debtNok = Math.round(statement.debtAppliedMinor / 100);
  const dashboardUrl = `${env.FRONTEND_BASE_URL}/creators/dashboard?username=${encodeURIComponent(creatorRow.username)}`;

  // Build tip rows for the email table
  const tipRows = statement.items
    .map(
      (item) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px;">
          ${formatDate(item.tippedAt)}
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:13px;">
          ${item.tipperName ? `<strong>${escHtml(item.tipperName)}</strong>` : '<em style="color:#64748b">Anonym</em>'}
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #1e293b;text-align:right;color:#e2e8f0;font-size:13px;">
          ${item.tipAmountNok} NOK
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #1e293b;text-align:right;color:#94a3b8;font-size:13px;">
          ${item.platformFeeNok} NOK
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #1e293b;text-align:right;color:#4ade80;font-size:13px;font-weight:600;">
          ${item.creatorNetNok} NOK
        </td>
      </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="no">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#6366f1,#38bdf8);padding:24px 28px;">
            <p style="margin:0;color:#fff;font-size:20px;font-weight:700;">KunTips</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Utbetalingsbekreftelse</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px;">
            <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Hei,</p>
            <p style="margin:0 0 20px;color:#e2e8f0;font-size:15px;">
              <strong>${escHtml(displayName)}</strong> – det er bestilt en utbetaling fra KunTips-kontoen din.
            </p>

            <!-- Summary box -->
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="background:#0f172a;border-radius:8px;border:1px solid #334155;margin-bottom:24px;">
              <tr>
                <td style="padding:16px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="color:#94a3b8;font-size:13px;padding-bottom:8px;">Referanse</td>
                      <td style="text-align:right;color:#e2e8f0;font-size:13px;font-weight:600;padding-bottom:8px;">
                        ${reference}
                      </td>
                    </tr>
                    <tr>
                      <td style="color:#94a3b8;font-size:13px;padding-bottom:8px;">Antall tips</td>
                      <td style="text-align:right;color:#e2e8f0;font-size:13px;padding-bottom:8px;">
                        ${statement.tipCount}
                      </td>
                    </tr>
                    ${debtNok > 0 ? `
                    <tr>
                      <td style="color:#94a3b8;font-size:13px;padding-bottom:8px;">Skyldig beløp fratrukket</td>
                      <td style="text-align:right;color:#f97316;font-size:13px;padding-bottom:8px;">
                        −${debtNok} NOK
                      </td>
                    </tr>` : ""}
                    <tr>
                      <td style="border-top:1px solid #334155;padding-top:8px;color:#e2e8f0;font-size:14px;font-weight:600;">
                        Utbetalt beløp
                      </td>
                      <td style="border-top:1px solid #334155;padding-top:8px;text-align:right;
                                 color:#4ade80;font-size:16px;font-weight:700;">
                        ${payoutNok} NOK
                      </td>
                    </tr>
                    ${statement.stripePayoutId ? `
                    <tr>
                      <td colspan="2" style="padding-top:8px;color:#64748b;font-size:11px;">
                        Stripe payout ID: ${escHtml(statement.stripePayoutId)}
                      </td>
                    </tr>` : ""}
                  </table>
                </td>
              </tr>
            </table>

            <!-- Tips table -->
            ${statement.items.length > 0 ? `
            <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">
              Included tips
            </p>
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="background:#0f172a;border-radius:8px;border:1px solid #334155;margin-bottom:24px;overflow:hidden;">
              <thead>
                <tr style="background:#1e293b;">
                  <th style="padding:8px;text-align:left;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;">Date</th>
                  <th style="padding:8px;text-align:left;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;">From</th>
                  <th style="padding:8px;text-align:right;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;">Tip</th>
                  <th style="padding:8px;text-align:right;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;">Fee</th>
                  <th style="padding:8px;text-align:right;color:#64748b;font-size:11px;font-weight:600;text-transform:uppercase;">You get</th>
                </tr>
              </thead>
              <tbody>${tipRows}</tbody>
            </table>` : ""}

            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
              <tr>
                <td align="center">
                  <a href="${dashboardUrl}"
                     style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;
                            padding:12px 28px;border-radius:999px;font-size:14px;font-weight:600;">
                    View dashboard
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;">
              The funds will arrive in your connected bank account within 2–5 business days
              depending on your bank. If you have questions, contact us at
              <a href="mailto:support@kuntips.no" style="color:#818cf8;">support@kuntips.no</a>.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 28px;border-top:1px solid #334155;background:#0f172a;">
            <p style="margin:0;color:#475569;font-size:11px;text-align:center;">
              Eternal AS · Org.nr. 926462237 · Johan Berentsens vei 41, 5160 Laksevåg, Norway<br>
              This is an automated message from KunTips. Do not reply to this email.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sendEmail(env.RESEND_API_KEY, {
    to: creatorRow.email,
    subject: `Payout of ${payoutNok} NOK requested — KunTips (${reference})`,
    html,
  });
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
