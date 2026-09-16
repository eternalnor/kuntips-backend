// db/tips.ts
import type { Env } from "../env";

export type InsertTipRowData = {
  creatorId: number;
  tipAmountMinor: number;
  totalChargedMinor: number;
  platformFeeMinor: number;
  creatorNetMinor: number;
  currency: string;
  paymentIntentId: string;
  tipperName?: string | null;
};

export async function insertTipRow(env: Env, data: InsertTipRowData) {
  await env.kuntips_db
    .prepare(
      `INSERT INTO tips (
         creator_id,
         tip_amount_intended,
         total_charged,
         platform_fee_minor,
         creator_net_minor,
         currency,
         psp_tx_id,
         status,
         tipper_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      data.creatorId,
      data.tipAmountMinor,
      data.totalChargedMinor,
      data.platformFeeMinor,
      data.creatorNetMinor,
      data.currency,
      data.paymentIntentId,
      "created",
      data.tipperName ?? null,
    )
    .run();
}
