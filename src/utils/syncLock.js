/**
 * In-process sync lock
 *
 * 因為系統跑在單一 Node.js process（Render single instance），
 * 用 module-level flag 確保同一時間只有一個 sync 任務在執行，
 * 避免 cron 與手動觸發重疊造成重複發點/寄信。
 *
 * 防卡死機制：
 *   如果 sync 任務因 DB 連線卡住、uncaught hang 等原因遲遲不釋放鎖，
 *   超過 LOCK_TIMEOUT_MS 後 acquire() 會強制釋放舊鎖並重新取得。
 */

const LOCK_TIMEOUT_MS = 90 * 60 * 1000  // 90 分鐘（一輪 sync 最多不應超過此時間）

let _locked   = false
let _lockedBy = null
let _lockedAt = null   // Date.now() 數值（方便計算 elapsed）

/**
 * 判斷目前的鎖是否已逾時（持有時間超過 LOCK_TIMEOUT_MS）
 */
function isStale() {
  if (!_locked || _lockedAt === null) return false
  return Date.now() - _lockedAt > LOCK_TIMEOUT_MS
}

/**
 * 嘗試取得鎖
 * @param {string} by - 呼叫來源標識（用於 log）
 * @returns {{ ok: boolean, staleForced: boolean }}
 *   ok          = true：成功取得鎖
 *   staleForced = true：舊鎖已逾時，強制釋放後才取得（需要告警）
 */
function acquire(by = 'unknown') {
  const staleForced = _locked && isStale()

  if (_locked && !staleForced) return { ok: false, staleForced: false }

  _locked   = true
  _lockedBy = by
  _lockedAt = Date.now()
  return { ok: true, staleForced }
}

/** 釋放鎖（務必在 finally 中呼叫） */
function release() {
  _locked   = false
  _lockedBy = null
  _lockedAt = null
}

/** 強制釋放（管理員手動解鎖用） */
function forceRelease() {
  const prev = lockStatus()
  release()
  return prev
}

function isLocked() { return _locked }

/** 回傳目前鎖狀態（供 log / debug / admin UI 使用） */
function lockStatus() {
  return {
    locked:    _locked,
    by:        _lockedBy,
    at:        _lockedAt ? new Date(_lockedAt).toISOString() : null,
    elapsedMs: _lockedAt ? Date.now() - _lockedAt : null,
    stale:     isStale(),
  }
}

module.exports = { acquire, release, forceRelease, isLocked, lockStatus, LOCK_TIMEOUT_MS }
