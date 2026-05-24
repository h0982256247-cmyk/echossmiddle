const rezio = require('../services/rezio')
const echoss = require('../services/echoss')
const db = require('../services/db')
const { sendCustomerNotification } = require('../utils/mailer')

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
  const now    = new Date()
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return taipei.toISOString().slice(0, 10)
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
  console.log(`[points] 發點佔位 phone=${phone} points=${points}`)
}

// ── 核銷處理邏輯（syncRedemptions / syncRangeWithRedemptionCheck 共用）──

async function processRedemptionRecord(orderNo, redeemDate, order) {
  const today            = getTodayDateString()
  const actualRedeemDate = redeemDate || today

  // 已處理過此核銷則跳過
  if (order.redeem_date && order.is_member_at_redeem !== null) return null

  if (!order.phone) {
    console.warn(`[redeem] 無手機欄位，無法查詢會員: ${orderNo}`)
    const checkDueDate = addDays(actualRedeemDate, 7)
    await db.setRedeemed({ orderNo, redeemDate: actualRedeemDate, isMember: null, checkDueDate, status: '待複查' })
    return null
  }

  const { isMember } = await echoss.isMember(order.phone)

  if (isMember) {
    await db.setRedeemed({ orderNo, redeemDate: actualRedeemDate, isMember: true, status: '已發點' })
    await issuePoints(order.phone, order.amount)
    await db.markPointsIssued(orderNo)
    console.log(`[redeem] 已入會，已發點: ${orderNo} ${order.phone}`)
    return 'member'
  }

  const checkDueDate = addDays(actualRedeemDate, 7)
  await db.setRedeemed({
    orderNo,
    redeemDate:       actualRedeemDate,
    isMember:         false,
    checkDueDate,
    customerNotified: false,
    status:           '待複查',
  })

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
      console.log(`[redeem] 非會員，已通知消費者: ${orderNo} ${order.email}`)
    } catch (mailErr) {
      console.error(`[redeem] 發信失敗 ${orderNo}:`, mailErr.message)
    }
  } else {
    console.warn(`[redeem] 無 email，跳過通知: ${orderNo}`)
  }

  return 'notified'
}

// ── 第一階段：同步新訂單 ──────────────────────────────────────

async function syncNewOrders(fromDate, toDate) {
  const today = getTodayDateString()
  const from  = fromDate || today
  const to    = toDate   || from
  console.log(`[sync-orders] 開始 from=${from} to=${to}`)

  const allOrders = await rezio.getOrders(from, to)
  console.log(`[sync-orders] 取得訂單: ${allOrders.length} 筆`)

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
        amount: detailAmount || amount || amout || 0,
      })
      console.log(`[sync-orders] 新增訂單: ${orderNo} ${customerName}`)
      return true
    } catch (err) {
      console.error(`[sync-orders] 處理訂單失敗 ${orderNo}:`, err.message)
      return false
    }
  })

  const newOrders = results.filter(Boolean).length
  console.log(`[sync-orders] 完成，新增: ${newOrders} 筆`)
  return { synced: allOrders.length, newOrders }
}

// ── 第二階段：同步核銷 ────────────────────────────────────────

async function syncRedemptions(fromDate, toDate) {
  const today = getTodayDateString()
  const from  = fromDate || today
  const to    = toDate   || from
  console.log(`[sync-redeem] 開始 from=${from} to=${to}`)

  const allRedemptions = await rezio.getRedemptions(from, to)
  const redemptions    = Array.from(new Map(allRedemptions.map(r => [r.orderNo, r])).values())
  console.log(`[sync-redeem] 核銷紀錄: ${allRedemptions.length}，去重: ${redemptions.length}`)

  const results = await processInBatches(redemptions, async (record) => {
    const { orderNo, redeemDate } = record
    try {
      let order = await db.getOrder(orderNo)
      if (!order) {
        // 訂單不在 DB，嘗試從 Rezio 補進來
        const rezioOrder = await rezio.getOrderByOrderNo(orderNo)
        if (!rezioOrder) { console.warn(`[sync-redeem] 找不到訂單: ${orderNo}`); return null }
        const { phone, email, amount } = await rezio.getOrderDetail(orderNo)
        const customerName = `${rezioOrder.contactLastName || ''}${rezioOrder.contactFirstName || ''}`.trim()
        const orderDate    = rezioOrder.createdAt ? rezioOrder.createdAt.slice(0, 10) : today
        await db.upsertOrder({ orderNo, customerName, phone, email, orderDate, amount })
        order = await db.getOrder(orderNo)
      }
      return await processRedemptionRecord(orderNo, redeemDate, order)
    } catch (err) {
      console.error(`[sync-redeem] 處理核銷失敗 ${orderNo}:`, err.message)
      return null
    }
  })

  const memberCount   = results.filter(r => r === 'member').length
  const notifiedCount = results.filter(r => r === 'notified').length
  console.log(`[sync-redeem] 完成 已入會:${memberCount} 非會員通知:${notifiedCount}`)
  return { synced: redemptions.length, memberCount, notifiedCount }
}

// ── 第三階段：7天後複查 ───────────────────────────────────────

async function checkExpiredOrders() {
  const today = getTodayDateString()
  console.log(`[check-expired] 開始，today=${today}`)

  const orders = await db.getOrdersDueForCheck(today)
  console.log(`[check-expired] 到期訂單: ${orders.length} 筆`)

  const results = await processInBatches(orders, async (order) => {
    const { order_no: orderNo, phone, email, customer_name, order_date, redeem_date, amount } = order
    try {
      if (!phone) {
        console.warn(`[check-expired] 無手機欄位: ${orderNo}，加入週報並結案`)
        await db.addToWeeklyQueue({ orderNo, customerName: customer_name, phone, email, orderDate: order_date, redeemDate: redeem_date, amount })
        await db.closeOrder(orderNo, false)
        return 'queued'
      }

      const { isMember } = await echoss.isMember(phone)
      if (isMember) {
        await issuePoints(phone, amount)
        await db.closeOrder(orderNo, true)
        console.log(`[check-expired] 已入會，已發點並結案: ${orderNo} ${phone}`)
        return 'member'
      } else {
        await db.addToWeeklyQueue({ orderNo, customerName: customer_name, phone, email, orderDate: order_date, redeemDate: redeem_date, amount })
        await db.closeOrder(orderNo, false)
        console.log(`[check-expired] 仍未入會，加入週報並結案: ${orderNo}`)
        return 'queued'
      }
    } catch (err) {
      console.error(`[check-expired] 處理失敗 ${orderNo}:`, err.message)
      return null
    }
  })

  const memberCount = results.filter(r => r === 'member').length
  const queuedCount = results.filter(r => r === 'queued').length
  console.log(`[check-expired] 完成 已發點:${memberCount} 加入週報:${queuedCount}`)
  return { checked: orders.length, memberCount, queuedCount }
}

// ── 每日完整任務 ──────────────────────────────────────────────

async function runDailySync() {
  const today = getTodayDateString()
  console.log(`[daily-sync] 開始 date=${today}`)

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

  console.log(`[sync-range-redeem] 查詢核銷 from=${fromDate} to=${today}`)
  const allRedemptions = await rezio.getRedemptions(fromDate, today)
  const unique         = Array.from(new Map(allRedemptions.map(r => [r.orderNo, r])).values())
  console.log(`[sync-range-redeem] 核銷紀錄共 ${unique.length} 筆`)

  let skippedCount = 0

  const results = await processInBatches(unique, async (record) => {
    const { orderNo, redeemDate } = record
    try {
      const order = await db.getOrder(orderNo)
      if (!order) {
        console.log(`[sync-range-redeem] 跳過（不在補跑區間內）: ${orderNo}`)
        skippedCount++
        return null
      }
      return await processRedemptionRecord(orderNo, redeemDate, order)
    } catch (err) {
      console.error(`[sync-range-redeem] 處理失敗 ${orderNo}:`, err.message)
      return null
    }
  })

  const memberCount   = results.filter(r => r === 'member').length
  const notifiedCount = results.filter(r => r === 'notified').length
  console.log(`[sync-range-redeem] 完成 已入會:${memberCount} 待複查:${notifiedCount} 跳過:${skippedCount}`)

  return {
    ordersResult,
    redeemResult: { synced: unique.length, memberCount, notifiedCount, skipped: skippedCount },
  }
}

module.exports = { runDailySync, checkExpiredOrders, processInBatches, syncRangeWithRedemptionCheck }
