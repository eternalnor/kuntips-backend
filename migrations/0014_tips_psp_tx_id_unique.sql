CREATE UNIQUE INDEX IF NOT EXISTS idx_tips_psp_tx_id_unique
ON tips(psp_tx_id);
