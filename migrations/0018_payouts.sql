-- 0018_payouts.sql

CREATE TABLE payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  status TEXT NOT NULL, -- requested | processing | paid | failed | canceled
  currency TEXT NOT NULL DEFAULT 'NOK',

  -- what we intended to pay out from eligible tips (gross model per KunTips rules)
  eligible_amount_minor INTEGER NOT NULL DEFAULT 0,

  -- debt handling
  debt_before_minor INTEGER NOT NULL DEFAULT 0,
  debt_applied_minor INTEGER NOT NULL DEFAULT 0,

  -- what we actually attempted to pay (eligible - applied debt)
  payout_amount_minor INTEGER NOT NULL DEFAULT 0,

  -- stripe identifiers (optional but recommended)
  stripe_payout_id TEXT,
  stripe_balance_txn_id TEXT,

  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  paid_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

CREATE INDEX payouts_creator_status_idx ON payouts(creator_id, status);
CREATE INDEX payouts_creator_requested_idx ON payouts(creator_id, requested_at);

-- Which tips were included in a payout request (locks the set)
CREATE TABLE payout_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id INTEGER NOT NULL,
  tip_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  payment_intent_id TEXT NOT NULL,

  tip_amount_intended_minor INTEGER NOT NULL DEFAULT 0,
  total_charged_minor INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (payout_id) REFERENCES payouts(id),
  FOREIGN KEY (tip_id) REFERENCES tips(id),
  FOREIGN KEY (creator_id) REFERENCES creators(id),
  UNIQUE(payout_id, tip_id),
  UNIQUE(creator_id, tip_id)
);

-- Mark tips as already allocated to a payout
ALTER TABLE tips ADD COLUMN payout_id INTEGER;
CREATE INDEX tips_creator_payout_idx ON tips(creator_id, payout_id);
