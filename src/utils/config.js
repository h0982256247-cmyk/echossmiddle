/**
 * Runtime config — 初始值從環境變數讀取，可在執行中透過 API 切換
 * 重啟後回到環境變數預設值
 */
const state = {
  testMode: process.env.TEST_MODE === 'true',
}

function getTestMode() {
  return state.testMode
}

function setTestMode(enabled) {
  state.testMode = !!enabled
  console.log(`[config] TEST_MODE ${enabled ? '🟡 開啟（信件只寄給自己）' : '🟢 關閉（正常寄送）'}`)
}

module.exports = { getTestMode, setTestMode }
