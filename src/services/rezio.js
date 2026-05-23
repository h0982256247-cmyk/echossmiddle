const axios = require('axios')

const client = axios.create({
  baseURL: 'https://api.rezio.io',
  headers: {
    'Content-Type': 'application/json',
    'X-Lang': process.env.REZIO_LANG || 'zh-TW',
    'X-Auth-StoreUuid': process.env.REZIO_STORE_UUID,
    'X-Auth-Key': process.env.REZIO_API_KEY,
  },
  timeout: 15000,
})

/**
 * 取得指定日期範圍的核銷紀錄
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} [toDate] - YYYY-MM-DD，預設同 fromDate
 * @returns {Array}
 */
async function getRedemptions(fromDate, toDate) {
  if (!toDate) toDate = fromDate
  const records = []
  let page = 1

  while (true) {
    const res = await client.get('/v1/redeem/list', {
      params: { from: fromDate, to: toDate, page, itemPerPage: 20, sort: 'redeemASC' },
    })

    const data = res.data?.data
    if (!data || !Array.isArray(data.list)) {
      console.warn('[rezio] getRedemptions 非預期回應:', JSON.stringify(res.data))
      break
    }

    records.push(...data.list)
    if (!data.list.length || records.length >= (data.totalCount || 0)) break
    page++
  }

  return records
}

/**
 * 取得指定訂購日期範圍的訂單列表（不含詳情）
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} [toDate] - YYYY-MM-DD，預設同 fromDate
 * @returns {Array}
 */
async function getOrders(fromDate, toDate) {
  if (!toDate) toDate = fromDate
  const records = []
  let page = 1

  while (true) {
    const res = await client.get('/v1/order/list', {
      params: { dateType: 1, from: fromDate, to: toDate, page, itemPerPage: 20 },
    })

    const data = res.data?.data
    if (!data || !Array.isArray(data.list)) {
      console.warn('[rezio] getOrders 非預期回應:', JSON.stringify(res.data))
      break
    }

    records.push(...data.list)
    if (!data.list.length || records.length >= (data.totalCount || 0)) break
    page++
  }

  return records
}

/**
 * 用訂單號取得訂單摘要（含金額、姓名、uuid）
 * @param {string} orderNo
 * @returns {object|null}
 */
async function getOrderByOrderNo(orderNo) {
  try {
    const res = await client.get('/v1/order/list', {
      params: { text: orderNo, itemPerPage: 20 },
    })
    const list = res.data.data?.list || []
    const found = list.find((o) => o.orderNo === orderNo) || null
    if (!found) console.warn(`[rezio] orderNo=${orderNo} 搜尋結果:`, JSON.stringify(list.slice(0, 2)))
    return found
  } catch (err) {
    console.error(`[rezio] getOrderByOrderNo ${orderNo} 失敗: ${err.response?.status}`, JSON.stringify(err.response?.data))
    throw err
  }
}

/**
 * 取得訂單詳情，回傳手機號碼、email 與金額
 * @param {string} orderNo - 訂單編號
 * @returns {{ phone: string|null, email: string|null, amount: number }}
 */
async function getOrderDetail(orderNo) {
  const res = await client.get(`/v1/order/${orderNo}/detail`)
  const data = res.data.data

  const contactInfo = data.contactInfo || {}
  const bookingInfoConfig = data.bookingInfoConfig || []

  // 取手機
  let phone = null
  const phoneConfig = bookingInfoConfig.find((c) => c.type === 'phone')
  if (phoneConfig) {
    const value = contactInfo[phoneConfig.uuid]
    if (value) phone = normalizePhone(value)
  }

  if (!phone) {
    for (const value of Object.values(contactInfo)) {
      if (Array.isArray(value) && value.length === 2) {
        phone = normalizePhone(value)
        if (phone) break
      }
    }
  }

  // 取 email
  let email = null
  const emailConfig = bookingInfoConfig.find((c) => c.type === 'email')
  if (emailConfig) {
    const value = contactInfo[emailConfig.uuid]
    if (value && typeof value === 'string') email = value.trim()
  }

  return { phone, email, amount: data.amount ?? 0 }
}

/**
 * 將 rezio 手機格式轉為本地格式
 * ["886", "0912345678"] → "0912345678"
 * ["886", "912345678"]  → "0912345678"（補0）
 * "0912345678"          → "0912345678"
 */
function normalizePhone(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const local = String(value[1])
    return local.startsWith('0') ? local : '0' + local
  }
  if (typeof value === 'string') {
    return value.startsWith('0') ? value : '0' + value
  }
  return null
}

module.exports = { getRedemptions, getOrders, getOrderByOrderNo, getOrderDetail }
