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

function getTodayDateString() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date())
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 點數計算：1元 = 1點（待串接 Echoss 發點 API） */
async function issuePoints(phone, amount) {
  const points = Math.floor(Number(amount))
  // TODO: 待串接 Echoss 發點 API
  log.info('points', '發點佔位（Echoss API 待串接）', { phone, points })
}

// ── 核銷處理邏輯（syncRedemptions / syncRangeWithRedemptionCheck 共用）──

/**
 * @param {boolean} skipNotification - 補跑模式傳 true，跳過寄信（歷史資料7天早已過期）
 */
async function processRedemptionRecord(orderNo, redeemDate, order, { skipNotification = false } = {}) {
  const today            = getTodayDateString()
  const actualRedeemDate = redeemDate || today

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
    const updated = await db.setRedeemed({ orderNo, redeemDate: actualRedeemDate, isMember: true, status: '已發點' })
    if (!updated) { log.info('redeem', '已被並發處理，跳過（會員）', { orderNo }); return null }
    await issuePoints(order.phone, order.amount)
    await db.markPointsIssued(orderNo)
    log.info('redeem', '已入會，已發點', { orderNo, phone: order.phone })
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
      const orderDate    = createdAt ? createdAt.slice(0, 10) : today

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
        const orderDate    = rezioOrder.createdAt ? rezioOrder.createdAt.slice(0, 10) : today
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
        await db.addToWeeklyQueue({ orderNo, customerName: customer_name, phone, email, orderDate: order_date, redeemDate: redeem_date, amount })
        const closed = await db.closeOrder(orderNo, false)
        if (!closed) { log.info('check-expired', '已被並發處理，跳過（無手機）', { orderNo }); return null }
        return 'queued'
      }

      const { isMember } = await echoss.isMember(phone)
      if (isMember) {
        const closed = await db.closeOrder(orderNo, true)  // 原子結案
        if (!closed) { log.info('check-expired', '已被並發處理，跳過（會員）', { orderNo }); return null }
        await issuePoints(phone, amount)                   // 只在成功結案後才發點
        log.info('check-expired', '已入會，已發點並結案', { orderNo, phone })
        return 'member'
      } else {
        await db.addToWeeklyQueue({ orderNo, customerName: customer_name, phone, email, orderDate: order_date, redeemDate: redeem_date, amount })
        const closed = await db.closeOrder(orderNo, false)
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

  return { ordersResult, redeemResult, expiredResult }
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

module.exports = { runDailySync, checkExpiredOrders, processInBatches, syncRangeWithRedemptionCheck }
