# GenesisPlus 網站變更紀錄（CHANGELOG）

> 本檔案記錄 GenesisPlus 官方網站與管理後台每次主要變更，供團隊成員查閱。
> **安全聲明**：本檔案只記載變更內容與說明，**絕不會**包含任何密碼、API Key、Token、帳戶登入資料或雲端服務（GitHub / Cloudflare / Supabase / Resend 等）的機密資訊。請勿在任何變更紀錄中寫入上述內容。
> 網址：<https://genesisplus.net/CHANGELOG.md>

---

## 2026-10-10 · v20261010f — 網站設計與後台入口調整

### 前台網站
- **Footer 入口**：加入 **Admin Center** 入口，放置於 Company 欄（About Us / Contact Us 下方），取代原本位於版權列的位置
- **回到頂部按鈕**：圖示重做為「大向上箭頭＋包裝盒底座」垂直組合，向上指示更明確；預設清晰顯示，hover 時箭頭浮起並顯示琥珀光暈
- **卡片動態誇張化**：
  - 卡片 hover 升起幅度加大（-10 ~ -11px）
  - 3D 傾斜角度增至 ±8°，放大 1.045 ~ 1.06
  - hover 時顯示琥珀色外框與光暈
  - 產品圖片 hover 放大至 1.12（0.55s 平滑過渡）
- **全站設計感升級**（編輯工藝美學）：
  - 每個 Section 加入大號描邊數字水印（01/02/03…）
  - Section 標籤改為「線—文字—線」式樣
  - 標題底部加入琥珀漸變裝飾線
  - Hero 背景加入印刷網點（halftone）紋理、手繪波浪下劃線
  - 統計數字之間加入琥珀分隔線、卡片雙層框線、主按鈕掃光效果
- 全站回到頂部按鈕改為「scroll 事件＋rAF」雙保險偵測，滾動超過一屏自動浮現、點擊平滑回頂

### 管理後台
- **Admin Center 頁面**：Header 新增「← 網站首頁」返回按鈕
- 登入頁移除預填的登入電郵，改為佔位提示

---

## 2026-10-10 · v20261010a — 回到頂部按鈕與 UI 品質

- 全站新增回到頂部按鈕（滾動自動浮現、平滑回頂、無障礙 focus 支援、支援減少動畫偏好）
- UI 品質優化：focus 可見性、觸控目標 44px、移除 `transition: all`、動畫減量、移除未使用字體

---

## 2026-10-09 · 後台客戶庫與郵件紀錄

- 後台新增 **🎯 客戶庫分頁**：AI 自動搜尋潛在客戶入庫、狀態流轉、手動發送／抑制／回覆、搜索設置持久化
- 後台新增 **📮 郵件紀錄分頁**：每封已發送郵件的主旨、收件人、內容與狀態（送達／開啟／點擊／退信／投訴），支援一鍵標記「已回覆」
- 網站聊天機器人：空回覆時關鍵字兜底，新增設計／包裝相關查詢匹配

---

## 2026-10-08 · 管理後台上線

- **管理後台正式上線**（Supabase 驅動）：登入認證、網站內容遠端覆寫、Worker 動態郵件設置
- **AI 助手分頁**：後台內建 AI 對話（Gemini API）
- **AI 自動任務分頁**：定時 AI 任務（獨立運作）
- **網站內容視覺化預覽**：欄位 ↔ 頁面位置雙向對應

---

## 2026-10-08 · 網站內容更新（V71–V74）

- 聊天機器人名稱調整與 AI 星光圖示（英文名：GenesisPlus AI Assistant）
- Footer 品牌介紹加長：香港總部、深圳／東莞生產基地、20 年包裝經驗敘述，8 種語言同步更新

---

## 紀錄格式說明

| 欄位 | 說明 |
|---|---|
| 日期 | 變更當日（香港時間） |
| 版本 | 網站快取參數版本號 |
| 內容 | 變更摘要，按前台／後台分類 |

## 2026-10-12 · v20261012a — 已發郵件完整記錄（sent_emails）

### 管理後台
- **「✉️ 已發送郵件」升級**：除 KV 快照外，新增讀取 Supabase `genesisplus.sent_emails` 完整記錄表（每封郵件全文 + 收件人 + 主旨 + 公司/網域 + BCC + 狀態），表格新增「狀態」欄（sent / replied / bounced / complained / unsubscribed）
- 表未建立或未登入時自動 fallback 到原 KV 資料，不會白畫面

### Worker（lead-gen）
- 每次自動發信成功後，將完整郵件內容寫入 Supabase `sent_emails` 表（to_email / subject / body / company / domain / lead_id / bcc_to / status / sent_at）
- 測試郵件（/test-email）同樣記入 `sent_emails`，方便統一追蹤
- 新增 `GET /emails` 管理端點（需管理權杖），支援 status / q / limit / offset 過濾，用 API 查已發郵件
- 已部署 Version `8582b6b1-ad30-4ca5-ae1c-f3d75297d53c`

### 資料庫（Supabase）
- ✅ `genesisplus.sent_emails` 表已建立並啟用：create table + RLS + 3 個索引 + 2 條 RLS policy + service_role/authenticated 權限，已實測讀寫正常（smoke test 通過後已刪除）

## 2026-10-12 · v20261012b — 後台權杖修復＋客戶庫直讀

### 管理後台
- **修復「後台睇唔到郵件／客戶」問題**：Worker 管理權杖失效導致所有 worker 數據請求 401，頁面空白。已重置 Worker `ADMIN_TOKEN` 並存入瀏覽器（「郵件設置」tab 重新填寫）
- **🎯 客戶庫升級**：改為優先直讀 Supabase `leads` 表（登入後即可用，權杖失效都照睇），權杖失效時才 fallback 到 Worker
- **📮 郵件記錄**：讀取容錯——Worker 權杖失效時唔再整頁空白，改為提示＋繼續顯示資料庫資料
- 已部署 commit `f7c6148`

## 2026-10-12 · v20261012c — 權杖雲端同步（多部電腦共用）

### 管理後台
- **Worker 管理權杖改為雲端自動取得**：登入後台後自動以登入身份向 Worker 取得權杖，存入本機暫存——換電腦／換瀏覽器登入即自動同步，唔使再手動貼權杖
- 「郵件設置」tab 新增「☁️ 從雲端取得」按鈕：權杖失效／想重新同步時一鍵重取；仍保留手動貼上＋儲存作 fallback
- Worker 請求遇 401（權杖失效）時自動清除本地暫存、重新從雲端取得後重試一次，唔會靜默失敗

### Worker（lead-gen）
- 新增 `GET /admin-token` 端點：以 Supabase 用戶 JWT 驗證身份（僅 superadmin：cyrus.chow@genesisplus.net / prefumeshop@gmail.com 可取），驗證通過才返回 ADMIN_TOKEN
- 已部署 Version `368d35f1-3f8b-450a-95e0-ebce01517d01`；端到端實測：superadmin ✅、無 header 401 ✅、垃圾 JWT 401 ✅
