-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: transaction_rpcs
-- 目的：將多步驟 DB 操作包成單一 RPC，確保原子性（同一 transaction 內完成）
--
-- 使用方式：在 Supabase Dashboard → SQL Editor 執行此檔案，
--           或透過 supabase db push 部署。
-- ─────────────────────────────────────────────────────────────────────────────


-- ── RPC 1: mark_order_redeemed_member ─────────────────────────────────────────
-- 原子標記「核銷時已入會」：一次 UPDATE 同時寫入
--   redeem_date / is_member_at_redeem / status / points_issued
-- 舊做法兩步（setRedeemed → markPointsIssued）中間 crash 會讓 points_issued 漏掉。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mark_order_redeemed_member(
  p_order_no    text,
  p_redeem_date date
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE orders
  SET
    redeem_date         = p_redeem_date,
    is_member_at_redeem = true,
    status              = '已發點',
    points_issued       = true
  WHERE order_no    = p_order_no
    AND redeem_date IS NULL;          -- 原子保護：只有尚未核銷的才更新

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;


-- ── RPC 2: close_order_and_enqueue ────────────────────────────────────────────
-- 原子結案 + 加入週報佇列，兩步驟在同一 transaction：
--   Step 1: UPDATE orders SET status='已結案' WHERE status='待複查'  （原子保護）
--   Step 2: INSERT/UPSERT weekly_report_queue                        （結案成功才執行）
-- 任一步驟失敗整個 transaction rollback，不會有「結案但不在 queue」的情況。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_order_and_enqueue(
  p_order_no      text,
  p_customer_name text,
  p_phone         text,
  p_email         text,
  p_order_date    date,
  p_redeem_date   date,
  p_amount        numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count int;
BEGIN
  -- Step 1：只在仍處於「待複查」時才結案（原子保護，防止並發重複處理）
  UPDATE orders
  SET status = '已結案'
  WHERE order_no = p_order_no
    AND status   = '待複查';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Step 2：結案成功才把記錄加進週報佇列（失敗則整個 rollback）
  IF v_count > 0 THEN
    INSERT INTO weekly_report_queue
      (order_no, customer_name, phone, email, order_date, redeem_date, amount)
    VALUES
      (p_order_no, p_customer_name, p_phone, p_email, p_order_date, p_redeem_date, p_amount)
    ON CONFLICT (order_no) DO UPDATE
      SET customer_name = EXCLUDED.customer_name,
          phone         = EXCLUDED.phone,
          email         = EXCLUDED.email,
          order_date    = EXCLUDED.order_date,
          redeem_date   = EXCLUDED.redeem_date,
          amount        = EXCLUDED.amount;
  END IF;

  RETURN v_count > 0;
END;
$$;
