# 農遊生活 會員點數整合系統 PRD

**文件版本**：v1.0
**撰寫日期**：2026-05-25
**系統代號**：rezio-bridge

---

## 一、背景與目標

### 業務背景

農遊生活透過 **Rezio** 平台接受消費者線上訂票，並透過 **Echoss** 平台管理會員與點數。兩個平台互不相通，導致：

- 消費者核銷訂單後，無法自動判斷是否為會員
- 若是會員，無法自動發放點數
- 需要人工對帳，費時費力且容易遺漏

### 目標

建立一套自動化中介系統，串接 Rezio 訂單資料與 Echoss 會員資料，實現：

1. **自動發點**：消費者核銷且為 Echoss 會員時，自動發放消費點數
2. **7天追蹤**：核銷當下非會員者，給予7天緩衝期加入，自動複查
3. **週報通知**：每週產出未入會名單，供人工追蹤招攬

---

## 二、使用者角色

| 角色 | 說明 |
|---|---|
| **系統管理員**（農遊生活內部人員） | 透過後台管理介面操作，每日執行同步、查看訂單狀態、發送週報 |
| **消費者** | Rezio 下單、現場核銷，收到系統發送的入會通知信 |
| **排程系統**（pg_cron） | 每小時自動觸發每日同步，每週一自動觸發週報寄送 |

---

## 三、核心流程

### 3.1 訂單生命週期

```
消費者 Rezio 下單
        ↓
  [每日同步] 拉取訂單存入 DB
  狀態：待核銷
        ↓
  消費者現場核銷（Rezio 端操作）
        ↓
  [每日同步] 偵測到核銷記錄
        ↓
  ┌─── 是 Echoss 會員？ ───┐
  │ 是                    │ 否
  ↓                       ↓
自動發點               寄信通知消費者
狀態：已發點           「7天內加入享點數回饋」
                       狀態：待複查
                            ↓
                      [7天後複查]
                            ↓
                  ┌─── 已加入會員？ ───┐
                  │ 是               │ 否
                  ↓                  ↓
               自動發點         加入週報佇列
               狀態：已結案     狀態：已結案
                                     ↓
                              [每週一] 週報B 寄出
```

---

## 四、功能規格

### 4.1 每日同步（Daily Sync）

**觸發方式**：
- 自動：pg_cron 每小時呼叫 `POST /api/run`
- 手動：管理後台「一鍵更新」按鈕

**執行步驟**：

| 步驟 | 功能 | 說明 |
|---|---|---|
| 1 | syncNewOrders | 從 Rezio 拉取當日新訂單，包含姓名、手機、Email、金額，寫入 DB（重複略過） |
| 2 | syncRedemptions | 從 Rezio 拉取當日核銷記錄，比對 DB 訂單，執行會員查詢與發點流程 |
| 3 | checkExpiredOrders | 查詢 check_due_date ≤ 今日的待複查訂單，再次查詢是否已入會，結案處理 |

**並發控制**：每批最多 5 筆同時處理（CONCURRENCY = 5）

---

### 4.2 訂單狀態機

| 狀態 | 說明 | 下一個可能狀態 |
|---|---|---|
| 待核銷 | 已下單，未核銷 | 待複查、已發點 |
| 待複查 | 已核銷，非會員，等7天 | 已結案 |
| 已發點 | 已核銷，是會員，點數已發 | — |
| 已結案 | 7天複查完成，流程終止 | — |

---

### 4.3 點數計算規則

- **換算比例**：消費金額 1元 = 1點
- **計算方式**：`Math.floor(amount)`，無條件捨去小數
- **觸發條件**：消費者為 Echoss 會員時（核銷當下 或 7天後複查確認）

> ⚠️ Echoss 發點 API 尚未串接，目前為佔位狀態，待取得 API 金鑰後實作

---

### 4.4 消費者通知信

**觸發條件**：訂單核銷當下，查詢結果為非會員，且訂單有 Email

**信件內容**：

| 欄位 | 內容 |
|---|---|
| 主旨 | 【農遊生活】感謝您的消費 — 加入會員享點數回饋 |
| 內容 | 訂單資訊（訂單號、核銷日期、消費金額）+ 邀請7天內透過 LINE OA 加入會員 |
| 寄件人 | 農遊生活 Gmail 帳號（GMAIL_USER） |
| 收件人 | 消費者 Email |
| CC | REPORT_TO（農遊生活內部信箱） |

---

### 4.5 週報 A（下單未入會）

**觸發方式**：每週一自動 / 手動按「寄出週報 A」

**資料範圍**：上週（週一～週日）下單、且當下仍非 Echoss 會員的訂單

**輸出**：

- Email 主旨：`【週報A｜下單未入會】YYYY-MM-DD ~ YYYY-MM-DD 共 N 筆`
- 附件：Excel 檔，欄位包含姓名、手機、Email、訂單號、金額、下單日期
- 用途：供農遊生活主動聯繫招攬入會

---

### 4.6 週報 B（核銷7天未入會）

**觸發方式**：每週一自動 / 手動按「寄出週報 B」

**資料範圍**：`weekly_report_queue` 佇列（7天複查後仍未入會的結案訂單）

**輸出**：

- Email 主旨：`【週報B｜核銷未入會】YYYY-MM-DD ~ YYYY-MM-DD 共 N 筆`
- 附件：Excel 檔，欄位同週報A，另增核銷日期
- 寄出後：自動清空佇列、更新 `last_sent_at`

---

### 4.7 補跑歷史資料

**用途**：首次部署或停機補漏時使用

**操作**：管理後台選擇日期區間（from ～ to），執行補跑

**邏輯**：

1. 同步指定區間的訂單
2. 查詢該區間到今日的所有核銷記錄
3. 只處理 DB 中已存在的訂單（不建立區間外訂單）

---

## 五、管理後台功能

| 功能 | 說明 |
|---|---|
| 登入 / 登出 | Supabase Auth 驗證，JWT token，localStorage 持久化，token 7天自動更新 |
| 統計卡片 | 即時顯示各狀態訂單數：待核銷 / 待複查 / 已發點 / 已結案 / 本週週報 |
| 訂單列表 | 分頁（每頁50筆）+ 狀態篩選，顯示姓名、手機、Email、訂單號、金額、狀態 |
| 一鍵更新 | 觸發每日同步（新訂單 + 核銷 + 7天複查），每日必按 |
| 7天複查 | 單獨觸發到期複查（已含在一鍵更新內） |
| 週報 A | 手動觸發上週下單未入會名單寄送 |
| 週報 B | 手動觸發核銷未入會結案名單寄送，寄出後清空佇列 |
| 補跑歷史 | 指定日期區間補同步歷史訂單與核銷 |
| 測試模式 | 開啟後所有信件只寄到 REPORT_TO，不寄給真實消費者 |

---

## 六、技術架構

### 系統元件

```
[Rezio API] ←→ [rezio-bridge] ←→ [Echoss API]
                     ↕
               [Supabase DB]
                     ↕
               [管理後台 UI]
                     ↕
               [Gmail API]
```

### 技術選型

| 元件 | 技術 |
|---|---|
| 後端 | Node.js + Express |
| 資料庫 | Supabase（PostgreSQL） |
| 認證 | Supabase Auth + JWT（jsonwebtoken） |
| 排程 | Supabase pg_cron |
| 寄信 | Gmail REST API（OAuth2） |
| 部署 | Render（Web Service） |
| 前端 | 純 HTML / CSS / JavaScript（無框架） |

### 資料表

| 表名 | 用途 |
|---|---|
| `orders` | 所有訂單主表，含狀態機欄位 |
| `weekly_report_queue` | 週報B佇列，7天複查後仍未入會的訂單暫存 |
| `report_schedule` | 記錄最後一次週報寄送時間 |

### orders 欄位說明

| 欄位 | 型別 | 說明 |
|---|---|---|
| order_no | text | Rezio 訂單號（主鍵） |
| customer_name | text | 消費者姓名 |
| phone | text | 手機號碼（本地格式，如 0912345678） |
| email | text | 電子信箱 |
| order_date | date | 下單日期 |
| redeem_date | date | 核銷日期 |
| amount | numeric | 消費金額（NTD） |
| status | text | 待核銷 / 待複查 / 已發點 / 已結案 |
| is_member_at_redeem | boolean | 核銷當下是否為會員（null = 未知） |
| check_due_date | date | 7天複查截止日 |
| customer_notified | boolean | 是否已寄信通知消費者 |
| points_issued | boolean | 是否已發點 |

---

## 七、安全機制

| 機制 | 說明 |
|---|---|
| 管理後台認證 | Supabase JWT，local verify（快）+ API fallback（可靠） |
| Token 自動更新 | 距離到期 < 5 分鐘自動用 refresh token 換新，每60秒檢查一次 |
| API 端點保護 | `/api/run`、`/api/run-weekly` 需帶 `Bearer CRON_SECRET` header |
| 登入限流 | 每 IP 15 分鐘內最多 10 次嘗試，超過回傳 429 |
| CORS | 預設 same-origin，可設定 `ALLOWED_ORIGIN` 允許跨域 |
| 測試模式 | 防止測試時誤寄信給真實消費者 |
| 並發安全 | Supabase upsert + ignoreDuplicates，防止重複寫入 |

---

## 八、環境變數清單

| 變數 | 必填 | 說明 |
|---|---|---|
| `REZIO_STORE_UUID` | ✅ | Rezio 商店 UUID |
| `REZIO_API_KEY` | ✅ | Rezio API 金鑰 |
| `REZIO_LANG` | — | 語言（預設 zh-TW） |
| `ECHOSS_API_URL` | ⏳ | Echoss API 網址（待串接） |
| `ECHOSS_API_TOKEN` | ⏳ | Echoss Bearer Token（待串接） |
| `SUPABASE_URL` | ✅ | Supabase 專案網址 |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase Service Role Key |
| `SUPABASE_JWT_SECRET` | — | JWT 本地驗簽加速（可選，填錯不影響功能） |
| `GMAIL_USER` | ✅ | Gmail 寄件帳號 |
| `GMAIL_CLIENT_ID` | ✅ | Google OAuth2 Client ID |
| `GMAIL_CLIENT_SECRET` | ✅ | Google OAuth2 Client Secret |
| `GMAIL_REFRESH_TOKEN` | ✅ | Gmail Refresh Token |
| `REPORT_TO` | ✅ | 週報收件信箱（農遊生活內部） |
| `CRON_SECRET` | ✅ | pg_cron 觸發驗證 token（至少32字元） |
| `ALLOWED_ORIGIN` | — | CORS 允許來源（同源部署留空） |
| `TEST_MODE` | — | 測試模式開關（預設 false） |

---

## 九、API 端點

| Method | 路徑 | 驗證 | 說明 |
|---|---|---|---|
| POST | `/api/login` | 無 | 帳號密碼登入，回傳 JWT session |
| POST | `/api/refresh` | 無 | 用 refresh token 換新 access token |
| GET | `/api/admin?action=status` | JWT | 取得訂單列表與統計數字 |
| POST | `/api/admin?action=run-daily-sync` | JWT | 手動觸發每日同步 |
| POST | `/api/admin?action=sync-range` | JWT | 補跑指定日期區間 |
| POST | `/api/admin?action=check-expired` | JWT | 手動觸發7天複查 |
| POST | `/api/admin?action=send-report-a` | JWT | 手動寄出週報A |
| POST | `/api/admin?action=send-report-b` | JWT | 手動寄出週報B |
| POST | `/api/admin?action=toggle-test-mode` | JWT | 切換測試模式 |
| POST | `/api/admin?action=diagnose-mail` | JWT | 診斷 Gmail OAuth2 設定 |
| POST | `/api/run` | CRON_SECRET | pg_cron 每小時觸發每日同步 |
| POST | `/api/run-weekly` | CRON_SECRET | pg_cron 每週一觸發週報寄送 |

---

## 十、已知限制與待辦

| 項目 | 狀態 | 說明 |
|---|---|---|
| Echoss 會員查詢 | ⏳ 待串接 | 目前固定回傳 `isMember: false`，所有訂單核銷後皆為待複查狀態 |
| Echoss 發點 API | ⏳ 待串接 | 目前為 log 佔位，待取得 API 金鑰後實作 |
| 點數計算規則 | 🔄 可調整 | 目前 1元=1點，可依業務需求修改 `issuePoints` 函式 |
| 消費者入會管道 | 📋 僅 LINE OA | 通知信中引導透過 LINE OA 加入，若有其他管道可調整信件內容 |

---

## 十一、後續擴充建議

1. **Echoss API 串接完成後**：更新 `src/services/echoss.js` 中的 `isMember()` 與 `issuePoints()`
2. **點數規則調整**：修改 `src/jobs/dailySync.js` 中的 `issuePoints()` 函式
3. **通知信內容調整**：修改 `src/utils/mailer.js` 中的 `sendCustomerNotification()`
4. **多管理員帳號**：直接在 Supabase Authentication → Users 新增即可
