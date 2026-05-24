const nodemailer = require('nodemailer')
const { getTestMode } = require('./config')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.GMAIL_USER,
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
  },
})

async function sendMail({ to, cc, subject, html, attachments }) {
  const isTestMode = getTestMode()
  const actualTo   = isTestMode ? process.env.REPORT_TO : to
  const actualCc   = isTestMode ? undefined : cc
  const actualSubj = isTestMode ? `[TEST] ${subject}` : subject

  if (isTestMode) {
    console.log(`[mailer] TEST_MODE 攔截，原收件人: ${to}${cc ? ` cc:${cc}` : ''} → 改寄 ${actualTo}`)
  }

  await transporter.sendMail({
    from: `"農遊生活" <${process.env.GMAIL_USER}>`,
    to:   actualTo,
    ...(actualCc ? { cc: actualCc } : {}),
    subject: actualSubj,
    html,
    attachments,
  })
}

/**
 * 核銷當日寄信給消費者（非會員通知，請透過 LINE OA 加入會員）
 */
async function sendCustomerNotification({ email, customerName, orderNo, redeemDate, amount }) {
  // TODO: 信件內容待確認後補上
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

module.exports = { sendCustomerNotification, sendReportA, sendReportB }
