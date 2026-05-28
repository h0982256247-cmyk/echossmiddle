const { createClient } = require('@supabase/supabase-js')

// DB 操作專用（service role，bypass RLS）
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// Auth 驗證專用（獨立實例，避免污染 DB client 的 auth 狀態）
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// ── Orders ─────────────────────────────────────────────────────

async function orderExists(orderNo) {
  const { data } = await supabase
    .from('orders')
    .select('order_no')
    .eq('order_no', orderNo)
    .maybeSingle()
  return !!data
}

async function upsertOrder({ orderNo, customerName, phone, email, orderDate, amount }) {
  const { error } = await supabase.from('orders').upsert(
    {
      order_no:      orderNo,
      customer_name: customerName,
      phone,
      email,
      order_date:    orderDate,
      amount,
      status:        '待核銷',
    },
    { onConflict: 'order_no', ignoreDuplicates: true }
  )
  if (error) throw new Error(`upsertOrder failed: ${error.message}`)
}

async function getOrder(orderNo) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('order_no', orderNo)
    .maybeSingle()
  if (error) throw new Error(`getOrder failed: ${error.message}`)
  return data
}

/**
 * 原子式標記核銷：只在 redeem_date IS NULL 時才更新（防止並發重複處理）
 * @returns {boolean} true = 成功更新；false = 已被其他執行緒處理，跳過
 */
async function setRedeemed({ orderNo, redeemDate, isMember, checkDueDate, customerNotified, status }) {
  const updates = {
    redeem_date:         redeemDate,
    is_member_at_redeem: isMember,
  }
  if (checkDueDate        !== undefined) updates.check_due_date    = checkDueDate
  if (customerNotified    !== undefined) updates.customer_notified = customerNotified
  if (status              !== undefined) updates.status            = status

  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('order_no', orderNo)
    .is('redeem_date', null)   // 原子保護：只有尚未核銷的才更新
    .select('order_no')
  if (error) throw new Error(`setRedeemed failed: ${error.message}`)
  return !!(data && data.length > 0)
}

async function markPointsIssued(orderNo) {
  const { error } = await supabase
    .from('orders')
    .update({ points_issued: true })
    .eq('order_no', orderNo)
  if (error) throw new Error(`markPointsIssued failed: ${error.message}`)
}

async function setCustomerNotified(orderNo) {
  const { error } = await supabase
    .from('orders')
    .update({ customer_notified: true })
    .eq('order_no', orderNo)
  if (error) throw new Error(`setCustomerNotified failed: ${error.message}`)
}

/**
 * 7天複查確認入會：status → '已發點'，points_status → 'pending'
 * 只在 status = '待複查' 時才更新（原子保護）
 * @returns {boolean} true = 成功；false = 已被並發處理
 */
async function markMemberAtCheck(orderNo) {
  const { data, error } = await supabase
    .from('orders')
    .update({ status: '已發點', points_status: 'pending' })
    .eq('order_no', orderNo)
    .eq('status', '待複查')
    .select('order_no')
  if (error) throw new Error(`markMemberAtCheck failed: ${error.message}`)
  return !!(data && data.length > 0)
}

/**
 * 原子式結案：只在 status = '待複查' 時才更新（防止並發重複處理）
 * @returns {boolean} true = 成功結案；false = 已被其他執行緒處理，跳過
 */
async function closeOrder(orderNo, pointsIssued = false) {
  const updates = { status: '已結案' }
  if (pointsIssued) updates.points_issued = true
  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('order_no', orderNo)
    .eq('status', '待複查')    // 原子保護：只有仍在複查中的才結案
    .select('order_no')
  if (error) throw new Error(`closeOrder failed: ${error.message}`)
  return !!(data && data.length > 0)
}

// ── RPC wrappers（原子多步驟操作）─────────────────────────────

/**
 * 原子標記「核銷時已入會」
 * 一次 UPDATE 同時寫入 redeem_date / is_member_at_redeem / status='已發點' / points_issued=true
 * 取代原本的 setRedeemed + markPointsIssued 兩步驟，消除中間 crash 造成的狀態不一致。
 * @returns {boolean} true = 成功；false = 已被並發處理
 */
async function setRedeemedMember({ orderNo, redeemDate }) {
  const { data, error } = await supabase.rpc('mark_order_redeemed_member', {
    p_order_no:    orderNo,
    p_redeem_date: redeemDate,
  })
  if (error) throw new Error(`setRedeemedMember failed: ${error.message}`)
  return !!data
}

/**
 * 原子結案 + 加入週報佇列（兩步驟在同一 DB transaction 內）
 * 取代原本的 addToWeeklyQueue + closeOrder 兩步驟，消除中間 crash 造成的資料不一致。
 * @returns {boolean} true = 成功結案並入佇列；false = 已被並發處理
 */
async function closeOrderAndEnqueue({ orderNo, customerName, phone, email, orderDate, redeemDate, amount }) {
  const { data, error } = await supabase.rpc('close_order_and_enqueue', {
    p_order_no:      orderNo,
    p_customer_name: customerName || null,
    p_phone:         phone        || null,
    p_email:         email        || null,
    p_order_date:    orderDate,
    p_redeem_date:   redeemDate   || null,
    p_amount:        amount       || 0,
  })
  if (error) throw new Error(`closeOrderAndEnqueue failed: ${error.message}`)
  return !!data
}

async function getOrdersDueForCheck(today) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .lte('check_due_date', today)
    // 包含 false（查過不是會員）與 null（無手機、當時無法查），兩者都需要複查
    .or('is_member_at_redeem.eq.false,is_member_at_redeem.is.null')
    .eq('status', '待複查')    // 排除已結案訂單，避免重複撈出
  if (error) throw new Error(`getOrdersDueForCheck failed: ${error.message}`)
  return data || []
}

async function getAllOrders(page = 1, pageSize = 50, statusFilter = null) {
  const from = (page - 1) * pageSize
  const to   = from + pageSize - 1

  let query = supabase
    .from('orders')
    .select('*', { count: 'exact' })
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, to)

  if (statusFilter) query = query.eq('status', statusFilter)

  const { data, error, count } = await query
  if (error) throw new Error(`getAllOrders failed: ${error.message}`)
  return { rows: data || [], total: count || 0 }
}

async function getOrderStats() {
  const [r1, r2, r3, r4] = await Promise.all([
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', '待核銷'),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', '待複查'),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', '已發點'),
    supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', '已結案'),
  ])
  return {
    pending: r1.count || 0,
    review:  r2.count || 0,
    pointed: r3.count || 0,
    closed:  r4.count || 0,
  }
}

// 取得指定下單日期區間的訂單（週報A用）
async function getOrdersInDateRange(from, to) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .gte('order_date', from)
    .lte('order_date', to)
    .order('order_date', { ascending: true })
  if (error) throw new Error(`getOrdersInDateRange failed: ${error.message}`)
  return data || []
}

// ── Weekly Report Queue ────────────────────────────────────────

async function addToWeeklyQueue({ orderNo, customerName, phone, email, orderDate, redeemDate, amount }) {
  const { error } = await supabase.from('weekly_report_queue').upsert(
    {
      order_no:      orderNo,
      customer_name: customerName,
      phone,
      email,
      order_date:    orderDate,
      redeem_date:   redeemDate,
      amount,
    },
    { onConflict: 'order_no' }
  )
  if (error) throw new Error(`addToWeeklyQueue failed: ${error.message}`)
}

async function getWeeklyQueue() {
  const { data, error } = await supabase
    .from('weekly_report_queue')
    .select('*')
    .order('redeem_date', { ascending: true })
  if (error) throw new Error(`getWeeklyQueue failed: ${error.message}`)
  return data || []
}

async function getWeeklyQueueCount() {
  const { count, error } = await supabase
    .from('weekly_report_queue')
    .select('*', { count: 'exact', head: true })
  if (error) throw new Error(`getWeeklyQueueCount failed: ${error.message}`)
  return count || 0
}

async function clearWeeklyQueue() {
  const { error } = await supabase
    .from('weekly_report_queue')
    .delete()
    .gte('id', 0)
  if (error) throw new Error(`clearWeeklyQueue failed: ${error.message}`)
}

// ── Report Schedule ────────────────────────────────────────────

async function getLastSentAt() {
  const { data, error } = await supabase
    .from('report_schedule')
    .select('last_sent_at')
    .eq('id', 1)
    .maybeSingle()                          // 查不到 row 返回 null，不 throw
  if (error) throw new Error(`getLastSentAt failed: ${error.message}`)
  return data?.last_sent_at ? new Date(data.last_sent_at) : null
}

async function updateLastSentAt() {
  // upsert：row 不存在時自動建立，不需要手動 seed
  const { error } = await supabase
    .from('report_schedule')
    .upsert({ id: 1, last_sent_at: new Date().toISOString() }, { onConflict: 'id' })
  if (error) throw new Error(`updateLastSentAt failed: ${error.message}`)
}

// ── Supabase Auth ─────────────────────────────────────────────

const jwt = require('jsonwebtoken')

/**
 * 登入，回傳 accessToken / refreshToken / expiresAt
 */
async function authSignIn(email, password) {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  if (!data.session) throw new Error('Email 尚未驗證，請至 Supabase Dashboard → Authentication → Providers → Email 關閉 Confirm email')
  return {
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt:    data.session.expires_at,   // Unix timestamp (seconds)
  }
}

/**
 * 用 refresh token 換新 access token
 */
async function authRefresh(refreshToken) {
  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken })
  if (error) throw new Error(error.message)
  if (!data.session) throw new Error('Session 已過期，請重新登入')
  return {
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt:    data.session.expires_at,
  }
}

/**
 * 驗證 JWT：優先本地驗簽（零 latency），失敗時一律 fallback 到 Supabase API
 */
async function validateAuthToken(token) {
  if (!token) return false
  const secret = process.env.SUPABASE_JWT_SECRET
  if (secret) {
    try {
      // Supabase 簽 JWT 時以 raw string 為 HMAC key
      jwt.verify(token, secret)
      return true
    } catch {
      // local 驗簽失敗（secret 格式不符等），fall through 到 API 驗證
    }
  }
  // Supabase API 驗證（保證正確，稍慢）
  try {
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token)
    return !error && !!user
  } catch {
    return false
  }
}

// ── Point Issuances（發點旅程記錄）─────────────────────────────

/**
 * 建立發點旅程記錄（status='pending'，Echoss API 呼叫前插入）
 * @returns {number} 新記錄的 id
 */
async function createPointIssuance({ orderNo, points }) {
  const { data, error } = await supabase
    .from('point_issuances')
    .insert({ order_no: orderNo, points, status: 'pending' })
    .select('id')
    .single()
  if (error) throw new Error(`createPointIssuance failed: ${error.message}`)
  return data.id
}

/**
 * 完成發點旅程記錄（Echoss API 回應後更新）
 * @param {number} id
 * @param {{ status, echossStatus?, echossResponse?, errorMsg? }} result
 */
async function completePointIssuance(id, { status, echossStatus, echossResponse, errorMsg }) {
  const { error } = await supabase
    .from('point_issuances')
    .update({
      status,
      echoss_status:   echossStatus   ?? null,
      echoss_response: echossResponse ?? null,
      error_msg:       errorMsg       ?? null,
      completed_at:    new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw new Error(`completePointIssuance failed: ${error.message}`)
}

/**
 * 冪等性檢查：此訂單是否已有成功發點紀錄
 * @returns {boolean}
 */
async function hasSuccessfulPointIssuance(orderNo) {
  const { data, error } = await supabase
    .from('point_issuances')
    .select('id')
    .eq('order_no', orderNo)
    .eq('status', 'issued')
    .limit(1)
  if (error) throw new Error(`hasSuccessfulPointIssuance failed: ${error.message}`)
  return !!(data && data.length > 0)
}

/**
 * 更新 orders.points_status（Echoss API 回應後同步到主表）
 * @param {string} orderNo
 * @param {string} pointsStatus - 'issued' / 'failed' / 'timeout' / 或 Echoss 原始狀態字串
 */
async function updatePointsStatus(orderNo, pointsStatus) {
  const { error } = await supabase
    .from('orders')
    .update({ points_status: pointsStatus })
    .eq('order_no', orderNo)
  if (error) throw new Error(`updatePointsStatus failed: ${error.message}`)
}

// timeout 冷卻期：至少等 30 分鐘後才重試
// 防止同一輪 sync 裡 timeout → 立即重試，Echoss 可能仍在處理第一次請求
const TIMEOUT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * 撈出需要重試發點的訂單
 *
 * pending / failed  → 直接納入（確定 Echoss 沒發）
 * timeout           → 只撈最近一筆 point_issuances 的 attempted_at
 *                     距今已超過 TIMEOUT_COOLDOWN_MS 的，才納入重試
 *                     （避免同一輪 sync 裡立刻重試，Echoss 可能還沒寫入查詢結果）
 */
async function getOrdersNeedingPointRetry() {
  const cooldownCutoff = new Date(Date.now() - TIMEOUT_COOLDOWN_MS).toISOString()

  // pending / failed：直接撈
  const { data: normalOrders, error: e1 } = await supabase
    .from('orders')
    .select('order_no, phone, amount, points_status')
    .in('points_status', ['pending', 'failed'])
    .not('phone', 'is', null)
  if (e1) throw new Error(`getOrdersNeedingPointRetry(normal) failed: ${e1.message}`)

  // timeout：需確認最近一次 attempt 已超過冷卻期
  // 利用 Supabase 的 inner join via select 取最新 attempt 時間
  const { data: timeoutOrders, error: e2 } = await supabase
    .from('orders')
    .select(`
      order_no, phone, amount, points_status,
      point_issuances!inner(attempted_at)
    `)
    .eq('points_status', 'timeout')
    .not('phone', 'is', null)
    .eq('point_issuances.status', 'timeout')
    .lt('point_issuances.attempted_at', cooldownCutoff)
  if (e2) throw new Error(`getOrdersNeedingPointRetry(timeout) failed: ${e2.message}`)

  // 合併、去重（一筆訂單可能有多筆 timeout issuance，只保留一次）
  const seen = new Set()
  const all  = [...(normalOrders || []), ...(timeoutOrders || [])]
  return all.filter(o => seen.has(o.order_no) ? false : seen.add(o.order_no))
}

module.exports = {
  orderExists,
  upsertOrder,
  getOrder,
  setRedeemed,
  setRedeemedMember,        // RPC：原子標記會員核銷（取代 setRedeemed+markPointsIssued）
  markPointsIssued,
  setCustomerNotified,
  markMemberAtCheck,
  closeOrder,
  closeOrderAndEnqueue,     // RPC：原子結案+入週報佇列（取代 addToWeeklyQueue+closeOrder）
  getOrdersDueForCheck,
  getAllOrders,
  getOrderStats,
  getOrdersInDateRange,
  addToWeeklyQueue,
  getWeeklyQueue,
  getWeeklyQueueCount,
  clearWeeklyQueue,
  getLastSentAt,
  updateLastSentAt,
  authSignIn,
  authRefresh,
  validateAuthToken,
  // Point Issuances
  createPointIssuance,
  completePointIssuance,
  hasSuccessfulPointIssuance,
  updatePointsStatus,
  getOrdersNeedingPointRetry,
}
