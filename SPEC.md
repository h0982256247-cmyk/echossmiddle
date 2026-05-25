# 農遊生活 會員點數整合系統 技術規格表

**文件版本**：v1.0
**撰寫日期**：2026-05-25
**系統代號**：rezio-bridge

---

## 一、資料庫 Schema

### 1.1 orders（訂單主表）

| 欄位名稱 | 型別 | Nullable | 預設值 | 說明 |
|---|---|---|---|---|
| `id` | bigint | NO | auto increment | 自動遞增主鍵 |
| `order_no` | text | NO | — | Rezio 訂單號，唯一索引（UNIQUE） |
| `customer_name` | text | YES | null | 消費者姓名（姓+名合併） |
| `phone` | text | YES | null | 手機號碼，本地格式，如 `0912345678` |
| `email` | text | YES | null | 電子信箱 |
| `order_date` | date | YES | null | 下單日期（台北時間） |
| `redeem_date` | date | YES | null | 核銷日期（台北時間） |
| `amount` | numeric | YES | 0 | 消費金額（NTD），整數或小數 |
| `status` | text | NO | `'待核銷'` | 狀態值，見狀態機規格 |
| `is_member_at_redeem` | boolean | YES | null | 核銷當下是否為 Echoss 會員；`null` = 無手機無法查詢 |
| `check_due_date` | date | YES | null | 7天複查截止日 = `redeem_date + 7天` |
| `customer_notified` | boolean | YES | null | 是否已寄入會通知信給消費者 |
| `points_issued` | boolean | YES | null | 是否已呼叫 Echoss 發點 API |
| `created_at` | timestamptz | NO | `now()` | 記錄建立時間（UTC） |
| `updated_at` | timestamptz | YES | null | 記錄更新時間（由 trigger 自動更新） |

**索引**：
- PRIMARY KEY: `id`
- UNIQUE: `order_no`
- INDEX: `status`
- INDEX: `check_due_date`

**狀態值（status）**：

| 值 | 說明 |
|---|---|
| `待核銷` | 初始狀態，訂單已建立但尚未核銷 |
| `待複查` | 已核銷但非會員，等待7天後複查 |
| `已發點` | 已核銷且為會員，點數已發放 |
| `已結案` | 7天複查完成，流程終止 |

---

### 1.2 weekly_report_queue（週報B佇列）

| 欄位名稱 | 型別 | Nullable | 預設值 | 說明 |
|---|---|---|---|---|
| `id` | bigint | NO | auto increment | 自動遞增主鍵 |
| `order_no` | text | NO | — | Rezio 訂單號，唯一索引 |
| `customer_name` | text | YES | null | 消費者姓名 |
| `phone` | text | YES | null | 手機號碼 |
| `email` | text | YES | null | 電子信箱 |
| `order_date` | date | YES | null | 下單日期 |
| `redeem_date` | date | YES | null | 核銷日期 |
| `amount` | numeric | YES | null | 消費金額（NTD） |
| `created_at` | timestamptz | NO | `now()` | 加入佇列時間 |

**索引**：
- PRIMARY KEY: `id`
- UNIQUE: `order_no`（同一訂單不重複加入）

---

### 1.3 report_schedule（週報排程記錄）

| 欄位名稱 | 型別 | Nullable | 預設值 | 說明 |
|---|---|---|---|---|
| `id` | integer | NO | — | 固定為 `1`（單列） |
| `last_sent_at` | timestamptz | YES | null | 最後一次寄出週報B的時間 |

---

## 二、API 規格

### 2.1 POST /api/login

**說明**：帳號密碼登入，回傳 JWT session

**Request Header**：
```
Content-Type: application/json
```

**Request Body**：
```json
{
  "email": "admin@example.com",
  "password": "yourpassword"
}
```

**Response 200（成功）**：
```json
{
  "ok": true,
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": 1748233415
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `ok` | boolean | 是否成功 |
| `accessToken` | string | JWT access token（預設1小時有效） |
| `refreshToken` | string | Refresh token（預設7天有效） |
| `expiresAt` | number | Access token 到期時間（Unix timestamp，秒） |

**Response 400（缺少欄位）**：
```json
{
  "ok": false,
  "error": "請提供 Email 與密碼"
}
```

**Response 401（帳密錯誤）**：
```json
{
  "ok": false,
  "error": "Invalid login credentials"
}
```

**Response 429（登入次數過多）**：
```json
{
  "ok": false,
  "error": "登入嘗試次數過多，請 15 分鐘後再試"
}
```

**限流規則**：每個 IP 在 15 分鐘內最多 10 次嘗試

---

### 2.2 POST /api/refresh

**說明**：用 refresh token 換新 access token

**Request Body**：
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response 200（成功）**：
```json
{
  "ok": true,
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": 1748237015
}
```

**Response 400（缺少 token）**：
```json
{
  "ok": false,
  "error": "請提供 refreshToken"
}
```

**Response 401（token 無效或已過期）**：
```json
{
  "ok": false,
  "error": "Session 已過期，請重新登入"
}
```

---

### 2.3 GET /api/admin?action=status

**說明**：取得訂單列表與統計數字

**Request Header**：
```
X-Admin-Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Query 參數**：

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `action` | string | YES | 固定值 `status` |
| `page` | number | NO | 頁碼，預設 `1` |
| `statusFilter` | string | NO | 狀態篩選，值為 `待核銷`/`待複查`/`已發點`/`已結案`，空值=全部 |

**Response 200（成功）**：
```json
{
  "orders": [
    {
      "id": 1,
      "order_no": "RZ260525XV9536",
      "customer_name": "李姿璇",
      "phone": "0910807903",
      "email": "angel09031984@gmail.com",
      "order_date": "2026-05-25",
      "redeem_date": null,
      "amount": "0",
      "status": "待核銷",
      "is_member_at_redeem": null,
      "check_due_date": null,
      "customer_notified": null,
      "points_issued": null,
      "created_at": "2026-05-25T04:00:00.000Z"
    }
  ],
  "totalOrders": 29,
  "page": 1,
  "pageSize": 50,
  "totalPages": 1,
  "stats": {
    "pending": 22,
    "review": 7,
    "pointed": 0,
    "closed": 0
  },
  "weeklyQueueCount": 3,
  "lastSentAt": "2026-05-19T02:00:00.000Z",
  "now": "2026-05-25T05:23:35.333Z",
  "testMode": false
}
```

| 欄位 | 說明 |
|---|---|
| `stats.pending` | 待核銷訂單數 |
| `stats.review` | 待複查訂單數 |
| `stats.pointed` | 已發點訂單數 |
| `stats.closed` | 已結案訂單數 |
| `weeklyQueueCount` | 週報B佇列中的筆數 |
| `lastSentAt` | 上次寄出週報B的時間（ISO 8601） |

---

### 2.4 POST /api/admin?action=run-daily-sync

**說明**：手動觸發每日同步（同步當日訂單 + 核銷 + 7天複查）

**Response 200（成功）**：
```json
{
  "ok": true,
  "result": {
    "ordersResult": {
      "synced": 5,
      "newOrders": 3
    },
    "redeemResult": {
      "synced": 2,
      "memberCount": 1,
      "notifiedCount": 1
    },
    "expiredResult": {
      "checked": 4,
      "memberCount": 1,
      "queuedCount": 3
    }
  }
}
```

---

### 2.5 POST /api/admin?action=sync-range

**說明**：補跑指定日期區間的訂單與核銷

**Request Body**：
```json
{
  "from": "2026-05-01",
  "to": "2026-05-25"
}
```

**日期格式**：`YYYY-MM-DD`，`from` 不可晚於 `to`

**Response 200（成功）**：
```json
{
  "ok": true,
  "from": "2026-05-01",
  "to": "2026-05-25",
  "ordersResult": {
    "synced": 45,
    "newOrders": 29
  },
  "redeemResult": {
    "synced": 18,
    "memberCount": 0,
    "notifiedCount": 7,
    "skipped": 11
  }
}
```

**Response 400（參數錯誤）**：
```json
{
  "ok": false,
  "error": "請提供 from 與 to 日期（YYYY-MM-DD）"
}
```
```json
{
  "ok": false,
  "error": "from 不能晚於 to"
}
```

---

### 2.6 POST /api/admin?action=check-expired

**說明**：單獨觸發7天到期複查

**Response 200（成功）**：
```json
{
  "ok": true,
  "result": {
    "checked": 4,
    "memberCount": 1,
    "queuedCount": 3
  }
}
```

---

### 2.7 POST /api/admin?action=send-report-a

**說明**：手動寄出週報A（上週下單未入會名單）

**Response 200（成功）**：
```json
{
  "ok": true,
  "skipped": false,
  "message": "週報A已寄出，共 5 筆",
  "count": 5
}
```

---

### 2.8 POST /api/admin?action=send-report-b

**說明**：手動寄出週報B（核銷後7天仍未入會），寄出後自動清空佇列

**Response 200（成功）**：
```json
{
  "ok": true,
  "skipped": false,
  "message": "週報B已寄出，共 3 筆",
  "count": 3
}
```

---

### 2.9 POST /api/admin?action=toggle-test-mode

**說明**：切換測試模式開關

**Request Body（可選）**：
```json
{
  "enabled": true
}
```
> 若不傳 `enabled`，則自動切換（toggle）

**Response 200**：
```json
{
  "ok": true,
  "testMode": true
}
```

---

### 2.10 POST /api/admin?action=diagnose-mail

**說明**：診斷 Gmail OAuth2 設定是否正常

**Response 200**：
```json
{
  "ok": true,
  "envVars": {
    "GMAIL_USER": "✓",
    "GMAIL_CLIENT_ID": "✓",
    "GMAIL_CLIENT_SECRET": "✓",
    "GMAIL_REFRESH_TOKEN": "✓",
    "REPORT_TO": "✓ admin@example.com"
  },
  "oauthTokenTest": "✓ access_token 取得成功",
  "sendMethod": "Gmail API (HTTPS)"
}
```

---

### 2.11 POST /api/run（pg_cron 觸發）

**說明**：每小時自動觸發每日同步

**Request Header**：
```
Authorization: Bearer <CRON_SECRET>
```

**Response 202（已接受，非同步執行）**：
```json
{
  "ok": true,
  "message": "daily sync started"
}
```

**Response 401（token 錯誤）**：
```json
{
  "error": "Unauthorized"
}
```

---

### 2.12 POST /api/run-weekly（pg_cron 觸發）

**說明**：每週一自動觸發週報A + 週報B

**Request Header**：
```
Authorization: Bearer <CRON_SECRET>
```

**Response 202**：
```json
{
  "ok": true,
  "message": "weekly sync started"
}
```

---

### 通用錯誤格式

| HTTP Status | 情境 |
|---|---|
| `400` | 請求參數格式錯誤或缺少必要欄位 |
| `401` | 未帶 token 或 token 無效/過期 |
| `404` | action 不存在 |
| `429` | 登入限流（15分鐘內超過10次） |
| `500` | 伺服器內部錯誤（DB/外部API異常） |

```json
{
  "ok": false,
  "error": "錯誤說明文字"
}
```

---

## 三、商業邏輯規格

### 3.1 日期計算

**取得今日日期（台北時間）**：
```javascript
new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date())
// 輸出格式：YYYY-MM-DD，例如 "2026-05-25"
```

**計算7天後日期**：
```javascript
const d = new Date(dateStr + 'T00:00:00Z')
d.setUTCDate(d.getUTCDate() + 7)
// 輸出格式：YYYY-MM-DD
```

---

### 3.2 點數計算

```
points = Math.floor(amount)
```

| 消費金額 | 發點數 |
|---|---|
| NT$ 720 | 720 點 |
| NT$ 5,600 | 5,600 點 |
| NT$ 0 | 0 點 |
| NT$ 299.9 | 299 點（無條件捨去） |

---

### 3.3 核銷處理判斷邏輯

```
輸入：orderNo, redeemDate, order（DB 記錄）

1. 若 order.redeem_date 已存在 AND is_member_at_redeem !== null
   → 已處理過，跳過（return null）

2. 若 order.phone 為 null
   → 設定 check_due_date = redeemDate + 7天
   → 狀態改為「待複查」，is_member_at_redeem = null
   → return null

3. 呼叫 Echoss API 查詢 phone 是否為會員

4. 若 isMember = true
   → 狀態改為「已發點」
   → 呼叫 Echoss 發點 API（1元=1點）
   → 標記 points_issued = true
   → return 'member'

5. 若 isMember = false
   → 設定 check_due_date = redeemDate + 7天
   → 狀態改為「待複查」，customer_notified = false
   → 若 order.email 存在：寄入會通知信，標記 customer_notified = true
   → 若 order.email 不存在：記錄 warn log，跳過寄信
   → return 'notified'
```

---

### 3.4 7天複查邏輯

```
查詢條件：check_due_date <= 今日 AND is_member_at_redeem = false

對每筆訂單：

1. 若 phone 為 null
   → 加入 weekly_report_queue
   → 結案（status = '已結案'）
   → return 'queued'

2. 呼叫 Echoss API 查詢是否已入會

3. 若 isMember = true
   → 呼叫 Echoss 發點 API
   → 結案（status = '已結案'，points_issued = true）
   → return 'member'

4. 若 isMember = false
   → 加入 weekly_report_queue
   → 結案（status = '已結案'）
   → return 'queued'
```

---

### 3.5 手機號碼正規化

**輸入格式（Rezio API）**：
```json
["886", "912345678"]   // 陣列格式，國碼 + 號碼（無開頭0）
["886", "0912345678"]  // 陣列格式，號碼有開頭0
"0912345678"           // 字串格式
```

**輸出格式（本地）**：
```
"0912345678"
```

**規則**：
- 若號碼不以 `0` 開頭 → 補 `0`
- 若已以 `0` 開頭 → 原樣保留
- 國碼 `886` 僅作識別，不保留在輸出

---

### 3.6 金額 Fallback 順序

```javascript
amount = detailAmount ?? orderListAmount ?? orderListAmout ?? 0
```

> 注意：`amout` 為 Rezio API 本身的 typo，非程式錯誤

使用 `??`（nullish coalescing），`0` 視為有效金額，不會 fallthrough

---

### 3.7 上週日期計算（週報A）

```javascript
// 台北時間今日
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date())

// 計算上週一
const day = todayDate.getUTCDay()  // 0=日, 1=一 ... 6=六
const daysBack = (day === 0 ? 6 : day - 1) + 7  // 往回至少一整週

// 結果：上週一到上週日
from = lastMonday  // 上週一
to   = lastSunday  // 上週日（= lastMonday + 6天）
```

---

## 四、並發與批次規格

### 4.1 批次處理

```
CONCURRENCY = 5（每批同時處理5筆）

每批執行 Promise.all(batch.map(fn))
批次間依序執行，不並發
```

適用於：syncNewOrders、syncRedemptions、checkExpiredOrders、runReportA

---

### 4.2 去重邏輯

**核銷記錄去重**（同一訂單號只保留一筆）：
```javascript
const unique = Array.from(new Map(records.map(r => [r.orderNo, r])).values())
```

---

## 五、外部 API 規格

### 5.1 Rezio API

**Base URL**：`https://api.rezio.io`

**共用 Header**：
```
Content-Type: application/json
X-Lang: zh-TW
X-Auth-StoreUuid: {REZIO_STORE_UUID}
X-Auth-Key: {REZIO_API_KEY}
```

**Timeout**：15,000ms

#### GET /v1/order/list（取得訂單列表）

Query 參數：

| 參數 | 說明 |
|---|---|
| `dateType` | `1` = 依下單日期篩選 |
| `from` | 起始日期 YYYY-MM-DD |
| `to` | 結束日期 YYYY-MM-DD |
| `page` | 頁碼（從1開始） |
| `itemPerPage` | 每頁筆數（最大20） |

Response 關鍵欄位：

| 欄位 | 說明 |
|---|---|
| `data.list` | 訂單陣列 |
| `data.totalCount` | 總筆數 |
| `list[].orderNo` | 訂單號 |
| `list[].contactLastName` | 姓 |
| `list[].contactFirstName` | 名 |
| `list[].amount` | 金額（主要） |
| `list[].amout` | 金額（Rezio typo，備用） |
| `list[].createdAt` | 下單時間（ISO 8601） |

#### GET /v1/order/{orderNo}/detail（取得訂單詳情）

Response 關鍵欄位：

| 欄位 | 說明 |
|---|---|
| `data.contactInfo` | 聯絡資訊 key-value map |
| `data.bookingInfoConfig` | 欄位設定陣列（type: phone/email） |
| `data.amount` | 消費金額 |

手機取得邏輯：
1. 找 `bookingInfoConfig` 中 `type === 'phone'` 的設定
2. 用其 `uuid` 查 `contactInfo[uuid]`
3. 若找不到，掃描 `contactInfo` 所有值，找長度為2的陣列（[國碼, 號碼]）

#### GET /v1/redeem/list（取得核銷記錄）

Query 參數：

| 參數 | 說明 |
|---|---|
| `from` | 起始日期 YYYY-MM-DD |
| `to` | 結束日期 YYYY-MM-DD |
| `page` | 頁碼 |
| `itemPerPage` | 每頁筆數（最大20） |
| `sort` | `redeemASC` |

Response 關鍵欄位：

| 欄位 | 說明 |
|---|---|
| `data.list[].orderNo` | 訂單號 |
| `data.list[].redeemDate` | 核銷日期 YYYY-MM-DD |

---

### 5.2 Echoss API（待串接）

**Base URL**：`{ECHOSS_API_URL}`

**共用 Header**：
```
Authorization: Bearer {ECHOSS_API_TOKEN}
```

#### 查詢會員（待實作）

```javascript
// 預計格式（取得 API 文件後確認）
GET /member?phone=0912345678

Response:
{
  "data": { /* 會員資訊，若不存在則為 null */ }
}

// isMember = !!response.data
```

#### 發放點數（待實作）

```javascript
// 預計格式（取得 API 文件後確認）
POST /points
{
  "phone": "0912345678",
  "points": 720
}
```

---

## 六、Log 格式規格

所有 log 輸出為 JSON 單行：

```json
{
  "time": "2026-05-25T04:23:35.333Z",
  "level": "INFO",
  "tag": "sync-orders",
  "msg": "完成",
  "data": {
    "synced": 5,
    "newOrders": 3
  }
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `time` | string | ISO 8601 UTC 時間 |
| `level` | string | `INFO` / `WARN` / `ERROR` |
| `tag` | string | 功能模組標籤 |
| `msg` | string | 說明訊息 |
| `data` | object | 附加資訊（可選） |

**常用 tag 清單**：

| Tag | 說明 |
|---|---|
| `server` | 伺服器啟動 |
| `login` | 登入事件 |
| `sync-orders` | 同步訂單 |
| `sync-redeem` | 同步核銷 |
| `redeem` | 單筆核銷處理 |
| `check-expired` | 7天複查 |
| `daily-sync` | 每日完整同步 |
| `sync-range-redeem` | 補跑區間核銷 |
| `report-a` | 週報A |
| `report-b` | 週報B |
| `api/run` | pg_cron 觸發 |
| `api/admin` | 後台 API |

---

## 七、信件規格

### 7.1 消費者入會通知信

| 欄位 | 值 |
|---|---|
| 寄件人 | `"農遊生活" <{GMAIL_USER}>` |
| 收件人 | 消費者 Email |
| CC | `{REPORT_TO}` |
| 主旨 | `【農遊生活】感謝您的消費 — 加入會員享點數回饋` |
| 格式 | HTML |

信件包含欄位：

| 欄位 | 來源 |
|---|---|
| 消費者姓名 | `orders.customer_name` |
| 訂單號 | `orders.order_no` |
| 核銷日期 | `orders.redeem_date` |
| 消費金額 | `orders.amount`（格式：`NT$ 1,234`） |

---

### 7.2 週報A（下單未入會）

| 欄位 | 值 |
|---|---|
| 收件人 | `{REPORT_TO}` |
| 主旨 | `【週報A｜下單未入會】{from} ~ {to} 共 {N} 筆` |
| 附件 | `下單未入會_{from}-{to}.xlsx` |

Excel 欄位（依序）：姓名、手機、Email、訂單號、金額(NTD)、訂購日期

---

### 7.3 週報B（核銷7天未入會）

| 欄位 | 值 |
|---|---|
| 收件人 | `{REPORT_TO}` |
| 主旨 | `【週報B｜核銷未入會】{from} ~ {to} 共 {N} 筆` |
| 附件 | `核銷未入會_{from}-{to}.xlsx` |

Excel 欄位（依序）：姓名、手機、Email、訂單號、金額(NTD)、訂購日期、核銷日期

---

### 7.4 測試模式（TEST_MODE=true）

所有信件統一改寄至 `REPORT_TO`，主旨加上 `[TEST]` 前綴，CC 欄位移除

---

## 八、Excel 報表規格

**格式**：`.xlsx`（OpenXML）

**樣式**：
- 第一列（標頭）：白色文字、藍色背景（`#2563EB`）、置中對齊、粗體
- 偶數資料列：淡藍色背景（`#EFF6FF`）
- 奇數資料列：無背景
- 最後一列（合計）：粗體、淡藍背景（`#DBEAFE`）
- 金額欄位：靠右對齊，格式 `#,##0`（千分位，無小數）
- 第一列凍結（捲動時標頭固定）

**合計列欄位**：

| 欄位 | 值 |
|---|---|
| 姓名 | `共 {N} 筆` |
| 金額 | 所有列金額加總 |
| 其他欄位 | 空白 |

---

## 九、前端 Token 管理規格

### 9.1 儲存

| Key | Storage | 內容 |
|---|---|---|
| `admin_token` | localStorage | JWT access token |
| `admin_refresh_token` | localStorage | Refresh token |
| `admin_token_expiry` | localStorage | 到期 Unix timestamp（秒，字串格式） |

### 9.2 自動更新邏輯

```
每 60 秒執行一次 maybeRefreshToken()：

1. 取 expiresAt = parseInt(localStorage.getItem('admin_token_expiry'))
2. 計算剩餘秒數 = expiresAt - Math.floor(Date.now() / 1000)
3. 若剩餘 > 300秒（5分鐘）→ 跳過
4. 若剩餘 ≤ 300秒 → 呼叫 POST /api/refresh
   成功 → 更新 localStorage 三個 key
   失敗 → clearToken() + location.reload()（強制重新登入）
```

### 9.3 頁面載入流程

```
1. checkAuth() → 檢查 localStorage 是否有 admin_token
2. 有 token → 呼叫 maybeRefreshToken()（若快到期先刷新）
3. 呼叫 loadStatus() 載入後台資料
4. 啟動 60秒 interval
```

---

## 十、邊界條件與例外處理

| 情況 | 處理方式 |
|---|---|
| Rezio 訂單已存在 DB | `upsert + ignoreDuplicates`，跳過不更新 |
| 核銷記錄訂單不在 DB | 嘗試從 Rezio 補拉訂單資料後寫入，再處理核銷 |
| 訂單無手機號碼 | 跳過 Echoss 查詢，`is_member_at_redeem = null`，仍設 check_due_date |
| 訂單無 Email | 跳過寄信，記錄 WARN log |
| 同一訂單重複核銷 | `redeem_date` 和 `is_member_at_redeem` 已有值則跳過（冪等保護） |
| 寄信失敗 | catch 後記錄 ERROR log，不中斷主流程 |
| Rezio API timeout | axios timeout 15 秒，丟出 error，由上層 catch 處理 |
| Supabase 查詢失敗 | throw Error，中斷當前批次項目，記錄 ERROR log |
| pg_cron CRON_SECRET 不符 | 回傳 401，不執行任何操作 |
| 週報A無資料 | 仍寄出信件，附件設為 null，信件內容顯示「本週無資料」 |
| 週報B無資料 | 同上，佇列為空時仍寄出空信 |
