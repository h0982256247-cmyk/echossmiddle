const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
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

async function setRedeemed({ orderNo, redeemDate, isMember, checkDueDate, customerNotified, status }) {
  const updates = {
    redeem_date:         redeemDate,
    is_member_at_redeem: isMember,
  }
  if (checkDueDate        !== undefined) updates.check_due_date    = checkDueDate
  if (customerNotified    !== undefined) updates.customer_notified = customerNotified
  if (status              !== undefined) updates.status            = status

  const { error } = await supabase.from('orders').update(updates).eq('order_no', orderNo)
  if (error) throw new Error(`setRedeemed failed: ${error.message}`)
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

// 結案：設定 status = '已結案'，可選補標 points_issued = true
async function closeOrder(orderNo, pointsIssued = false) {
  const updates = { status: '已結案' }
  if (pointsIssued) updates.points_issued = true
  const { error } = await supabase.from('orders').update(updates).eq('order_no', orderNo)
  if (error) throw new Error(`closeOrder failed: ${error.message}`)
}

async function getOrdersDueForCheck(today) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .lte('check_due_date', today)
    .eq('is_member_at_redeem', false)
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
    .single()
  if (error) throw new Error(`getLastSentAt failed: ${error.message}`)
  return data.last_sent_at ? new Date(data.last_sent_at) : null
}

async function updateLastSentAt() {
  const { error } = await supabase
    .from('report_schedule')
    .update({ last_sent_at: new Date().toISOString() })
    .eq('id', 1)
  if (error) throw new Error(`updateLastSentAt failed: ${error.message}`)
}

// ── Supabase Auth ─────────────────────────────────────────────

async function authSignIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  return data.session.access_token
}

async function validateAuthToken(token) {
  if (!token) return false
  const { data: { user }, error } = await supabase.auth.getUser(token)
  return !error && !!user
}

module.exports = {
  orderExists,
  upsertOrder,
  getOrder,
  setRedeemed,
  markPointsIssued,
  setCustomerNotified,
  closeOrder,
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
  validateAuthToken,
}
