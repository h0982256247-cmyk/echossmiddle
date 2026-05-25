/**
 * 輕量結構化 logger
 * 輸出 JSON 格式，方便 Render log 查詢與未來接 log aggregator
 */
function log(level, tag, msg, data) {
  const entry = { time: new Date().toISOString(), level, tag, msg }
  if (data !== undefined) entry.data = data
  const line = JSON.stringify(entry)
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARN') console.warn(line)
  else console.log(line)
}

module.exports = {
  info:  (tag, msg, data) => log('INFO',  tag, msg, data),
  warn:  (tag, msg, data) => log('WARN',  tag, msg, data),
  error: (tag, msg, data) => log('ERROR', tag, msg, data),
}
