/**
 * 查詢手機號碼是否已是 Echoss 會員
 *
 * @param {string} phone - 本地格式，例如 "0912345678"
 * @returns {{ isMember: boolean }}
 */
async function isMember(phone) {
  // TODO: 串接 Echoss API
  // 範例實作（取得 API 文件後替換）：
  //
  // const res = await axios.get(`${process.env.ECHOSS_API_URL}/member`, {
  //   headers: { Authorization: `Bearer ${process.env.ECHOSS_API_TOKEN}` },
  //   params:  { phone },
  // })
  // const member = res.data?.data
  // return { isMember: !!member }

  return { isMember: false }
}

/**
 * 發點給會員
 *
 * @param {string} phone          - 本地格式，例如 "0912345678"
 * @param {number} points         - 要發的點數
 * @param {string} idempotencyKey - 冪等鍵（建議帶入 order_no），串接時傳給 Echoss 防止重複發點
 * @returns {{ echossStatus: string, raw: object }}
 *   echossStatus - Echoss API 回傳的 status 字串（例如 'success' / 'duplicate' 等）
 *   raw          - Echoss API 完整回傳 JSON（供除錯與記錄用）
 */
async function issuePoints(phone, points, idempotencyKey) {
  // TODO: 串接 Echoss API
  // 範例實作（取得 API 文件後替換）：
  //
  // const res = await axios.post(
  //   `${process.env.ECHOSS_API_URL}/points/issue`,
  //   { phone, points, idempotency_key: idempotencyKey },
  //   {
  //     headers:        { Authorization: `Bearer ${process.env.ECHOSS_API_TOKEN}` },
  //     timeout:        15_000,   // 15 秒 timeout
  //   }
  // )
  // return { echossStatus: res.data?.status, raw: res.data }
  //
  // Echoss timeout 判斷：
  //   axios timeout → err.code === 'ECONNABORTED'
  //   上層 (issuePoints in dailySync) 會 catch 並標記 'timeout'

  // 暫時模擬成功（串接後移除）
  return { echossStatus: 'pending_integration', raw: { note: 'Echoss API 尚未串接' } }
}

/**
 * 查詢 Echoss 是否已對某筆訂單發過點（timeout 後重試前的確認用）
 *
 * @param {string} orderNo - 訂單編號（作為查詢鍵）
 * @returns {{ wasIssued: boolean, echossStatus: string|null, raw: object }}
 *   wasIssued    - true = Echoss 那邊確認有發過；false = 確認沒發過
 *   echossStatus - Echoss 回傳的狀態字串
 *   raw          - 完整回傳 JSON（供記錄用）
 */
async function getIssuanceHistory(orderNo) {
  // TODO: 串接 Echoss API
  // 範例實作（取得 API 文件後替換）：
  //
  // const res = await axios.get(
  //   `${process.env.ECHOSS_API_URL}/points/history`,
  //   {
  //     headers: { Authorization: `Bearer ${process.env.ECHOSS_API_TOKEN}` },
  //     params:  { order_no: orderNo },
  //     timeout: 15_000,
  //   }
  // )
  // const record = res.data?.data
  // return {
  //   wasIssued:    !!record,
  //   echossStatus: record?.status ?? null,
  //   raw:          res.data,
  // }

  // 暫時回傳「查不到」（串接後移除）
  return { wasIssued: false, echossStatus: null, raw: { note: 'Echoss API 尚未串接' } }
}

module.exports = { isMember, issuePoints, getIssuanceHistory }
