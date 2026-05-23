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

module.exports = { isMember }
