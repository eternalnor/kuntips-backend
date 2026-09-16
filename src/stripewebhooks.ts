// stripewebhooks.ts
import Stripe from "stripe";
import type { Env } from "./env";
import { getStripe } from "./stripeClient";
import {
	updateTipStatusByPaymentIntentId,
	setTipDisputeOpen,
	setTipDisputeFinalStatus,
} from "./stripe";

import {
  	getCreatorByUsername,
	createCreator,
  	updateCreatorStripeAccount,
} from "./db/creators";
import { applyInstantTierUpgrade } from "./tier";

// Use the Worker crypto implementation
const webCryptoProvider = Stripe.createSubtleCryptoProvider();

// Stripe's dispute fee for Norwegian accounts (200 NOK in minor units)
const DISPUTE_FEE_MINOR_NOK = 20000;

// ========================= helper functions ===================== //

async function backfillTipTransferIdByChargeId(params: {
  env: Env;
  chargeId: string;
  transferId: string;
}): Promise<void> {
  const { env, chargeId, transferId } = params;

  await env.kuntips_db
    .prepare(
      `
      UPDATE tips
      SET
        transfer_id = COALESCE(transfer_id, ?),
        updated_at = datetime('now')
      WHERE charge_id = ?
      `,
    )
    .bind(transferId, chargeId)
    .run();
}

async function getTipRowForPaymentIntentId(
  env: Env,
  paymentIntentId: string,
): Promise<
  | {
      id: number;
      creator_id: number;
      dispute_status: string | null;
    }
  | null
> {
  return (
    (await env.kuntips_db
      .prepare(
        `
        SELECT
          id,
          creator_id,
          dispute_status
        FROM tips
        WHERE psp_tx_id = ?
        LIMIT 1
        `,
      )
      .bind(paymentIntentId)
      .first()) ?? null
  );
}

async function upsertTipDisputeRow(params: {
  env: Env;
  disputeId: string;
  tipId: number;
  creatorId: number;
  paymentIntentId: string;
  status: string;
  amountMinor: number;
  feeMinor: number;
}): Promise<void> {
  const {
    env,
    disputeId,
    tipId,
    creatorId,
    paymentIntentId,
    status,
    amountMinor,
    feeMinor,
  } = params;

  await env.kuntips_db
    .prepare(
      `
      INSERT INTO tip_disputes (
        dispute_id,
        tip_id,
        creator_id,
        payment_intent_id,
        status,
        amount_minor,
        fee_minor,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(dispute_id) DO UPDATE SET
        tip_id = excluded.tip_id,
        creator_id = excluded.creator_id,
        payment_intent_id = excluded.payment_intent_id,
        status = excluded.status,
        amount_minor = excluded.amount_minor,
        fee_minor = excluded.fee_minor,
        updated_at = datetime('now')
      `,
    )
    .bind(
      disputeId,
      tipId,
      creatorId,
      paymentIntentId,
      status,
      amountMinor,
      feeMinor,
    )
    .run();
}

async function getTipDisputeFeeAppliedMinor(
  env: Env,
  disputeId: string,
): Promise<number> {
  const row = await env.kuntips_db
    .prepare(
      `
      SELECT fee_applied_minor
      FROM tip_disputes
      WHERE dispute_id = ?
      LIMIT 1
      `,
    )
    .bind(disputeId)
    .first<{ fee_applied_minor: number }>();

  return row?.fee_applied_minor ?? 0;
}

async function getTipDisputePrincipalAppliedMinor(
  env: Env,
  disputeId: string,
): Promise<number> {
  const row = await env.kuntips_db
    .prepare(
      `
      SELECT principal_applied_minor
      FROM tip_disputes
      WHERE dispute_id = ?
      LIMIT 1
      `,
    )
    .bind(disputeId)
    .first<{ principal_applied_minor: number }>();

  return row?.principal_applied_minor ?? 0;
}

async function syncTipDisputePrincipalSummary(params: {
  env: Env;
  tipId: number;
}): Promise<void> {
  const { env, tipId } = params;

  // Keep tips.* summary fields in sync with tip_disputes (handles multiple disputes per tip)
  await env.kuntips_db
    .prepare(
      `
      UPDATE tips
      SET
        dispute_principal_applied_minor = COALESCE(
          (
            SELECT SUM(COALESCE(td.principal_applied_minor, 0))
            FROM tip_disputes td
            WHERE td.tip_id = tips.id
          ),
          0
        ),
        dispute_principal_applied_at = (
          SELECT MAX(td.principal_applied_at)
          FROM tip_disputes td
          WHERE td.tip_id = tips.id
            AND td.principal_applied_at IS NOT NULL
        ),
        updated_at = datetime('now')
      WHERE id = ?
      `,
    )
    .bind(tipId)
    .run();
}


// ==================================== End of helper functions ================= //

export async function handleStripeWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const stripe = getStripe(env);

  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const payload = await request.text();

  // We use the same worker URL for two Stripe webhook destinations:
  //  1) platform events (STRIPE_WEBHOOK_SECRET)
  //  2) connected-account events (STRIPE_WEBHOOK_CONNECT_SECRET) — e.g. payout.paid
  // Try each secret in turn; whichever verifies first wins.
  let event: Stripe.Event | null = null;
  let lastErr: any = null;
  const secrets = [
    env.STRIPE_WEBHOOK_SECRET,
    env.STRIPE_WEBHOOK_CONNECT_SECRET,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  for (const secret of secrets) {
    try {
      event = await stripe.webhooks.constructEventAsync(
        payload,
        sig,
        secret,
        undefined,
        webCryptoProvider,
      );
      break;
    } catch (err: any) {
      lastErr = err;
    }
  }

  if (!event) {
    console.error(
      "Stripe webhook signature verification failed",
      lastErr?.message ?? lastErr,
    );
    return new Response("Webhook signature verification failed", { status: 400 });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;

        // 1) Mark tip succeeded
        await updateTipStatusByPaymentIntentId(env, paymentIntent.id, "succeeded");

        // 1b) Server-side "Purchase" conversion (consent-gated, idempotent).
        //     Consent was captured at tip-creation and stored in PI metadata.
        //     KV marker keyed on the PI id prevents double-firing on redelivery.
        try {
          const consent = paymentIntent.metadata?.kuntips_consent === "1";
          if (consent) {
            const markerKey = `capi:sent:${paymentIntent.id}`;
            const already = await env.kuntips_rl.get(markerKey);
            if (!already) {
              await env.kuntips_rl.put(markerKey, "1", { expirationTtl: 604800 });
              const tipMinor = Number(
                paymentIntent.metadata?.tip_amount_intended_minor ?? 0,
              );
              const valueNok = tipMinor > 0 ? Math.round(tipMinor / 100) : 0;
              const purchaseTask = (async () => {
                const { firePurchase } = await import("./tracking");
                await firePurchase(env, {
                  eventId: paymentIntent.id,
                  valueNok,
                  currency: "NOK",
                  email: paymentIntent.receipt_email ?? null,
                });
              })().catch((err) =>
                console.error("[webhook] firePurchase failed:", err),
              );
              if (ctx) ctx.waitUntil(purchaseTask);
              else await purchaseTask;
            }
          }
        } catch (err) {
          console.error("[webhook] purchase tracking failed:", err);
        }

        // 2) Best-effort: persist charge_id + transfer_id
        try {
          const fullPI = await stripe.paymentIntents.retrieve(paymentIntent.id, {
            expand: ["latest_charge"],
          });

          const latestChargeId =
            typeof fullPI.latest_charge === "string"
              ? fullPI.latest_charge
              : fullPI.latest_charge?.id ?? null;

          if (!latestChargeId) {
            console.warn(
              "[payment_intent.succeeded] No latest_charge yet",
              paymentIntent.id,
            );
          } else {
            const charge = await stripe.charges.retrieve(latestChargeId, {
              expand: ["transfer"],
            });

            const chargeId = charge.id;
            const transferId =
              typeof charge.transfer === "string"
                ? charge.transfer
                : charge.transfer?.id ?? null;

            await env.kuntips_db
              .prepare(
                `
                UPDATE tips
                SET
                  charge_id = COALESCE(charge_id, ?),
                  transfer_id = COALESCE(transfer_id, ?),
                  updated_at = datetime('now')
                WHERE psp_tx_id = ?
                `,
              )
              .bind(chargeId, transferId, paymentIntent.id)
              .run();
          }
        } catch (e: any) {
          console.warn(
            "[payment_intent.succeeded] Failed to persist charge/transfer ids",
            e?.message ?? e,
          );
        }

        // 1b) Persist platform_fee_minor + creator_net_minor (idempotent)
        const platformFeeMinor = Number(paymentIntent.metadata?.platform_fee_minor ?? 0);

        if (Number.isFinite(platformFeeMinor) && platformFeeMinor >= 0) {
          await env.kuntips_db
            .prepare(
              `
              UPDATE tips
              SET
                platform_fee_minor = CASE
                  WHEN platform_fee_minor IS NULL OR platform_fee_minor = 0 THEN ?
                  ELSE platform_fee_minor
                END,
                creator_net_minor = CASE
                  WHEN creator_net_minor IS NULL OR creator_net_minor = 0 THEN MAX(0, total_charged - ?)
                  ELSE creator_net_minor
                END,
                updated_at = datetime('now')
              WHERE psp_tx_id = ?
              `,
            )
            .bind(platformFeeMinor, platformFeeMinor, paymentIntent.id)
            .run();
        }

        // 2) Apply planned debt recoup (idempotent, correct, no over-recoup)
        const plannedRecoupMinor = Number(paymentIntent.metadata?.recoup_debt_minor ?? 0);

        if (Number.isFinite(plannedRecoupMinor) && plannedRecoupMinor > 0) {
          const tipRow = await env.kuntips_db
            .prepare(
              `
              SELECT id, creator_id, recouped_debt_minor
              FROM tips
              WHERE psp_tx_id = ?
              LIMIT 1
              `,
            )
            .bind(paymentIntent.id)
            .first<{ id: number; creator_id: number; recouped_debt_minor: number }>();

          if (tipRow?.id && tipRow.creator_id) {
            const already = tipRow.recouped_debt_minor ?? 0;
            const remainingPlanned = Math.max(0, plannedRecoupMinor - already);

            if (remainingPlanned > 0) {
              const creatorRow = await env.kuntips_db
                .prepare(
                  `
                  SELECT creator_debt_minor
                  FROM creators
                  WHERE id = ?
                  LIMIT 1
                  `,
                )
                .bind(tipRow.creator_id)
                .first<{ creator_debt_minor: number }>();

              const currentDebt = creatorRow?.creator_debt_minor ?? 0;

              const applyNow = Math.max(
                0,
                Math.min(currentDebt, remainingPlanned),
              );

              if (applyNow > 0) {
                await env.kuntips_db.batch([
                  env.kuntips_db
                    .prepare(
                      `
                      UPDATE creators
                      SET creator_debt_minor = creator_debt_minor - ?
                      WHERE id = ?
                      `,
                    )
                    .bind(applyNow, tipRow.creator_id),

                  env.kuntips_db
                    .prepare(
                      `
                      UPDATE tips
                      SET recouped_debt_minor = recouped_debt_minor + ?
                      WHERE id = ?
                      `,
                    )
                    .bind(applyNow, tipRow.id),
                ]);
              }
            }
          }
        }

        // 3) Tier update
        const creatorId = Number(paymentIntent.metadata?.kuntips_creator_id ?? 0);
        if (creatorId > 0) {
          await applyInstantTierUpgrade(env.kuntips_db, creatorId);
        }

        break;
      }

      // ------------- Charge Succeeded

      case "charge.succeeded": {
        const charge = event.data.object as Stripe.Charge;

        const pi =
          charge.payment_intent as string | Stripe.PaymentIntent | null | undefined;
        const paymentIntentId =
          typeof pi === "string" ? pi : pi && typeof pi === "object" ? pi.id : null;

        if (!paymentIntentId) break;

        const transferId =
          typeof charge.transfer === "string"
            ? charge.transfer
            : (charge.transfer as any)?.id ?? null;

        await env.kuntips_db
          .prepare(
            `
            UPDATE tips
            SET
              charge_id = COALESCE(charge_id, ?),
              transfer_id = COALESCE(transfer_id, ?),
              updated_at = datetime('now')
            WHERE psp_tx_id = ?
            `,
          )
          .bind(charge.id, transferId, paymentIntentId)
          .run();

        break;
      }

      case "transfer.created":
      case "transfer.updated": {
        const transfer = event.data.object as Stripe.Transfer;

        const transferId = transfer.id;

        const sourceTx =
          typeof (transfer as any).source_transaction === "string"
            ? (transfer as any).source_transaction
            : null;

        if (!sourceTx) {
          console.warn(
            `[${event.type}] transfer without source_transaction; cannot map to tip`,
            transferId,
          );
          break;
        }

        await backfillTipTransferIdByChargeId({
          env,
          chargeId: sourceTx,
          transferId,
        });

        break;
      }

      //
      // 2) TIP FAILED / CANCELED
      //
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await updateTipStatusByPaymentIntentId(env, paymentIntent.id, "failed");
        break;
      }

      //
      // 3) REFUND CREATED (detailed info from Stripe.Refund)
      //
      case "refund.created": {
        const refund = event.data.object as Stripe.Refund;

        const pi = refund.payment_intent as
          | string
          | Stripe.PaymentIntent
          | null
          | undefined;

        const paymentIntentId =
          typeof pi === "string" ? pi : pi && typeof pi === "object" ? pi.id : null;

        if (!paymentIntentId) {
          console.warn(
            "[Stripe webhook] refund.created without payment_intent – cannot map to tip row",
          );
          break;
        }

        const amountMinor = typeof refund.amount === "number" ? refund.amount : undefined;
        const reason = refund.reason ?? null;
        const refundStatus = refund.status ?? null;
        const refundedAt = refund.created
          ? new Date(refund.created * 1000).toISOString()
          : new Date().toISOString();

        console.log(
          `[Stripe webhook] Refund ${refund.id} for payment_intent ${paymentIntentId} amount=${amountMinor} status=${refundStatus} reason=${reason}`,
        );

        await updateTipStatusByPaymentIntentId(env, paymentIntentId, "refunded", {
          refundAmountMinor: amountMinor,
          refundReason: reason,
          refundStatus,
          refundedAt,
        });

        break;
      }

      //
      // 4) CHARGE REFUNDED / REFUND UPDATED (fallback, uses Charge)
      //
      case "charge.refunded":
      case "charge.refund.updated": {
        const charge = event.data.object as Stripe.Charge;

        const pi = charge.payment_intent as
          | string
          | Stripe.PaymentIntent
          | null
          | undefined;

        const paymentIntentId =
          typeof pi === "string" ? pi : pi && typeof pi === "object" ? pi.id : null;

        if (!paymentIntentId) {
          console.warn(
            "[Stripe webhook] charge.refunded without payment_intent – cannot map to tip row",
          );
          break;
        }

        const totalRefundedMinor =
          typeof (charge as any).amount_refunded === "number"
            ? (charge as any).amount_refunded
            : undefined;

        const refundedAt = charge.created
          ? new Date(charge.created * 1000).toISOString()
          : undefined;

        console.log(
          `[Stripe webhook] charge.refunded for payment_intent ${paymentIntentId} amount_refunded=${totalRefundedMinor}`,
        );

        await updateTipStatusByPaymentIntentId(env, paymentIntentId, "refunded", {
          refundAmountMinor: totalRefundedMinor,
          // Do NOT touch refund_reason here; we let refund.created set it.
          refundStatus: charge.refunded ? "succeeded" : undefined,
          refundedAt,
        });

        break;
      }

      //
      //  HALFWAY MARK
      //

      //
      // 5) DISPUTE CREATED → dispute_open (NO debt mutation)
      //
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;

        const pi = dispute.payment_intent as
          | string
          | Stripe.PaymentIntent
          | null
          | undefined;

        const paymentIntentId =
          typeof pi === "string"
            ? pi
            : pi && typeof pi === "object"
              ? pi.id
              : null;

        if (!paymentIntentId) {
          console.warn(
            "[Stripe webhook] charge.dispute.created without payment_intent – cannot map to tip row",
          );
          break;
        }

        const disputeAmountMinor = dispute.amount ?? 0;

        console.log(
          `[Stripe webhook] Dispute created for payment_intent ${paymentIntentId} (dispute ${dispute.id}, status=${dispute.status}, amount=${disputeAmountMinor})`,
        );

        const tipRow = await getTipRowForPaymentIntentId(env, paymentIntentId);

        if (!tipRow) {
          console.warn(
            "[Stripe webhook] charge.dispute.created but no tip row found for payment_intent",
            paymentIntentId,
          );
          break;
        }

        await upsertTipDisputeRow({
          env,
          disputeId: dispute.id,
          tipId: tipRow.id,
          creatorId: tipRow.creator_id,
          paymentIntentId,
          status: "created",
          amountMinor: disputeAmountMinor,
          feeMinor: DISPUTE_FEE_MINOR_NOK,
        });

        await setTipDisputeOpen(
          env,
          paymentIntentId,
          disputeAmountMinor,
          DISPUTE_FEE_MINOR_NOK,
        );

        break;
      }

      //
      // 6) DISPUTE FUNDS WITHDRAWN → still open (NO debt mutation)
      //
      case "charge.dispute.funds_withdrawn": {
        const dispute = event.data.object as Stripe.Dispute;

        const pi = dispute.payment_intent as
          | string
          | Stripe.PaymentIntent
          | null
          | undefined;

        const paymentIntentId =
          typeof pi === "string"
            ? pi
            : pi && typeof pi === "object"
              ? pi.id
              : null;

        if (!paymentIntentId) {
          console.warn(
            "[Stripe webhook] charge.dispute.funds_withdrawn without payment_intent – cannot map to tip row",
          );
          break;
        }

        const disputeAmountMinor = dispute.amount ?? 0;

        console.log(
          `[Stripe webhook] Dispute funds withdrawn for payment_intent ${paymentIntentId} (dispute ${dispute.id}, amount=${disputeAmountMinor})`,
        );

        const tipRow = await getTipRowForPaymentIntentId(env, paymentIntentId);

        if (!tipRow) {
          console.warn(
            "[Stripe webhook] charge.dispute.funds_withdrawn but no tip row found for payment_intent",
            paymentIntentId,
          );
          break;
        }

        await upsertTipDisputeRow({
          env,
          disputeId: dispute.id,
          tipId: tipRow.id,
          creatorId: tipRow.creator_id,
          paymentIntentId,
          status: "funds_withdrawn",
          amountMinor: disputeAmountMinor,
          feeMinor: DISPUTE_FEE_MINOR_NOK,
        });

        await setTipDisputeOpen(
          env,
          paymentIntentId,
          disputeAmountMinor,
          DISPUTE_FEE_MINOR_NOK,
        );

        break;
      }

      //
      // 7) DISPUTE FUNDS REINSTATED → still open (NO debt mutation)
      //
      case "charge.dispute.funds_reinstated": {
        const dispute = event.data.object as Stripe.Dispute;

        const pi = dispute.payment_intent as
          | string
          | Stripe.PaymentIntent
          | null
          | undefined;

        const paymentIntentId =
          typeof pi === "string"
            ? pi
            : pi && typeof pi === "object"
              ? pi.id
              : null;

        if (!paymentIntentId) {
          console.warn(
            "[Stripe webhook] charge.dispute.funds_reinstated without payment_intent – cannot map to tip row",
          );
          break;
        }

        const disputeAmountMinor = dispute.amount ?? 0;

        console.log(
          `[Stripe webhook] Dispute funds reinstated for payment_intent ${paymentIntentId} (dispute ${dispute.id})`,
        );

        const tipRow = await getTipRowForPaymentIntentId(env, paymentIntentId);

        if (!tipRow) {
          console.warn(
            "[Stripe webhook] charge.dispute.funds_reinstated but no tip row found for payment_intent",
            paymentIntentId,
          );
          break;
        }

        await upsertTipDisputeRow({
          env,
          disputeId: dispute.id,
          tipId: tipRow.id,
          creatorId: tipRow.creator_id,
          paymentIntentId,
          status: "funds_reinstated",
          amountMinor: disputeAmountMinor,
          feeMinor: DISPUTE_FEE_MINOR_NOK,
        });

        // Keep tip state as open until final closed event
        await setTipDisputeOpen(
          env,
          paymentIntentId,
          disputeAmountMinor,
          DISPUTE_FEE_MINOR_NOK,
        );

        break;
      }

      //
      // 8) DISPUTE CLOSED → FINAL (apply debt here only, idempotent)
      //
      case "charge.dispute.closed": {
        const dispute = event.data.object as Stripe.Dispute;

        const pi = dispute.payment_intent as
          | string
          | Stripe.PaymentIntent
          | null
          | undefined;

        const paymentIntentId =
          typeof pi === "string"
            ? pi
            : pi && typeof pi === "object"
              ? pi.id
              : null;

        if (!paymentIntentId) {
          console.warn(
            "[Stripe webhook] charge.dispute.closed without payment_intent – cannot map to tip row",
          );
          break;
        }

        const disputeAmountMinor = dispute.amount ?? 0;

        const finalStatus =
          dispute.status === "won" ? "dispute_won" : "dispute_lost";

        console.log(
          `[Stripe webhook] Dispute closed for payment_intent ${paymentIntentId} (dispute ${dispute.id}, status=${dispute.status} -> ${finalStatus})`,
        );

        const tipRow = await getTipRowForPaymentIntentId(env, paymentIntentId);

        if (!tipRow) {
          console.warn(
            "[Stripe webhook] charge.dispute.closed but no tip row found for payment_intent",
            paymentIntentId,
          );
          break;
        }

        // Ensure dispute row exists and is updated with final state
        await upsertTipDisputeRow({
          env,
          disputeId: dispute.id,
          tipId: tipRow.id,
          creatorId: tipRow.creator_id,
          paymentIntentId,
          status: finalStatus === "dispute_won" ? "closed_won" : "closed_lost",
          amountMinor: disputeAmountMinor,
          feeMinor: DISPUTE_FEE_MINOR_NOK,
        });

        const feeAlreadyAppliedMinor = await getTipDisputeFeeAppliedMinor(
          env,
          dispute.id,
        );

        const feeToApplyMinor =
          feeAlreadyAppliedMinor > 0 ? 0 : DISPUTE_FEE_MINOR_NOK;

        const principalAlreadyAppliedMinor =
          await getTipDisputePrincipalAppliedMinor(env, dispute.id);

        const principalToApplyMinor =
          finalStatus === "dispute_lost" && principalAlreadyAppliedMinor === 0
            ? disputeAmountMinor
            : 0;

        const debtToAddMinor = feeToApplyMinor + principalToApplyMinor;
        const nowIso = new Date().toISOString();

        // Note: avoid batching an empty array (some D1 runtimes throw on batch([]))
        const statements: D1PreparedStatement[] = [];

        // Mark principal applied once per dispute_id (lost only)
        if (principalToApplyMinor > 0) {
          statements.push(
            env.kuntips_db
              .prepare(
                `
                UPDATE tip_disputes
                SET
                  principal_applied_minor = ?,
                  principal_applied_at = ?,
                  updated_at = datetime('now')
                WHERE dispute_id = ?
                `,
              )
              .bind(principalToApplyMinor, nowIso, dispute.id),
          );
        }

        // Mark fee applied once per dispute_id (fees can stack across multiple disputes)
        if (feeToApplyMinor > 0) {
          statements.push(
            env.kuntips_db
              .prepare(
                `
                UPDATE tip_disputes
                SET
                  fee_applied_minor = ?,
                  fee_applied_at = ?,
                  updated_at = datetime('now')
                WHERE dispute_id = ?
                `,
              )
              .bind(feeToApplyMinor, nowIso, dispute.id),
          );
        }

        // Apply debt only if something is newly applied
        if (debtToAddMinor > 0) {
          statements.push(
            env.kuntips_db
              .prepare(
                `
                UPDATE creators
                SET creator_debt_minor = creator_debt_minor + ?
                WHERE id = ?
                `,
              )
              .bind(debtToAddMinor, tipRow.creator_id),
          );
        }

        if (statements.length > 0) {
          await env.kuntips_db.batch(statements);

		  await syncTipDisputePrincipalSummary({ env, tipId: tipRow.id });
        }



        await setTipDisputeFinalStatus(env, paymentIntentId, finalStatus);

        console.log(
          `[Stripe webhook] Dispute finalized: feeToApply=${feeToApplyMinor}, principalToApply=${principalToApplyMinor}, totalDebtAdded=${debtToAddMinor} (creator=${tipRow.creator_id}, dispute=${dispute.id})`,
        );

        break;
      }

      case "transfer.reversed": {
        const obj: any = event.data.object;

        // Stripe can deliver either:
        // - a TransferReversal object (id starts with "trr_", has .transfer)
        // - or a Transfer object (id starts with "tr_", has .reversals / etc)
        const isReversal = typeof obj?.transfer !== "undefined"; // TransferReversal has `transfer`
        const isTransfer = typeof obj?.reversals !== "undefined"; // Transfer has `reversals`

        let transferId: string | null = null;
        let reversalId: string | null = null;
        let amountMinor: number = 0;

        if (isReversal) {
          // TransferReversal shape
          reversalId = typeof obj.id === "string" ? obj.id : null;
          transferId =
            typeof obj.transfer === "string" ? obj.transfer : obj.transfer?.id ?? null;

          amountMinor = typeof obj.amount === "number" ? obj.amount : 0;
        } else if (isTransfer) {
          // Transfer shape (fallback)
          transferId = typeof obj.id === "string" ? obj.id : null;

          // If Stripe included the reversal list, take the newest entry
          const reversals = obj.reversals?.data;
          if (Array.isArray(reversals) && reversals.length > 0) {
            const latest = reversals[0];
            reversalId = typeof latest.id === "string" ? latest.id : null;
            amountMinor = typeof latest.amount === "number" ? latest.amount : 0;
          }
        } else {
          console.warn(
            "[transfer.reversed] Unknown payload shape",
            JSON.stringify({ id: obj?.id, keys: Object.keys(obj ?? {}) }).slice(
              0,
              500,
            ),
          );
          break;
        }

        if (!transferId) {
          console.warn("[transfer.reversed] Missing transfer id", obj?.id);
          break;
        }

        // Find the tip by transfer_id
        const tip = await env.kuntips_db
          .prepare(
            `
            SELECT id, creator_id, psp_tx_id
            FROM tips
            WHERE transfer_id = ?
            LIMIT 1
            `,
          )
          .bind(transferId)
          .first<{ id: number; creator_id: number; psp_tx_id: string }>();

        if (!tip) {
          console.warn("[transfer.reversed] No tip found for transfer", transferId);
          break;
        }

        // If we didn't get a reversalId from payload, fetch ONE reversal record via API as a last resort
        if (!reversalId) {
          try {
            const fullTransfer = await stripe.transfers.retrieve(transferId, {
              expand: ["reversals"],
            });

            const r = fullTransfer.reversals?.data?.[0];
            reversalId = r?.id ?? null;
            amountMinor = typeof r?.amount === "number" ? r.amount : amountMinor;
          } catch (e: any) {
            console.warn(
              "[transfer.reversed] Could not fetch transfer reversals",
              transferId,
              e?.message ?? e,
            );
            break;
          }
        }

        if (!reversalId) {
          console.warn(
            "[transfer.reversed] Missing reversal id (cannot insert)",
            transferId,
          );
          break;
        }

        await env.kuntips_db
          .prepare(
            `
            INSERT INTO tip_transfer_reversals (
              transfer_reversal_id,
              transfer_id,
              tip_id,
              creator_id,
              payment_intent_id,
              amount_minor
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(transfer_reversal_id) DO NOTHING
            `,
          )
          .bind(
            reversalId,
            transferId,
            tip.id,
            tip.creator_id,
            tip.psp_tx_id,
            amountMinor,
          )
          .run();

        console.log(
          `[transfer.reversed] Recorded reversal ${reversalId} for transfer ${transferId} amount_minor=${amountMinor} tip_id=${tip.id}`,
        );

        break;
      }

      //
      // CONNECTED ACCOUNT STATE //

      // Fires on the CONNECTED account (Connect webhook) whenever Stripe
      // updates capabilities — i.e. when a creator actually finishes, or
      // partially finishes, onboarding. This is what makes
      // "Stripe connected" mean something.
      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        try {
          const {
            readAccountState,
            persistAccountState,
            findCreatorIdByStripeAccount,
          } = await import("./db/stripeAccountState");

          const creatorId = await findCreatorIdByStripeAccount(env, account.id);
          if (!creatorId) {
            console.warn(
              `[account.updated] No creator for Stripe account ${account.id}`,
            );
            break;
          }

          // Read BEFORE persisting: `stripe_onboarding_completed_at` is NULL
          // until the first time transfers goes active, so a NULL here plus an
          // active capability below is exactly the 0→1 transition. After the
          // persist it is set, so redeliveries of this event cannot re-fire.
          const before = (await env.kuntips_db
            .prepare(
              `SELECT email, marketing_consent, stripe_onboarding_completed_at
                 FROM creators WHERE id = ? LIMIT 1`,
            )
            .bind(creatorId)
            .first()) as {
            email: string | null;
            marketing_consent: number;
            stripe_onboarding_completed_at: string | null;
          } | null;

          const state = readAccountState(account);
          await persistAccountState(env, creatorId, state);
          console.log(
            `[account.updated] creator=${creatorId} charges=${state.chargesEnabled} payouts=${state.payoutsEnabled} details=${state.detailsSubmitted} due=${state.requirementsDue.length}`,
          );

          // The conversion that actually means something: this creator can now
          // receive money. Gated on stored consent, since there is no browser
          // here to ask.
          const justWentLive =
            state.transfersActive &&
            before != null &&
            before.stripe_onboarding_completed_at == null;

          if (justWentLive && before?.marketing_consent === 1) {
            try {
              const { fireCreatorLive } = await import("./tracking");
              // Deterministic id: if Stripe redelivers this event, Meta dedupes
              // it on their side rather than counting a second conversion.
              await fireCreatorLive(env, {
                eventId: `creatorlive-${creatorId}`,
                email: before.email ?? undefined,
              }).catch((err) =>
                console.error("[account.updated] fireCreatorLive failed:", err),
              );
            } catch (err) {
              console.error("[account.updated] tracking import failed:", err);
            }
          }
        } catch (err) {
          console.error("[account.updated] failed:", err);
        }
        break;
      }

	  //
	  // PAYOUT CASES //


      case "payout.paid": {
        const payout = event.data.object as Stripe.Payout;

        const payoutIdFromMeta = Number(payout.metadata?.kuntips_payout_id ?? 0);

        if (payoutIdFromMeta > 0) {
          await env.kuntips_db
            .prepare(
              `
              UPDATE payouts
              SET
                status = 'paid',
                paid_at = datetime('now'),
                updated_at = datetime('now')
              WHERE id = ?
              `,
            )
            .bind(payoutIdFromMeta)
            .run();
        } else {
          await env.kuntips_db
            .prepare(
              `
              UPDATE payouts
              SET
                status = 'paid',
                paid_at = datetime('now'),
                updated_at = datetime('now')
              WHERE stripe_payout_id = ?
              `,
            )
            .bind(payout.id)
            .run();
        }

        break;
      }

      case "payout.failed":
      case "payout.canceled": {
        const payout = event.data.object as Stripe.Payout;

        const payoutIdFromMeta = Number(payout.metadata?.kuntips_payout_id ?? 0);
        const msg =
          (payout as any)?.failure_message ??
          (payout as any)?.status ??
          event.type;

        if (payoutIdFromMeta > 0) {
          await env.kuntips_db
            .prepare(
              `
              UPDATE payouts
              SET
                status = 'failed',
                failed_at = datetime('now'),
                failure_reason = ?,
                updated_at = datetime('now')
              WHERE id = ?
              `,
            )
            .bind(`stripe_${event.type}: ${String(msg)}`.slice(0, 400), payoutIdFromMeta)
            .run();
        } else {
          await env.kuntips_db
            .prepare(
              `
              UPDATE payouts
              SET
                status = 'failed',
                failed_at = datetime('now'),
                failure_reason = ?,
                updated_at = datetime('now')
              WHERE stripe_payout_id = ?
              `,
            )
            .bind(`stripe_${event.type}: ${String(msg)}`.slice(0, 400), payout.id)
            .run();
        }

        break;
      }






      //
      // 9) DEFAULT → log and ignore
      //
      default: {
        console.log(`Unhandled Stripe event type: ${event.type}`);
      }
    }
  } catch (err: any) {
    console.error(
      "Error while handling Stripe webhook event",
      event.type,
      err?.message ?? err,
    );

    return new Response("Webhook handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

