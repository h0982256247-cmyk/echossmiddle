-- ============================================================
-- rezio-bridge schema v2
-- Supabase Dashboard → SQL Editor 執行
-- ============================================================

-- 訂單主表
CREATE TABLE IF NOT EXISTS orders (
  id                  BIGSERIAL PRIMARY KEY,
  order_no            TEXT NOT NULL UNIQUE,
  customer_name       TEXT,
  phone               TEXT,
  email               TEXT,
  order_date          DATE,
  redeem_date         DATE,
  check_due_date      DATE,
  amount              NUMERIC(10, 2) NOT NULL DEFAULT 0,
  is_member_at_redeem BOOLEAN,
  points_issued       BOOLEAN NOT NULL DEFAULT FALSE,
  customer_notified   BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT '待核銷',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 週報佇列（核銷後7天仍未入會，結案後保留供週報寄出）
CREATE TABLE IF NOT EXISTS weekly_report_queue (
  id            BIGSERIAL PRIMARY KEY,
  order_no      TEXT NOT NULL UNIQUE,
  customer_name TEXT,
  phone         TEXT,
  email         TEXT,
  order_date    DATE,
  redeem_date   DATE,
  amount        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 發信排程狀態（永遠只有一列 id=1）
CREATE TABLE IF NOT EXISTS report_schedule (
  id           INT PRIMARY KEY DEFAULT 1,
  last_sent_at TIMESTAMPTZ
);

INSERT INTO report_schedule (id, last_sent_at)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Migration：已存在的資料庫執行以下語句補上 status 欄位
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT '待核銷';

-- 依現有欄位推算既有資料的狀態
UPDATE orders SET status = '待核銷' WHERE redeem_date IS NULL;
UPDATE orders SET status = '已發點'
  WHERE redeem_date IS NOT NULL AND is_member_at_redeem = TRUE AND points_issued = TRUE;
UPDATE orders SET status = '待複查'
  WHERE redeem_date IS NOT NULL AND is_member_at_redeem = FALSE
    AND check_due_date IS NOT NULL AND check_due_date > CURRENT_DATE;
UPDATE orders SET status = '已結案'
  WHERE redeem_date IS NOT NULL AND is_member_at_redeem = FALSE
    AND (check_due_date IS NULL OR check_due_date <= CURRENT_DATE);
