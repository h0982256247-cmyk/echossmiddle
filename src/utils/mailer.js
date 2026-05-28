const nodemailer = require('nodemailer')
const { google }  = require('googleapis')
const { getTestMode } = require('./config')

// ── Gmail API 用的 OAuth2 client ──────────────────────────────
function makeOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  )
  client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN })
  return client
}

// ── nodemailer stream transport（只用來組 MIME，不實際發送）────
const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' })

// ── 核心發信函式（走 Gmail API，不走 SMTP）───────────────────
async function sendMail({ to, cc, subject, html, attachments }) {
  const isTestMode = getTestMode()
  const actualTo   = isTestMode ? process.env.REPORT_TO : to
  const actualCc   = isTestMode ? undefined : cc
  const actualSubj = isTestMode ? `[TEST] ${subject}` : subject

  if (isTestMode) {
    console.log(`[mailer] TEST_MODE 攔截，原收件人: ${to}${cc ? ` cc:${cc}` : ''} → 改寄 ${actualTo}`)
  }

  // 用 nodemailer 組裝完整 MIME 訊息
  const info = await streamTransport.sendMail({
    from:        `"農遊生活" <${process.env.GMAIL_USER}>`,
    to:          actualTo,
    ...(actualCc ? { cc: actualCc } : {}),
    subject:     actualSubj,
    html,
    attachments: attachments || [],
  })

  // 將 MIME stream 讀成 Buffer → base64url
  const chunks = []
  for await (const chunk of info.message) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  // 透過 Gmail REST API 發送（純 HTTPS，不走 SMTP port）
  const gmail = google.gmail({ version: 'v1', auth: makeOAuth2Client() })
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  })

  console.log(`[mailer] 寄出成功 → ${actualTo}`)
}

/**
 * 核銷當日寄信給消費者（非會員通知，請透過 LINE OA 加入會員）
 */
async function sendCustomerNotification({ email, customerName, orderNo, redeemDate, amount }) {
  const subject = '【農遊生活】感謝您的消費 — 加入會員享點數回饋'

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
      <h2 style="color: #1d4ed8;">感謝您的消費！</h2>
      <p>親愛的 <strong>${esc(customerName || '消費者')}</strong>，您好：</p>
      <p>感謝您選擇農遊生活的服務，您的訂單 <strong>${esc(orderNo)}</strong> 已於 ${esc(redeemDate)} 完成核銷。</p>
      <p>我們注意到您尚未加入農遊生活會員。<strong>立即透過 LINE OA 加入會員，即可享有消費點數回饋！</strong></p>
      <table style="border-collapse: collapse; width: 100%; font-size: 14px; margin: 16px 0;">
        <tr style="background: #eff6ff;">
          <td style="padding: 8px 12px;">訂單號碼</td>
          <td style="padding: 8px 12px; font-weight: bold;">${esc(orderNo)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px;">核銷日期</td>
          <td style="padding: 8px 12px;">${esc(redeemDate)}</td>
        </tr>
        <tr style="background: #eff6ff;">
          <td style="padding: 8px 12px;">消費金額</td>
          <td style="padding: 8px 12px;">NT$ ${Number(amount || 0).toLocaleString()}</td>
        </tr>
      </table>
      <p>請在 <strong>7 天內</strong>完成會員註冊，我們將依據您的消費金額發放對應點數。</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">此信由農遊生活系統自動發送，請勿直接回覆。</p>
    </div>
  `

  await sendMail({ to: email, cc: process.env.REPORT_TO, subject, html })
}

/**
 * 週報B：核銷後7天仍未入會的清單（含 Excel 附件，寄給農遊）
 */
async function sendReportB(excelBuffer, count, periodLabel) {
  const subject = `【週報B｜核銷未入會】${periodLabel} 共 ${count} 筆`

  const bodyContent = count === 0
    ? `<p style="color: #6b7280;">本週無資料（佇列中無待處理訂單）。</p>`
    : `
      <table style="border-collapse: collapse; width: 100%; font-size: 14px;">
        <tr style="background: #7c3aed; color: white;">
          <th style="padding: 8px 12px; text-align: left;">統計</th>
          <th style="padding: 8px 12px; text-align: right;">數量</th>
        </tr>
        <tr style="background: #f5f3ff;">
          <td style="padding: 8px 12px;">未入會訂單數</td>
          <td style="padding: 8px 12px; text-align: right;"><strong>${count} 筆</strong></td>
        </tr>
      </table>
      <p style="margin-top: 16px; color: #6b7280; font-size: 13px;">詳細名單請見附件 Excel 檔案。</p>`

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #7c3aed;">核銷未入會週報</h2>
      <p>以下是 <strong>${periodLabel}</strong> 期間，核銷後 7 天仍未加入會員的消費者名單：</p>
      ${bodyContent}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">此信由 rezio-bridge 系統自動發送，請勿直接回覆。</p>
    </div>
  `

  const attachments = excelBuffer ? [{
    filename: `核銷未入會_${periodLabel.replace(/ /g, '').replace('~', '-')}.xlsx`,
    content:  excelBuffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }] : []

  await sendMail({ to: process.env.REPORT_TO, subject, html, attachments })
}

/**
 * 週報A：上週下單但未成為會員的清單（含 Excel 附件，寄給農遊主動聯繫）
 */
async function sendReportA(excelBuffer, count, periodLabel) {
  const subject = `【週報A｜下單未入會】${periodLabel} 共 ${count} 筆`

  const bodyContent = count === 0
    ? `<p style="color: #6b7280;">本週無資料（上週訂單皆已入會或無訂單）。</p>`
    : `
      <table style="border-collapse: collapse; width: 100%; font-size: 14px;">
        <tr style="background: #0891b2; color: white;">
          <th style="padding: 8px 12px; text-align: left;">統計</th>
          <th style="padding: 8px 12px; text-align: right;">數量</th>
        </tr>
        <tr style="background: #ecfeff;">
          <td style="padding: 8px 12px;">未入會訂單數</td>
          <td style="padding: 8px 12px; text-align: right;"><strong>${count} 筆</strong></td>
        </tr>
      </table>
      <p style="margin-top: 16px; color: #6b7280; font-size: 13px;">詳細名單請見附件 Excel 檔案。</p>`

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #0891b2;">下單未入會週報</h2>
      <p>以下是 <strong>${periodLabel}</strong> 期間，已下單但尚未加入會員的消費者名單，請主動聯繫招攬：</p>
      ${bodyContent}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">此信由 rezio-bridge 系統自動發送，請勿直接回覆。</p>
    </div>
  `

  const attachments = excelBuffer ? [{
    filename: `下單未入會_${periodLabel.replace(/ /g, '').replace('~', '-')}.xlsx`,
    content:  excelBuffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }] : []

  await sendMail({ to: process.env.REPORT_TO, subject, html, attachments })
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 診斷用：測試 OAuth2 token 取得
 */
async function diagnoseMail() {
  const result = {
    envVars: {
      GMAIL_USER:          process.env.GMAIL_USER          ? '✓' : '✗ 未設定',
      GMAIL_CLIENT_ID:     process.env.GMAIL_CLIENT_ID     ? '✓' : '✗ 未設定',
      GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET ? '✓' : '✗ 未設定',
      GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN ? '✓' : '✗ 未設定',
      REPORT_TO:           process.env.REPORT_TO           ? `✓ ${process.env.REPORT_TO}` : '✗ 未設定',
    },
    oauthTokenTest: null,
    sendMethod:     'Gmail API (HTTPS)',
  }

  try {
    const params = new URLSearchParams({
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    })
    const res  = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
      signal:  AbortSignal.timeout(10000),
    })
    const body = await res.json()
    result.oauthTokenTest = body.access_token
      ? '✓ access_token 取得成功'
      : `✗ 失敗: ${body.error} — ${body.error_description}`
  } catch (err) {
    result.oauthTokenTest = `✗ 例外: ${err.message}`
  }

  return result
}

/**
 * 系統告警：同步任務失敗時寄給管理員
 * @param {{ jobName: string, error: string, lockedBy: string, at: string }} opts
 */
async function sendSyncAlert({ jobName, error, lockedBy, at }) {
  const subject = `【⚠️ 系統告警】同步任務失敗：${jobName}`
  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
      <h2 style="color: #dc2626;">⚠️ 同步任務執行失敗</h2>
      <table style="border-collapse: collapse; width: 100%; font-size: 14px; margin: 16px 0;">
        <tr style="background: #fef2f2;">
          <td style="padding: 8px 12px; font-weight: bold; width: 30%;">任務名稱</td>
          <td style="padding: 8px 12px;">${esc(jobName)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; font-weight: bold;">發生時間</td>
          <td style="padding: 8px 12px;">${esc(at)}</td>
        </tr>
        <tr style="background: #fef2f2;">
          <td style="padding: 8px 12px; font-weight: bold;">觸發來源</td>
          <td style="padding: 8px 12px;">${esc(lockedBy || '—')}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; font-weight: bold;">錯誤訊息</td>
          <td style="padding: 8px 12px; color: #dc2626; font-family: monospace;">${esc(error)}</td>
        </tr>
      </table>
      <p style="color: #6b7280; font-size: 13px; margin-top: 16px;">
        請至 Render Dashboard 查看完整 log，並確認今日資料是否需要補跑。
      </p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="color: #9ca3af; font-size: 12px;">此信由 rezio-bridge 系統自動發送，請勿直接回覆。</p>
    </div>
  `
  try {
    await sendMail({ to: process.env.REPORT_TO, subject, html })
  } catch (mailErr) {
    // 告警信寄失不應蓋掉原始錯誤，只記 log
    console.error('[mailer] sendSyncAlert 寄信失敗', mailErr.message)
  }
}

module.exports = { sendCustomerNotification, sendReportA, sendReportB, diagnoseMail, sendSyncAlert }
