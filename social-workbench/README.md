# 社群經營工作台

給品牌小編使用的 AI 社群幫手：集中管理 Facebook、Instagram、YouTube、Google 商家評論的**公開留言與互動**。
小編可以在這裡巡留言、判斷急迫程度、依品牌風格回覆、控管 60 分鐘首回時效、追蹤未結束的互動、處理客訴與惡意留言，並回報數據與洞察。

> 不包含：客服私訊、售後客服案件、貼文排程。

## 開發進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| 1 | 登入、三種角色、品牌與社群帳號管理、人員權限、完整資料表、模擬留言資料 | ✅ 可測試 |
| 2 | 統一收件匣（篩選、詳情與前後脈絡、狀態、負責人、處理中鎖定、時效倒數） | 待開發 |
| 3 | AI 分類、優先級、風險、品牌風格、知識庫、多版本回覆、人工確認送出 | 待開發 |
| 4 | 自動回覆規則、強制轉人工條件、相似留言分組與批次回覆 | 待開發 |
| 5 | 數據看板、異常事件、社群洞察、操作紀錄、報表 | 待開發 |

## 安裝與啟動

需要 **Node.js 20.18 以上**（建議 Node.js 24 LTS，可到 <https://nodejs.org> 下載）。本機不需要另外安裝資料庫（會自動使用內嵌的 Postgres：PGlite）。

```bash
cd social-workbench
npm install
npm run dev
```

啟動後打開瀏覽器：<http://localhost:5173>

- 第一次啟動會自動建立示範資料（本機資料存在 `social-workbench/data/pglite` 資料夾）。
- 示範留言的時間是以「建立當下」往前推算的。隔一段時間再測試時，到「設定 → 模擬資料」按「重設示範資料」，留言時間就會回到「剛剛發生」。
- 也可以用指令重建：`npm run seed`。

### 示範帳號（密碼皆為 `demo1234`）

登入頁有「示範帳號一鍵登入」。

| 帳號 | 姓名 | 角色 | 可處理的品牌 |
|---|---|---|---|
| admin@demo.tw | 林思妤 | 管理員 | 全部品牌 |
| lead@demo.tw | 陳柏翰 | 主管 | 澄淨家電、日日咖啡 |
| amy@demo.tw | 王小美 | 操作人員 | 澄淨家電、日日咖啡 |
| hao@demo.tw | 張家豪 | 操作人員 | 日日咖啡、小森嬰品 |

示範品牌（虛構）：**澄淨家電**（淨水器，專業穩重）、**日日咖啡**（咖啡豆與門市，活潑親切）、**小森嬰品**（嬰幼兒用品，溫柔謹慎）。

## 部署到 Vercel

1. **建立資料庫**：在 Vercel 專案的「Storage」新增一個 Postgres（Neon）資料庫並連結到這個專案。Vercel 會自動加入 `DATABASE_URL` 環境變數。
   也可以使用任何 Postgres，自行在「Settings → Environment Variables」設定 `DATABASE_URL`。
2. **匯入專案**：在 Vercel 新增專案並選擇這個 GitHub repo，**Root Directory 設為 `social-workbench`**，其他保持預設（`vercel.json` 已設定好建置指令）。
3. **部署**：第一次有人打開網站時，系統會自動建立資料表與示範資料（約 10～20 秒）。

注意事項：

- 示範模式（預設開啟）下，打開網址會直接以示範管理員進入。**網址公開時任何人都能進入**；請開啟 Vercel 的 Deployment Protection，或在正式使用前設定 `DEMO_MODE=false`。
- 設定 `DEMO_MODE=false` 前，請先用管理員建立好自己的帳號（否則會沒有帳號可以登入）。
- 部署時的建置指令是 `npm run build:vercel`：會把前端與後端（打包成單一函式）輸出到 `.vercel/output`。

## 其他指令

```bash
npm test            # 後端 API 測試
npm run typecheck   # 型別檢查
npm run build       # 建置前端
npm run build:vercel  # 產生 Vercel 部署用輸出（.vercel/output）
npm start           # 建置後以單一連接埠（http://localhost:3001）執行
```

環境變數（本機皆為選填）：`PORT`（API 連接埠，預設 3001）、`DATABASE_URL`（Postgres 連線字串；未設定時用本機 PGlite）、`DEMO_MODE=false`（關閉示範模式：不自動建立示範資料、登入頁不顯示示範帳號）、`COOKIE_SECURE=true`（以 HTTPS 部署時開啟）。

## 架構重點

- **前端**：React + TypeScript + Vite，繁體中文介面，桌面優先、手機可用。
- **後端**：Node.js + Express + Postgres（雲端用 Neon／Vercel Postgres；本機用 PGlite，不需安裝）。所有 API 都在伺服器端依「使用者被授權的品牌」過濾資料。
- **平台串接（adapter）**：每個社群平台實作同一個 `PlatformAdapter` 介面（`server/adapters/`）：抓留言、回覆、按讚、隱藏、刪除、封鎖，並宣告該平台支援哪些動作。第一版全部是模擬 adapter，日後換成真實 API 不需修改其他功能。
- **AI**：階段 3 加入統一的 `AIProvider` 介面。預設是內建的模擬 AI（不需金鑰），之後可切換 Claude API。
- **不可妥協的原則寫在程式與資料庫裡**，不交給 AI 自己判斷：
  - 刪除、封鎖必須有人工確認者與理由（資料庫 CHECK 限制，自動化規則無法執行）。
  - 操作紀錄只能新增，不能修改或刪除（資料庫 trigger）。
  - 狀態區分「等待對方」與「已完成」。
  - 每則留言（包含批次處理）都保留自己的回覆與紀錄，並區分負責人與實際處理人。

開發慣例請見 [CONVENTIONS.md](./CONVENTIONS.md)。
