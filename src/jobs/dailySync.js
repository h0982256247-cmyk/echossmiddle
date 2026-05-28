const rezio = require('../services/rezio')
const echoss = require('../services/echoss')
const db = require('../services/db')
const { sendCustomerNotification } = require('../utils/mailer')
const log = require('../utils/logger')

const CONCURRENCY = 5

// ── 工具函式 ──────────────────────────────────────────────────

async function processInBatches(items, fn) {
  const results = []
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

const _taipeiFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' })

function getTodayDateString() {
  return _taipeiFormat.format(new Date())
}

/**
 * 將任意 datetime 字串轉換為台北時間的日期字串（YYYY-MM-DD）
 * 解決 Rezio API 若回傳 UTC datetime，直接 slice(0,10) 會在凌晨 0–8 點記錯日的問題
 * 已是純日期格式（YYYY-MM-DD）則直接回傳，不再轉換
 */
function toTaipeiDateString(datetimeStr) {
  if (!datetimeStr) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(datetimeStr)) return datetimeStr
  return _taipeiFormat.format(new Date(datetimeStr))
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * 發點（含冪等保護 + 旅程記錄）
 *
 * 流程：
 *   1. 冪等檢查：point_issuances 已有 status='issued' → 跳過（防止重複發點）
 *   2. 建立 pending 記錄（DB 先留下足跡）
 *   3. 呼叫 Echoss API
 *   4. 依回應更新 point_issuances + orders.points_status
 *
 * timeout 時：orders.points_status='timeout'，不自動重試（人工確認 Echoss 端是否已發）
 * failed  時：orders.points_status='failed'，下一輪 sync 的 retryPendingIssuances 會重試
 */
async function issuePoints(orderNo, phone, amount) {
  const points = Math.floor(Number(amount))

  // ── 1. 冪等性檢查 ──────────────────────────────────────────────
  // 我方歷程裡已有 issued → 不重打 API（保護 pending/failed 的重試路徑）
  // 注意：timeout 訂單走 resolveTimeoutIssuance，不走這裡
  const alreadyIssued = await db.hasSuccessfulPointIssuance(orderNo)
  if (alreadyIssued) {
    log.info('points', '歷程已有成功紀錄，跳過 API 呼叫（冪等保護）', { orderNo })
    return
  }

  // ── 2. 建立 pending 旅程記錄 ───────────────────────────────────
  const issuanceId = await db.createPointIssuance({ orderNo, points })
  log.info('points', '發點開始', { orderNo, phone, points, issuanceId })

  // ── 3. 呼叫 Echoss API ─────────────────────────────────────────
  try {
    const { echossStatus, raw } = await echoss.issuePoints(phone, points, orderNo)

    // ── 4a. 成功：更新記錄與主表 ──────────────────────────────────
    await db.completePointIssuance(issuanceId, { status: 'issued', echossStatus, echossResponse: raw })
    await db.updatePointsStatus(orderNo, echossStatus ?? 'issued')
    log.info('points', '發點成功', { orderNo, phone, points, echossStatus })

  } catch (err) {
    // ── 4b. 失敗：區分 timeout vs 一般錯誤 ───────────────────────
    const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message)
    const failStatus = isTimeout ? 'timeout' : 'failed'

    await db.completePointIssuance(issuanceId, { status: failStatus, errorMsg: err.message })
    await db.updatePointsStatus(orderNo, failStatus)

    if (isTimeout) {
      // timeout：Echoss 可能已發點，不自動重試，需人工確認
      log.warn('points', 'Echoss API timeout，需人工確認是否已發點', { orderNo, error: err.message })
    } else {
      log.error('points', '發點失敗，下輪將重試', { orderNo, error: err.message })
    }
    // 不 rethrow：讓上層流程繼續（發點失敗不應中斷整批 sync）
  }
}

/**
 * timeout 訂單的專屬處理：先查 Echoss 發點歷程，再決定是否重打 API
 *
 * 流程：
 *   1. 呼叫 echoss.getIssuanceHistory(orderNo)
 *   2. wasIssued = true  → Echoss 確認已發 → 更新我方記錄為 issued，不重打 API
 *   3. wasIssued = false → Echoss 確認未發 → 走正常 issuePoints 流程（含冪等保護）
 */
async function resolveTimeoutIssuance(orderNo, phone, amount) {
  log.info('retry-points', 'timeout 訂單：查詢 Echoss 發點歷程', { orderNo })

  const { wasIssued, echossStatus, raw } = await echoss.getIssuanceHistory(orderNo)

  if (wasIssued) {
    // Echoss 那邊有記錄 → 補建 issued 歷程紀錄並更新主表，不重打 API
    const issuanceId = await db.createPointIssuance({ orderNo, points: Math.floor(Number(amount)) })
    await db.completePointIssuance(issuanceId, { status: 'issued', echossStatus, echossResponse: raw })
    await db.updatePointsStatus(orderNo, echossStatus ?? 'issued')
    log.info('retry-points', 'Echoss 確認已發點，補記錄完成', { orderNo, echossStatus })
    return 'ok'
  }

  // Echoss 確認沒發 → 正常重試（issuePoints 內含冪等保護）
  log.info('retry-points', 'Echoss 確認未發點，進行重試', { orderNo })
  await issuePoints(orderNo, phone, amount)
  return 'ok'
}

/**
 * 重試需補發點的訂單（每日 sync 的最後一步）
 *
 * pending / failed → 直接重打 API（這兩種狀態代表 Echoss 肯定沒發）
 * timeout          → 先查 Echoss 歷程確認後再決定（防止翻倍）
 */
async function retryPendingIssuances() {
  const orders = await db.getOrdersNeedingPointRetry()
  if (orders.length === 0) return { retried: 0, succeeded: 0, failed: 0 }

  log.info('retry-points', `待重試發點訂單 ${orders.length} 筆`)

  const results = await processInBatches(orders, async (order) => {
    try {
      if (order.points_status === 'timeout') {
        return await resolveTimeoutIssuance(order.order_no, order.phone, order.amount)
      }
      await issuePoints(order.order_no, order.phone, order.amount)
      return 'ok'
    } catch {
      return 'fail'
    }
  })

  const succeeded = results.filter(r => r === 'ok').length
  const failed    = results.filter(r => r === 'fail').length
  log.info('retry-points', '完成', { retried: orders.length, succeeded, failed })
  return { retried: orders.length, succeeded, failed }
}

// ── 核銷處理邏輯（syncRedemptions / syncRangeWithRedemptionCheck 共用）──

/**
 * @param {boolean} skipNotification - 補跑模式傳 true，跳過寄信（歷史資料7天早已過期）
 */
async function processRedemptionRecord(orderNo, redeemDate, order, { skipNotification = false } = {}) {
  const today            = getTodayDateString()
  const actualRedeemDate = redeemDate ? toTaipeiDateString(redeemDate) : today

  // 已處理過此核銷則跳過
  if (order.redeem_date && order.is_member_at_redeem !== null) return null

  if (!order.phone) {
    log.warn('redeem', '無手機欄位，無法查詢會員', { orderNo })
    const checkDueDate = addDays(actualRedeemDate, 7)
    const updated = await db.setRedeemed({ orderNo, redeemDate: actualRedeemDate, isMember: null, checkDueDate, status: '待複查' })
    if (!updated) { log.info('redeem', '已被並發處理，跳過（無手機）', { orderNo }); return null }
    return null
  }

  const { isMember } = await echoss.isMember(order.phone)

  if (isMember) {
    // RPC：原子寫入 redeem_date + is_member_at_redeem + status='已發點' + points_status='pending'
    // 一次 UPDATE 確保 DB 狀態一致；Echoss API 成功後才把 points_status 改成 'issued'
    const updated = await db.setRedeemedMember({ orderNo, redeemDate: actualRedeemDate })
    if (!updated) { log.info('redeem', '已被並發處理，跳過（會員）', { orderNo }); return null }
    await issuePoints(orderNo, order.phone, order.amount)
    log.info('redeem', '已入會，發點流程完成', { orderNo, phone: order.phone })
    return 'member'
  }

  const checkDueDate = addDays(actualRedeemDate, 7)
  const updated = await db.setRedeemed({
    orderNo,
    redeemDate:       actualRedeemDate,
    isMember:         false,
    checkDueDate,
    customerNotified: skipNotification ? null : false,
    status:           '待複查',
  })
  if (!updated) { log.info('redeem', '已被並發處理，跳過（非會員）', { orderNo }); return null }

  if (skipNotification) {
    log.info('redeem', '補跑模式，跳過消費者通知', { orderNo })
    return 'notified'
  }

  if (order.email) {
    try {
      await sendCustomerNotification({
        email:        order.email,
        customerName: order.customer_name,
        orderNo,
        redeemDate:   actualRedeemDate,
        amount:       order.amount,
      })
      await db.setCustomerNotified(orderNo)
      log.info('redeem', '非會員，已通知消費者', { orderNo, email: order.email })
    } catch (mailErr) {
      log.error('redeem', '發信失敗', { orderNo, error: mailErr.message })
    }
  } else {
    log.warn('redeem', '無 email，跳過通知', { orderNo })
  }

  return 'notified'
}

// ── 第一階段：同步新訂單 ──────────────────────────────────────

async function syncNewOrders(fromDate, toDate) {
  const today = getTodayDateString()
  const from  = fromDate || today
  const to    = toDate   || from
  log.info('sync-orders', '開始', { from, to })

  const allOrders = await rezio.getOrders(from, to)
  log.info('sync-orders', `取得訂單 ${allOrders.length} 筆`)

  const results = await processInBatches(allOrders, async (order) => {
    // amout（非拼錯）是 Rezio API 本身的 typo，保留作備用 fallback
    const { orderNo, contactLastName, contactFirstName, amount, createdAt, amout } = order
    try {
      if (await db.orderExists(orderNo)) return false

      const { phone, email, amount: detailAmount } = await rezio.getOrderDetail(orderNo)
      const customerName = `${contactLastName || ''}${contactFirstName || ''}`.trim()
      const orderDate    = createdAt ? toTaipeiDateString(createdAt) : today

      await db.upsertOrder({
        orderNo,
        customerName,
        phone,
        email,
        orderDate,
        amount: detailAmount ?? amount ?? amout ?? 0,
      })
      log.info('sync-orders', '新增訂單', { orderNo, customerName })
      return true
    } catch (err) {
      log.error('sync-orders', '處理訂單失敗', { orderNo, error: err.message })
      return false
    }
  })

  const newOrders = results.filter(Boolean).length
  log.info('sync-orders', '完成', { synced: allOrders.length, newOrders })
  return { synced: allOrders.length, newOrders }
}

// ── 第二階段：同步核銷 ────────────────────────────────────────

async function syncRedemptions(fromDate, toDate) {
  const today = getTodayDateString()
  const from  = fromDate || today
  const to    = toDate   || from
  log.info("sync-redeem", "開始", { from, to })

  const allRedemptions = await rezio.getRedemptions(from, to)
  const redemptions    = Array.from(new Map(allRedemptions.map(r => [r.orderNo, r])).values())
  log.info("sync-redeem", "核銷紀錄去重完成", { total: allRedemptions.length, unique: redemptions.length })

  const results = await processInBatches(redemptions, async (record) => {
    const { orderNo, redeemDate } = record
    try {
      let order = await db.getOrder(orderNo)
      if (!order) {
        // 訂單不在 DB，嘗試從 Rezio 補進來
        const rezioOrder = await rezio.getOrderByOrderNo(orderNo)
        if (!rezioOrder) { log.warn('sync-redeem', '找不到訂單', { orderNo }); return null }
        const { phone, email, amount } = await rezio.getOrderDetail(orderNo)
        const customerName = `${rezioOrder.contactLastName || ''}${rezioOrder.contactFirstName || ''}`.trim()
        const orderDate    = rezioOrder.createdAt ? rezioOrder.toTaipeiDateString(createdAt) : today
        await db.upsertOrder({ orderNo, customerName, phone, email, orderDate, amount })
        order = await db.getOrder(orderNo)
      }
      return await processRedemptionRecord(orderNo, redeemDate, order)
    } catch (err) {
      log.error('sync-redeem', '處理核銷失敗', { orderNo, error: err.message })
      return null
    }
  })

  const memberCount   = results.filter(r => r === 'member').length
  const notifiedCount = results.filter(r => r === 'notified').length
  log.info('sync-redeem', '完成', { memberCount, notifiedCount })
  return { synced: redemptions.length, memberCount, notifiedCount }
}

// ── 第三階段：7天後複查 ───────────────────────────────────────

async function checkExpiredOrders() {
  const today = getTodayDateString()
  log.info('check-expired', '開始', { today })

  const orders = await db.getOrdersDueForCheck(today)
  log.info('check-expired', `到期訂單 ${orders.length} 筆`)

  const results = await processInBatches(orders, async (order) => {
    const { order_no: orderNo, phone, email, customer_name, order_date, redeem_date, amount } = order
    try {
      if (!phone) {
        log.warn('check-expired', '無手機欄位，加入週報並結案', { orderNo })
        // RPC：原子結案 + 入週報佇列（兩步驟在同一 transaction，消除中間 crash 的風險）
        const closed = await db.closeOrderAndEnqueue({ orderNo, customerName: customer_name, phone, email, orderDate: order_date, redeemDate: redeem_date, amount })
        if (!closed) { log.info('check-expired', '已被並發處理，跳過（無手機）', { orderNo }); return null }
        return 'queued'
      }

      const { isMember } = await echoss.isMember(phone)
      if (isMember) {
        const updated = await db.markMemberAtCheck(orderNo)  // 原子更新：'待複查' → '已發點'，points_status='pending'
        if (!updated) { log.info('check-expired', '已被並發處理，跳過（會員）', { orderNo }); return null }
        await issuePoints(orderNo, phone, amount)            // 只在成功更新後才發點
        log.info('check-expired', '7天複查已入會，狀態→已發點', { orderNo, phone })
        return 'member'
      } else {
        // RPC：原子結案 + 入週報佇列（兩步驟在同一 transaction，消除中間 crash 的風險）
        const closed = await db.closeOrderAndEnqueue({ orderNo, customerName: customer_name, phone, email, orderDate: order_date, redeemDate: redeem_date, amount })
        if (!closed) { log.info('check-expired', '已被並發處理，跳過（未入會）', { orderNo }); return null }
        log.info('check-expired', '仍未入會，加入週報並結案', { orderNo })
        return 'queued'
      }
    } catch (err) {
      log.error('check-expired', '處理失敗', { orderNo, error: err.message })
      return null
    }
  })

  const memberCount = results.filter(r => r === 'member').length
  const queuedCount = results.filter(r => r === 'queued').length
  log.info('check-expired', '完成', { memberCount, queuedCount })
  return { checked: orders.length, memberCount, queuedCount }
}

// ── 每日完整任務 ──────────────────────────────────────────────

async function runDailySync() {
  const today = getTodayDateString()
  log.info('daily-sync', '開始', { today })

  const ordersResult  = await syncNewOrders(today, today)
  const redeemResult  = await syncRedemptions(today, today)
  const expiredResult = await checkExpiredOrders()
  // 第四步：重試前幾輪失敗的發點（pending/failed；timeout 不自動重試）
  const retryResult   = await retryPendingIssuances()

  return { ordersResult, redeemResult, expiredResult, retryResult }
}

// ── 補跑專用：先同步訂單，再查這批訂單的核銷狀態 ─────────────

/**
 * 補跑指定日期區間的訂單，並查詢這些訂單截至今天的核銷狀態
 * - 只處理 DB 中存在的訂單，不自動建立區間外訂單
 * - 核銷查詢擴展至今天，涵蓋「下單後才核銷」的情況
 */
async function syncRangeWithRedemptionCheck(fromDate, toDate) {
  const today = getTodayDateString()

  const ordersResult = await syncNewOrders(fromDate, toDate)

  log.info('sync-range-redeem', '查詢核銷', { from: fromDate, to: today })
  const allRedemptions = await rezio.getRedemptions(fromDate, today)
  const unique         = Array.from(new Map(allRedemptions.map(r => [r.orderNo, r])).values())
  log.info('sync-range-redeem', `核銷紀錄共 ${unique.length} 筆`)

  let skippedCount = 0

  const results = await processInBatches(unique, async (record) => {
    const { orderNo, redeemDate } = record
    try {
      const order = await db.getOrder(orderNo)
      if (!order) {
        log.info('sync-range-redeem', '跳過，不在補跑區間', { orderNo })
        skippedCount++
        return null
      }
      // 補跑模式：跳過寄信（歷史核銷的7天緩衝期早已過期）
      return await processRedemptionRecord(orderNo, redeemDate, order, { skipNotification: true })
    } catch (err) {
      log.error('sync-range-redeem', '處理失敗', { orderNo, error: err.message })
      return null
    }
  })

  const memberCount   = results.filter(r => r === 'member').length
  const notifiedCount = results.filter(r => r === 'notified').length
  log.info('sync-range-redeem', '完成', { memberCount, notifiedCount, skippedCount })

  return {
    ordersResult,
    redeemResult: { synced: unique.length, memberCount, notifiedCount, skipped: skippedCount },
  }
}

module.exports = { runDailySync, checkExpiredOrders, processInBatches, syncRangeWithRedemptionCheck, retryPendingIssuances }
