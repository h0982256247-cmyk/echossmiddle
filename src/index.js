require('dotenv').config()
const express = require('express')
const path    = require('path')
const crypto  = require('crypto')
const { runDailySync, syncNewOrders, syncRedemptions, checkExpiredOrders, processInBatches, syncRangeWithRedemptionCheck } = require('./jobs/dailySync')
const echoss = require('./services/echoss')
const db = require('./services/db')
const { generateReport } = require('./utils/report')
const { sendReportA, sendReportB, diagnoseMail } = require('./utils/mailer')
const { getTestMode, setTestMode } = require('./utils/config')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token')
}

app.options('/api/admin', (req, res) => { setCors(res); res.sendStatus(200) })

// ── Admin token 工具 ─────────────────────────────────────────
function getAdminToken() {
  if (!process.env.ADMIN_PASSWORD) return null
  return crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update('admin').digest('hex')
}

function validateAdminToken(req) {
  if (!process.env.ADMIN_PASSWORD) return true          // 未設密碼時全放行
  return req.headers['x-admin-token'] === getAdminToken()
}

// ── POST /api/login ───────────────────────────────────────────
app.post('/api/login', (req, res) => {
  setCors(res)
  const { password } = req.body || {}
  if (!process.env.ADMIN_PASSWORD) {
    return res.json({ ok: true, token: 'no-auth' })
  }
  if (password === process.env.ADMIN_PASSWORD) {
    return res.json({ ok: true, token: getAdminToken() })
  }
  return res.status(401).json({ ok: false, error: '密碼錯誤' })
})

// ── 週報邏輯（手動按鈕 & 自動排程共用）──────────────────────────

async function runReportA() {
  const { from, to } = getLastWeekRange()
  const orders = await db.getOrdersInDateRange(from, to)
  const ordersWithPhone = orders.filter(o => o.phone)
  const results = await processInBatches(ordersWithPhone, async (order) => {
    const { isMember } = await echoss.isMember(order.phone)
    return isMember ? null : order
  })
  const nonMembers = results.filter(Boolean)

  const periodLabel = `${from} ~ ${to}`
  const excelBuffer = nonMembers.length > 0 ? await generateReport(nonMembers, periodLabel) : null
  await sendReportA(excelBuffer, nonMembers.length, periodLabel)
  console.log(`[report-a] 已寄出，共 ${nonMembers.length} 筆，期間 ${periodLabel}`)
  return { skipped: false, message: `週報A已寄出，共 ${nonMembers.length} 筆`, count: nonMembers.length }
}

async function runReportB() {
  const records = await db.getWeeklyQueue()

  const dates       = records.map(r => r.redeem_date).filter(Boolean).sort()
  const periodLabel = dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : new Date().toISOString().slice(0, 10)
  const excelBuffer = records.length > 0 ? await generateReport(records, periodLabel) : null
  await sendReportB(excelBuffer, records.length, periodLabel)
  await db.clearWeeklyQueue()
  await db.updateLastSentAt()
  console.log(`[report-b] 已寄出，共 ${records.length} 筆，期間 ${periodLabel}`)
  return { skipped: false, message: `週報B已寄出，共 ${records.length} 筆`, count: records.length }
}

// ── POST /api/run（每日排程，需 CRON_SECRET）────────────────────
app.post('/api/run', (req, res) => {
  const auth   = req.headers['authorization'] || ''
  const secret = process.env.CRON_SECRET
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  res.status(202).json({ ok: true, message: 'daily sync started' })

  runDailySync()
    .then(result => console.log('[api/run] 完成', JSON.stringify(result)))
    .catch(err   => console.error('[api/run] 執行失敗', err.message))
})

// ── POST /api/run-weekly（每週一排程，需 CRON_SECRET）──────────
app.post('/api/run-weekly', (req, res) => {
  const auth   = req.headers['authorization'] || ''
  const secret = process.env.CRON_SECRET
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  res.status(202).json({ ok: true, message: 'weekly sync started' })

  Promise.all([runReportA(), runReportB()])
    .then(([a, b]) => console.log('[api/run-weekly] 完成', JSON.stringify({ a, b })))
    .catch(err     => console.error('[api/run-weekly] 執行失敗', err.message))
})

// ── GET /api/admin?action=status ───────────────────────────────
app.get('/api/admin', async (req, res) => {
  setCors(res)
  if (!validateAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' })
  const { action } = req.query

  if (action === 'status') {
    try {
      const page         = parseInt(req.query.page) || 1
      const statusFilter = req.query.statusFilter || null
      const pageSize     = 50

      const [ordersResult, stats, queueCount, lastSentAt] = await Promise.all([
        db.getAllOrders(page, pageSize, statusFilter),
        db.getOrderStats(),
        db.getWeeklyQueueCount(),
        db.getLastSentAt(),
      ])

      return res.json({
        orders:      ordersResult.rows,
        totalOrders: ordersResult.total,
        page,
        pageSize,
        totalPages:  Math.ceil(ordersResult.total / pageSize),
        stats,
        weeklyQueueCount: queueCount,
        lastSentAt:  lastSentAt?.toISOString() || null,
        now:         new Date().toISOString(),
        testMode:    getTestMode(),
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  return res.status(404).json({ error: 'Not Found' })
})

// ── POST /api/admin?action=... ─────────────────────────────────
app.post('/api/admin', async (req, res) => {
  setCors(res)
  if (!validateAdminToken(req)) return res.status(401).json({ error: 'Unauthorized' })
  const { action } = req.query

  // 一鍵更新：同步今日訂單 + 核銷 + 7天複查
  if (action === 'run-daily-sync') {
    try {
      const result = await runDailySync()
      return res.json({ ok: true, result })
    } catch (err) {
      console.error('[run-daily-sync]', err)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  // 補跑歷史區間：先同步指定區間的訂單，再確認這批訂單截至今天的核銷狀態
  if (action === 'sync-range') {
    try {
      const { from, to } = req.body
      if (!from || !to) return res.status(400).json({ ok: false, error: '請提供 from 與 to 日期（YYYY-MM-DD）' })
      if (from > to)    return res.status(400).json({ ok: false, error: 'from 不能晚於 to' })
      const { ordersResult, redeemResult } = await syncRangeWithRedemptionCheck(from, to)
      return res.json({ ok: true, from, to, ordersResult, redeemResult })
    } catch (err) {
      console.error('[sync-range]', err)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  // 手動觸發7天複查
  if (action === 'check-expired') {
    try {
      const result = await checkExpiredOrders()
      return res.json({ ok: true, result })
    } catch (err) {
      console.error('[check-expired]', err)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  // 週報B：核銷後7天仍未入會
  if (action === 'send-report-b') {
    try {
      const result = await runReportB()
      return res.json({ ok: true, ...result })
    } catch (err) {
      console.error('[send-report-b]', err)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  // 週報A：上週下單但未入會
  if (action === 'send-report-a') {
    try {
      const result = await runReportA()
      return res.json({ ok: true, ...result })
    } catch (err) {
      console.error('[send-report-a]', err)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  // Gmail 連線診斷
  if (action === 'diagnose-mail') {
    try {
      const result = await diagnoseMail()
      return res.json({ ok: true, ...result })
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  // 測試模式開關
  if (action === 'toggle-test-mode') {
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : !getTestMode()
    setTestMode(enabled)
    return res.json({ ok: true, testMode: getTestMode() })
  }

  return res.status(404).json({ error: 'Not Found' })
})

// ── Helper：計算上週一～日的日期範圍（台北時間）────────────────
function getLastWeekRange() {
  const now      = new Date()
  const taipei   = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const day      = taipei.getUTCDay() // 0=Sun,1=Mon,...,6=Sat
  const daysToLastMonday = (day === 0 ? 6 : day - 1) + 7

  const lastMonday = new Date(taipei)
  lastMonday.setUTCDate(taipei.getUTCDate() - daysToLastMonday)
  lastMonday.setUTCHours(0, 0, 0, 0)

  const lastSunday = new Date(lastMonday)
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6)

  return {
    from: lastMonday.toISOString().slice(0, 10),
    to:   lastSunday.toISOString().slice(0, 10),
  }
}

app.listen(PORT, () => {
  console.log(`rezio-bridge running on port ${PORT}`)
})
