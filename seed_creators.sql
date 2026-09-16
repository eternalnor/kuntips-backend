-- KunTips seed creators (75 fake accounts for realistic percentile distribution)
-- Run once: npx wrangler d1 execute kuntips_db --remote --file seed_creators.sql
-- Remove when real creator count reaches 75: DELETE FROM creators WHERE is_seed = 1;

-- Tier 1 inactive pool (30 creators, 0–300 NOK/30d)
INSERT INTO creators (username, display_name, email, password_hash, is_active, current_tier, platform_fee_bps, is_seed) VALUES
('seed_c001','Seed Creator 1','seed001@example.com','x',1,1,500,1),
('seed_c002','Seed Creator 2','seed002@example.com','x',1,1,500,1),
('seed_c003','Seed Creator 3','seed003@example.com','x',1,1,500,1),
('seed_c004','Seed Creator 4','seed004@example.com','x',1,1,500,1),
('seed_c005','Seed Creator 5','seed005@example.com','x',1,1,500,1),
('seed_c006','Seed Creator 6','seed006@example.com','x',1,1,500,1),
('seed_c007','Seed Creator 7','seed007@example.com','x',1,1,500,1),
('seed_c008','Seed Creator 8','seed008@example.com','x',1,1,500,1),
('seed_c009','Seed Creator 9','seed009@example.com','x',1,1,500,1),
('seed_c010','Seed Creator 10','seed010@example.com','x',1,1,500,1),
('seed_c011','Seed Creator 11','seed011@example.com','x',1,1,500,1),
('seed_c012','Seed Creator 12','seed012@example.com','x',1,1,500,1),
('seed_c013','Seed Creator 13','seed013@example.com','x',1,1,500,1),
('seed_c014','Seed Creator 14','seed014@example.com','x',1,1,500,1),
('seed_c015','Seed Creator 15','seed015@example.com','x',1,1,500,1),
('seed_c016','Seed Creator 16','seed016@example.com','x',1,1,500,1),
('seed_c017','Seed Creator 17','seed017@example.com','x',1,1,500,1),
('seed_c018','Seed Creator 18','seed018@example.com','x',1,1,500,1),
('seed_c019','Seed Creator 19','seed019@example.com','x',1,1,500,1),
('seed_c020','Seed Creator 20','seed020@example.com','x',1,1,500,1),
('seed_c021','Seed Creator 21','seed021@example.com','x',1,1,500,1),
('seed_c022','Seed Creator 22','seed022@example.com','x',1,1,500,1),
('seed_c023','Seed Creator 23','seed023@example.com','x',1,1,500,1),
('seed_c024','Seed Creator 24','seed024@example.com','x',1,1,500,1),
('seed_c025','Seed Creator 25','seed025@example.com','x',1,1,500,1),
('seed_c026','Seed Creator 26','seed026@example.com','x',1,1,500,1),
('seed_c027','Seed Creator 27','seed027@example.com','x',1,1,500,1),
('seed_c028','Seed Creator 28','seed028@example.com','x',1,1,500,1),
('seed_c029','Seed Creator 29','seed029@example.com','x',1,1,500,1),
('seed_c030','Seed Creator 30','seed030@example.com','x',1,1,500,1);

-- Mid-low pool (20 creators, 300–1500 NOK/30d)
INSERT INTO creators (username, display_name, email, password_hash, is_active, current_tier, platform_fee_bps, is_seed) VALUES
('seed_c031','Seed Creator 31','seed031@example.com','x',1,1,500,1),
('seed_c032','Seed Creator 32','seed032@example.com','x',1,1,500,1),
('seed_c033','Seed Creator 33','seed033@example.com','x',1,1,500,1),
('seed_c034','Seed Creator 34','seed034@example.com','x',1,1,500,1),
('seed_c035','Seed Creator 35','seed035@example.com','x',1,1,500,1),
('seed_c036','Seed Creator 36','seed036@example.com','x',1,1,500,1),
('seed_c037','Seed Creator 37','seed037@example.com','x',1,1,500,1),
('seed_c038','Seed Creator 38','seed038@example.com','x',1,1,500,1),
('seed_c039','Seed Creator 39','seed039@example.com','x',1,1,500,1),
('seed_c040','Seed Creator 40','seed040@example.com','x',1,1,500,1),
('seed_c041','Seed Creator 41','seed041@example.com','x',1,1,500,1),
('seed_c042','Seed Creator 42','seed042@example.com','x',1,1,500,1),
('seed_c043','Seed Creator 43','seed043@example.com','x',1,1,500,1),
('seed_c044','Seed Creator 44','seed044@example.com','x',1,1,500,1),
('seed_c045','Seed Creator 45','seed045@example.com','x',1,1,500,1),
('seed_c046','Seed Creator 46','seed046@example.com','x',1,1,500,1),
('seed_c047','Seed Creator 47','seed047@example.com','x',1,1,500,1),
('seed_c048','Seed Creator 48','seed048@example.com','x',1,1,500,1),
('seed_c049','Seed Creator 49','seed049@example.com','x',1,1,500,1),
('seed_c050','Seed Creator 50','seed050@example.com','x',1,1,500,1);

-- Mid pool (15 creators, 1500–5000 NOK/30d)
INSERT INTO creators (username, display_name, email, password_hash, is_active, current_tier, platform_fee_bps, is_seed) VALUES
('seed_c051','Seed Creator 51','seed051@example.com','x',1,1,500,1),
('seed_c052','Seed Creator 52','seed052@example.com','x',1,1,500,1),
('seed_c053','Seed Creator 53','seed053@example.com','x',1,1,500,1),
('seed_c054','Seed Creator 54','seed054@example.com','x',1,1,500,1),
('seed_c055','Seed Creator 55','seed055@example.com','x',1,1,500,1),
('seed_c056','Seed Creator 56','seed056@example.com','x',1,1,500,1),
('seed_c057','Seed Creator 57','seed057@example.com','x',1,1,500,1),
('seed_c058','Seed Creator 58','seed058@example.com','x',1,1,500,1),
('seed_c059','Seed Creator 59','seed059@example.com','x',1,1,500,1),
('seed_c060','Seed Creator 60','seed060@example.com','x',1,1,500,1),
('seed_c061','Seed Creator 61','seed061@example.com','x',1,1,500,1),
('seed_c062','Seed Creator 62','seed062@example.com','x',1,1,500,1),
('seed_c063','Seed Creator 63','seed063@example.com','x',1,1,500,1),
('seed_c064','Seed Creator 64','seed064@example.com','x',1,1,500,1),
('seed_c065','Seed Creator 65','seed065@example.com','x',1,1,500,1);

-- High earners (7 creators, 5000–15000 NOK/30d)
INSERT INTO creators (username, display_name, email, password_hash, is_active, current_tier, platform_fee_bps, is_seed) VALUES
('seed_c066','Seed Creator 66','seed066@example.com','x',1,2,400,1),
('seed_c067','Seed Creator 67','seed067@example.com','x',1,2,400,1),
('seed_c068','Seed Creator 68','seed068@example.com','x',1,2,400,1),
('seed_c069','Seed Creator 69','seed069@example.com','x',1,2,400,1),
('seed_c070','Seed Creator 70','seed070@example.com','x',1,2,400,1),
('seed_c071','Seed Creator 71','seed071@example.com','x',1,2,400,1),
('seed_c072','Seed Creator 72','seed072@example.com','x',1,2,400,1);

-- Top earners (3 creators, 15000–40000 NOK/30d)
INSERT INTO creators (username, display_name, email, password_hash, is_active, current_tier, platform_fee_bps, is_seed) VALUES
('seed_c073','Seed Creator 73','seed073@example.com','x',1,3,300,1),
('seed_c074','Seed Creator 74','seed074@example.com','x',1,4,200,1),
('seed_c075','Seed Creator 75','seed075@example.com','x',1,4,200,1);

-- ── Seed tips (gives each creator realistic 30-day volume) ────────────────
-- Columns: creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at
-- Low pool: 0–300 NOK each (just a few small tips or none)
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 8000, 8000, 'NOK', 'seed_tx_001', 'succeeded', datetime('now', '-5 days') FROM creators WHERE username='seed_c001';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 15000, 15000, 'NOK', 'seed_tx_002', 'succeeded', datetime('now', '-12 days') FROM creators WHERE username='seed_c002';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 5000, 5000, 'NOK', 'seed_tx_003', 'succeeded', datetime('now', '-8 days') FROM creators WHERE username='seed_c003';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 20000, 20000, 'NOK', 'seed_tx_004', 'succeeded', datetime('now', '-3 days') FROM creators WHERE username='seed_c004';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 10000, 10000, 'NOK', 'seed_tx_005', 'succeeded', datetime('now', '-20 days') FROM creators WHERE username='seed_c005';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 25000, 25000, 'NOK', 'seed_tx_006', 'succeeded', datetime('now', '-7 days') FROM creators WHERE username='seed_c006';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 5000, 5000, 'NOK', 'seed_tx_007', 'succeeded', datetime('now', '-15 days') FROM creators WHERE username='seed_c007';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 30000, 30000, 'NOK', 'seed_tx_008', 'succeeded', datetime('now', '-2 days') FROM creators WHERE username='seed_c008';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 12000, 12000, 'NOK', 'seed_tx_009', 'succeeded', datetime('now', '-18 days') FROM creators WHERE username='seed_c009';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 7500, 7500, 'NOK', 'seed_tx_010', 'succeeded', datetime('now', '-25 days') FROM creators WHERE username='seed_c010';

-- Mid-low pool: 300–1500 NOK each
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 50000, 50000, 'NOK', 'seed_tx_031', 'succeeded', datetime('now', '-4 days') FROM creators WHERE username='seed_c031';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 75000, 75000, 'NOK', 'seed_tx_032', 'succeeded', datetime('now', '-9 days') FROM creators WHERE username='seed_c032';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 40000, 40000, 'NOK', 'seed_tx_033', 'succeeded', datetime('now', '-14 days') FROM creators WHERE username='seed_c033';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 90000, 90000, 'NOK', 'seed_tx_034', 'succeeded', datetime('now', '-6 days') FROM creators WHERE username='seed_c034';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 120000, 120000, 'NOK', 'seed_tx_035', 'succeeded', datetime('now', '-11 days') FROM creators WHERE username='seed_c035';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 60000, 60000, 'NOK', 'seed_tx_036', 'succeeded', datetime('now', '-22 days') FROM creators WHERE username='seed_c036';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 85000, 85000, 'NOK', 'seed_tx_037', 'succeeded', datetime('now', '-3 days') FROM creators WHERE username='seed_c037';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 100000, 100000, 'NOK', 'seed_tx_038', 'succeeded', datetime('now', '-16 days') FROM creators WHERE username='seed_c038';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 55000, 55000, 'NOK', 'seed_tx_039', 'succeeded', datetime('now', '-27 days') FROM creators WHERE username='seed_c039';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 145000, 145000, 'NOK', 'seed_tx_040', 'succeeded', datetime('now', '-5 days') FROM creators WHERE username='seed_c040';

-- Mid pool: 1500–5000 NOK each
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 200000, 200000, 'NOK', 'seed_tx_051', 'succeeded', datetime('now', '-8 days') FROM creators WHERE username='seed_c051';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 250000, 250000, 'NOK', 'seed_tx_052', 'succeeded', datetime('now', '-13 days') FROM creators WHERE username='seed_c052';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 180000, 180000, 'NOK', 'seed_tx_053', 'succeeded', datetime('now', '-4 days') FROM creators WHERE username='seed_c053';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 350000, 350000, 'NOK', 'seed_tx_054', 'succeeded', datetime('now', '-19 days') FROM creators WHERE username='seed_c054';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 420000, 420000, 'NOK', 'seed_tx_055', 'succeeded', datetime('now', '-7 days') FROM creators WHERE username='seed_c055';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 280000, 280000, 'NOK', 'seed_tx_056', 'succeeded', datetime('now', '-24 days') FROM creators WHERE username='seed_c056';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 500000, 500000, 'NOK', 'seed_tx_057', 'succeeded', datetime('now', '-2 days') FROM creators WHERE username='seed_c057';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 160000, 160000, 'NOK', 'seed_tx_058', 'succeeded', datetime('now', '-17 days') FROM creators WHERE username='seed_c058';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 390000, 390000, 'NOK', 'seed_tx_059', 'succeeded', datetime('now', '-10 days') FROM creators WHERE username='seed_c059';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 310000, 310000, 'NOK', 'seed_tx_060', 'succeeded', datetime('now', '-28 days') FROM creators WHERE username='seed_c060';

-- High earners: 5000–15000 NOK each
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 700000, 700000, 'NOK', 'seed_tx_066', 'succeeded', datetime('now', '-6 days') FROM creators WHERE username='seed_c066';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 900000, 900000, 'NOK', 'seed_tx_067', 'succeeded', datetime('now', '-12 days') FROM creators WHERE username='seed_c067';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 850000, 850000, 'NOK', 'seed_tx_068', 'succeeded', datetime('now', '-3 days') FROM creators WHERE username='seed_c068';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 1100000, 1100000, 'NOK', 'seed_tx_069', 'succeeded', datetime('now', '-9 days') FROM creators WHERE username='seed_c069';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 1300000, 1300000, 'NOK', 'seed_tx_070', 'succeeded', datetime('now', '-21 days') FROM creators WHERE username='seed_c070';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 600000, 600000, 'NOK', 'seed_tx_071', 'succeeded', datetime('now', '-15 days') FROM creators WHERE username='seed_c071';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 1050000, 1050000, 'NOK', 'seed_tx_072', 'succeeded', datetime('now', '-5 days') FROM creators WHERE username='seed_c072';

-- Top earners: 15000–40000 NOK each
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 2200000, 2200000, 'NOK', 'seed_tx_073', 'succeeded', datetime('now', '-4 days') FROM creators WHERE username='seed_c073';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 3500000, 3500000, 'NOK', 'seed_tx_074', 'succeeded', datetime('now', '-8 days') FROM creators WHERE username='seed_c074';
INSERT INTO tips (creator_id, tip_amount_intended, total_charged, currency, psp_tx_id, status, tipped_at)
SELECT id, 4000000, 4000000, 'NOK', 'seed_tx_075', 'succeeded', datetime('now', '-11 days') FROM creators WHERE username='seed_c075';
