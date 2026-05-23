const ExcelJS = require('exceljs')

/**
 * 產生未入會週報 Excel Buffer
 * @param {Array} records - weekly_report_queue 列陣列
 * @param {string} periodLabel - 報表期間說明
 * @returns {Buffer}
 */
async function generateReport(records, periodLabel) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'rezio-bridge'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('未入會名單')

  sheet.columns = [
    { header: '姓名',      key: 'customer_name', width: 16 },
    { header: '手機',      key: 'phone',         width: 16 },
    { header: 'Email',     key: 'email',         width: 28 },
    { header: '訂單號',    key: 'order_no',      width: 24 },
    { header: '金額(NTD)', key: 'amount',        width: 14 },
    { header: '訂購日期',  key: 'order_date',    width: 14 },
    { header: '核銷日期',  key: 'redeem_date',   width: 14 },
  ]

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  records.forEach((r, i) => {
    const row = sheet.addRow({
      customer_name: r.customer_name,
      phone:         r.phone,
      email:         r.email,
      order_no:      r.order_no,
      amount:        Number(r.amount),
      order_date:    r.order_date,
      redeem_date:   r.redeem_date,
    })

    if (i % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } }
      })
    }

    row.getCell('amount').alignment = { horizontal: 'right' }
    row.getCell('amount').numFmt = '#,##0'
  })

  const total = records.reduce((sum, r) => sum + Number(r.amount), 0)
  const totalRow = sheet.addRow({
    customer_name: `共 ${records.length} 筆`,
    phone: '', email: '', order_no: '',
    amount: total,
    order_date: '', redeem_date: '',
  })
  totalRow.eachCell((cell) => {
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }
  })
  totalRow.getCell('amount').numFmt = '#,##0'

  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  const buffer = await workbook.xlsx.writeBuffer()
  return buffer
}

module.exports = { generateReport }
