require('dotenv').config()
const express = require('express')
const path    = require('path')
const { runDailySync, checkExpiredOrders, processInBatches, syncRangeWithRedemptionCheck } = require('./jobs/dailySync')
const echoss = require('./services/echoss')
const db = require('./services/db')
const { generateReport } = require('./utils/report')
const { sendReportA, sendReportB, diagnoseMail } = require('./utils/mailer')
const { getTestMode, setTestMode } = require('./utils/config')
const log = require('./utils/logger')

const app  = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

// ── CORS ──────────────────────────────────────────────────────
// 只在設定 ALLOWED_ORIGIN 時加 header；同源部署不需要設定
function setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN
  if (!origin) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token')
}

app.options('/api/admin', (req, res) => { setCors(res); res.sendStatus(200) })

// ── Login rate limiting（in-memory，每 IP 15 分鐘內最多 10 次）──
const loginAttempts = new Map()
const RATE_LIMIT    = { max: 10, windowMs: 15 * 60 * 1000 }

function isRateLimited(ip) {
  const now   = Date.now()
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + RATE_LIMIT.windowMs }
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_LIMIT.windowMs }
  entry.count++
  loginAttempts.set(ip, entry)
  return entry.count > RATE_LIMIT.max
}

// 每小時清理過期紀錄，避免 memory leak
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip)
  }
}, 60 * 60 * 1000)

// ── Admin JWT 驗證 ────────────────────────────────────────────
async function validateAdminToken(req) {
  const token = req.headers['x-admin-token'] || ''
  return db.validateAuthToken(token)
}

// ── POST /api/login ───────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  setCors(res)
  const ip = req.ip || req.socket.remoteAddress
  if (isRateLimited(ip)) {
    log.warn('login', '登入次數過多', { ip })
    return res.status(429).json({ ok: false, error: '登入嘗試次數過多，請 15 分鐘後再試' })
  }
  try {
    const { email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ ok: false, error: '請提供 Email 與密碼' })
    // Log sanitized info to help diagnose autofill issues (never log actual password)
    log.info('login', `嘗試登入`, { email, pwLen: password.length })
    const session = await db.authSignIn(email, password)
    log.info('login', `登入成功`, { email })
    return res.json({ ok: true, ...session })
  } catch (err) {
    log.warn('login', `登入失敗`, { error: err.message })
    return res.status(401).json({ ok: false, error: err.message || '帳號或密碼錯誤' })
  }
})

// ── POST /api/refresh ─────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  setCors(res)
  try {
    const { refreshToken } = req.body || {}
    if (!refreshToken) return res.status(400).json({ ok: false, error: '請提供 refreshToken' })
    const session = await db.authRefresh(refreshToken)
    return res.json({ ok: true, ...session })
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message })
  }
})

// ── 週報邏輯 ─────────────────────────────────────────────────

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
  log.info('report-a', `已寄出`, { count: nonMembers.length, period: periodLabel })
  return { skipped: false, message: `週報A已寄出，共 ${nonMembers.length} 筆`, count: nonMembers.length }
}

async function runReportB() {
  const records = await db.getWeeklyQueue()
  const dates   = records.map(r => r.redeem_date).filter(Boolean).sort()
  const periodLabel = dates.length
    ? `${dates[0]} ~ ${dates[dates.length - 1]}`
    : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date())
  const excelBuffer = records.length > 0 ? await generateReport(records, periodLabel) : null
  await sendReportB(excelBuffer, records.length, periodLabel)
  await db.clearWeeklyQueue()
  await db.updateLastSentAt()
  log.info('report-b', `已寄出`, { count: records.length, period: periodLabel })
  return { skipped: false, message: `週報B已寄出，共 ${records.length} 筆`, count: records.length }
}

// ── POST /api/run（pg_cron 每小時觸發）───────────────────────
app.post('/api/run', (req, res) => {
  const auth   = req.headers['authorization'] || ''
  const secret = process.env.CRON_SECRET
  if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' })

  res.status(202).json({ ok: true, message: 'daily sync started' })
  runDailySync()
    .then(r  => log.info('api/run', '完成', r))
    .catch(e => log.error('api/run', '執行失敗', { error: e.message }))
})

// ── POST /api/run-weekly（pg_cron 每週一觸發）────────────────
app.post('/api/run-weekly', (req, res) => {
  const auth   = req.headers['authorization'] || ''
  const secret = process.env.CRON_SECRET
  if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' })

  res.status(202).json({ ok: true, message: 'weekly sync started' })
  Promise.all([runReportA(), runReportB()])
    .then(([a, b]) => log.info('api/run-weekly', '完成', { a, b }))
    .catch(e       => log.error('api/run-weekly', '執行失敗', { error: e.message }))
})

// ── GET /api/admin?action=status ──────────────────────────────
app.get('/api/admin', async (req, res) => {
  setCors(res)
  if (!(await validateAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' })
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
        orders:          ordersResult.rows,
        totalOrders:     ordersResult.total,
        page,
        pageSize,
        totalPages:      Math.ceil(ordersResult.total / pageSize),
        stats,
        weeklyQueueCount: queueCount,
        lastSentAt:      lastSentAt?.toISOString() || null,
        now:             new Date().toISOString(),
        testMode:        getTestMode(),
      })
    } catch (err) {
      log.error('api/admin', 'status 失敗', { error: err.message })
      return res.status(500).json({ error: err.message })
    }
  }

  return res.status(404).json({ error: 'Not Found' })
})

// ── POST /api/admin?action=... ────────────────────────────────
app.post('/api/admin', async (req, res) => {
  setCors(res)
  if (!(await validateAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' })
  const { action } = req.query

  if (action === 'run-daily-sync') {
    try {
      const result = await runDailySync()
      return res.json({ ok: true, result })
    } catch (err) {
      log.error('run-daily-sync', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  if (action === 'sync-range') {
    try {
      const { from, to } = req.body
      if (!from || !to) return res.status(400).json({ ok: false, error: '請提供 from 與 to 日期（YYYY-MM-DD）' })
      if (from > to)    return res.status(400).json({ ok: false, error: 'from 不能晚於 to' })
      const { ordersResult, redeemResult } = await syncRangeWithRedemptionCheck(from, to)
      return res.json({ ok: true, from, to, ordersResult, redeemResult })
    } catch (err) {
      log.error('sync-range', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  if (action === 'check-expired') {
    try {
      const result = await checkExpiredOrders()
      return res.json({ ok: true, result })
    } catch (err) {
      log.error('check-expired', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  if (action === 'send-report-b') {
    try {
      const result = await runReportB()
      return res.json({ ok: true, ...result })
    } catch (err) {
      log.error('send-report-b', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  if (action === 'send-report-a') {
    try {
      const result = await runReportA()
      return res.json({ ok: true, ...result })
    } catch (err) {
      log.error('send-report-a', err.message)
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  if (action === 'diagnose-mail') {
    try {
      const result = await diagnoseMail()
      return res.json({ ok: true, ...result })
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message })
    }
  }

  if (action === 'toggle-test-mode') {
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : !getTestMode()
    setTestMode(enabled)
    return res.json({ ok: true, testMode: getTestMode() })
  }

  return res.status(404).json({ error: 'Not Found' })
})

// ── Helper：上週一～日（台北時間，使用 Intl）──────────────────
function getLastWeekRange() {
  const tz         = 'Asia/Taipei'
  const todayStr   = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date())
  const todayDate  = new Date(todayStr + 'T00:00:00Z')
  const day        = todayDate.getUTCDay()                    // 0=Sun … 6=Sat
  const toLastMon  = (day === 0 ? 6 : day - 1) + 7           // 往回至少一整週

  const lastMonday = new Date(todayDate)
  lastMonday.setUTCDate(todayDate.getUTCDate() - toLastMon)

  const lastSunday = new Date(lastMonday)
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6)

  return {
    from: lastMonday.toISOString().slice(0, 10),
    to:   lastSunday.toISOString().slice(0, 10),
  }
}

app.listen(PORT, () => log.info('server', `rezio-bridge running on port ${PORT}`))
