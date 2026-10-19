# Google 串接教學（YouTube 頻道、Google 商家評論）

YouTube 和 Google 商家共用同一組 Google 登入設定，全部免費。

- **YouTube**：設定完就能用。
- **Google 商家評論**：要多送一份「API 使用申請」給 Google，核准後才能讀取評論（免費，通常要等幾天）。

## 一、建立 Google Cloud 專案（約 10 分鐘）

1. 用電腦打開 <https://console.cloud.google.com/>，用你的 Google 帳號登入，同意服務條款。
2. 左上角「選取專案」→「新增專案」→ 名稱填 `社群經營工作台` →「建立」。之後確認左上角選到這個專案。
3. 啟用 API：左側選單「API 和服務」→「程式庫」，分別搜尋並按「啟用」：
   - `YouTube Data API v3`（YouTube 用）
   - `My Business Account Management API`、`My Business Business Information API`（Google 商家用；核准前可能看不到或用量為 0）

## 二、設定 Google 登入畫面

左側選單「API 和服務」→「OAuth 同意畫面」（新版名稱是「Google Auth Platform」）：

1. **品牌宣傳／應用程式資訊**：
   - 應用程式名稱：`社群經營工作台`
   - 使用者支援電子郵件：你的信箱
   - 應用程式首頁：網站網址
   - 隱私權政策：`網站網址/privacy.html`
   - 開發人員聯絡資訊：你的信箱
2. **目標對象**：使用者類型選「外部」。
3. **資料存取**：按「新增或移除範圍」，勾選（或手動貼上）：
   - `https://www.googleapis.com/auth/youtube.force-ssl`
   - `https://www.googleapis.com/auth/business.manage`
4. **發布狀態**：
   - 「測試中」：只有加入「測試使用者」的 Google 帳號能登入，而且**每 7 天要重新連結一次**。
   - 建議按「發布應用程式」改成「實際運作中」。登入時會出現「Google 尚未驗證這個應用程式」，按「進階」→「前往社群經營工作台（不安全）」即可。這是自己公司用的工具，不需要送審（未驗證最多 100 位使用者）。

## 三、建立用戶端 ID

1. 左側「憑證」（或「用戶端」）→「建立憑證」→「OAuth 用戶端 ID」。
2. 應用程式類型：**網頁應用程式**。
3. 「已授權的重新導向 URI」新增一筆，貼上工作台「社群帳號」頁 YouTube 卡片顯示的網址：
   `https://你的網址/api/integrations/google/callback`
4. 建立後會顯示「用戶端 ID」與「用戶端密鑰」，先複製起來。

## 四、在 Vercel 設定環境變數

Vercel 專案 → Settings → Environment Variables，新增兩筆（Type 選 Secret）：

| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | 用戶端 ID |
| `GOOGLE_CLIENT_SECRET` | 用戶端密鑰 |

然後到 Deployments → 最上面那筆「⋯」→ Redeploy。

## 五、連結

工作台「社群帳號」頁：

- **YouTube 卡片**：選品牌 →「連結 YouTube 頻道」→ 用管理頻道的 Google 帳號登入，勾選全部權限。
- **Google 商家卡片**：選品牌 →「連結 Google 商家」→ 用商家檔案擁有者或管理員的帳號登入，勾選全部權限。帳號底下的每個商家地點都會變成一個社群帳號。

## Google 商家 API 使用申請（免費）

Google 商家檔案 API 需要先申請：

1. 確認商家檔案已經**通過驗證**，並且有在營業（Google 會看商家是否真的存在、是否有網站）。
2. 在 Google Cloud 首頁「專案資訊」找到**專案編號**（一串數字）。
3. 打開申請表單 <https://developers.google.com/my-business/content/prereqs>，依頁面指示進入「GBP API 存取申請」表單，選「Application for Basic API Access」，填寫公司資料、專案編號、用途（例如：在自家社群管理工具中查看並回覆顧客評論）。
4. 核准後會收到 Email。屆時到「程式庫」啟用 `Google My Business API`，再回工作台按「立即同步」。

核准前同步會顯示「配額不足」或「API 尚未啟用」，這是正常的。

## 費用與限制

- **YouTube**：每天免費 10,000 點配額。讀取留言約 3 點／次，回覆、隱藏約 50 點／次，每天約可回覆 150～190 則。系統每 5 分鐘自動同步一次 YouTube，避免用完配額。
- **YouTube 能做的事**：回覆、隱藏（保留待審）、刪除（拒絕）、封鎖作者。不能按讚，這是 YouTube API 的限制。
- **Google 商家**：可以讀取評論與星等、回覆評論。不能隱藏或刪除顧客評論，不當評論要到 Google 商家檔案檢舉。每則評論只有一個商家回覆，再次回覆會取代原本的內容。
