-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: points_status
-- 目的：
--   1. 把 orders.points_issued (boolean) 升級為 points_status (text)
--      值域：null / 'pending' / 'issued' / 'failed' / 'timeout'
--      （或直接存 Echoss API 回傳的 status 字串）
--   2. 建立 point_issuances 發點旅程表，記錄每次發點嘗試的完整軌跡
--   3. 更新 mark_order_redeemed_member RPC：改為寫 points_status='pending'
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. orders 新增 points_status 欄位 ────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_status text;

-- 遷移舊資料：points_issued=true → points_status='issued'
UPDATE orders
SET points_status = 'issued'
WHERE points_issued = true
  AND points_status IS NULL;

-- points_issued 保留不刪（向後相容），但新程式碼改用 points_status
COMMENT ON COLUMN orders.points_status IS
  'Echoss 發點狀態：null=尚未到發點流程 | pending=準備發點（已入會，Echoss API 尚未回應）| issued=Echoss 確認成功 | failed=Echoss 回傳錯誤 | timeout=請求超時（Echoss 可能發也可能沒發，需人工複查）';


-- ── 2. point_issuances 發點旅程表 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS point_issuances (
  id              bigserial    PRIMARY KEY,
  order_no        text         NOT NULL REFERENCES orders(order_no),
  points          integer      NOT NULL,

  -- 發點狀態（我方定義）
  status          text         NOT NULL DEFAULT 'pending',
  -- CHECK status IN ('pending','issued','failed','timeout')

  -- Echoss API 原始回應
  echoss_status   text,        -- Echoss 回傳的 status 字串（串接後填入）
  echoss_response jsonb,       -- Echoss 回傳的完整 JSON（供除錯用）

  error_msg       text,        -- 錯誤訊息（failed / timeout 時填入）
  attempted_at    timestamptz  NOT NULL DEFAULT now(),
  completed_at    timestamptz  -- API 拿到回應（成功或失敗）的時間點
);

COMMENT ON TABLE point_issuances IS
  '每次嘗試發點的旅程記錄。同一 order_no 可有多筆（重試）；只要有一筆 status=''issued'' 即視為已完成。';

-- 查詢效率
CREATE INDEX IF NOT EXISTS idx_pi_order_no  ON point_issuances (order_no);
CREATE INDEX IF NOT EXISTS idx_pi_pending   ON point_issuances (status, order_no)
  WHERE status IN ('pending', 'failed', 'timeout');


-- ── 3. 更新 mark_order_redeemed_member RPC ────────────────────────────────────
-- 改為寫 points_status='pending'（而非 points_issued=true）
-- 原因：DB 標記代表「我方承諾要發點」；真正發點成功後再由程式把 points_status 改成 API 回傳值
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
    points_status       = 'pending'   -- 承諾發點，Echoss API 成功後再更新
  WHERE order_no    = p_order_no
    AND redeem_date IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
