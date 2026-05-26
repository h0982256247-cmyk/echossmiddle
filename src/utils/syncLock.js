/**
 * In-process sync lock
 *
 * 因為系統跑在單一 Node.js process（Render single instance），
 * 用 module-level flag 確保同一時間只有一個 sync 任務在執行，
 * 避免 cron 與手動觸發重疊造成重複發點/寄信。
 */

let _locked  = false
let _lockedBy  = null
let _lockedAt  = null

/**
 * 嘗試取得鎖
 * @param {string} by - 呼叫來源標識（用於 log）
 * @returns {boolean} true = 成功取得；false = 已有人持有鎖
 */
function acquire(by = 'unknown') {
  if (_locked) return false
  _locked   = true
  _lockedBy = by
  _lockedAt = new Date().toISOString()
  return true
}

/** 釋放鎖（務必在 finally 中呼叫） */
function release() {
  _locked   = false
  _lockedBy = null
  _lockedAt = null
}

function isLocked() { return _locked }

/** 回傳目前鎖狀態（供 log / debug 使用） */
function lockStatus() {
  return { locked: _locked, by: _lockedBy, at: _lockedAt }
}

module.exports = { acquire, release, isLocked, lockStatus }
