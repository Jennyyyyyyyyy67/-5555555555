# Facebook 粉絲專頁串接教學

讓企業用 Facebook 帳號登入、勾選要管理的粉專，工作台就能讀取粉專貼文的留言，並以粉專身分回覆、按讚、隱藏、刪除留言。

## 1. Meta 開發者後台：加入使用案例

1. 到 developers.facebook.com →「我的應用程式」→ 選你的應用程式（和 Instagram 用同一個即可）。
2. 左邊「使用案例」→「新增使用案例」→ 選 **「管理粉絲專頁上的所有內容」**（Manage everything on your Page）。
3. 在這個使用案例的「自訂」→「權限和功能」，確認以下權限是「可供測試」（沒有就按「新增」）：
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_read_user_content`
   - `pages_manage_engagement`
4. 使用案例裡的「Facebook 登入」設定 →「有效的 OAuth 重新導向 URI」貼上：
   ```
   https://你的網址/api/integrations/facebook/callback
   ```
   （網站「社群帳號」頁的 Facebook 卡片會顯示這個網址，可直接複製。）

## 2. Vercel 環境變數

在「應用程式設定 → 基本資料」可以看到 **應用程式編號** 和 **應用程式密鑰**（注意：不是 Instagram 的那組）。

| Key | Value |
|---|---|
| `FACEBOOK_APP_ID` | 應用程式編號 |
| `FACEBOOK_APP_SECRET` | 應用程式密鑰（Type 選 Secret） |

設定後到 Deployments 按 **Redeploy**。

## 3. 連結粉專

1. 網站「社群帳號」→「真實 Facebook 粉絲專頁」→ 選品牌 →「連結 Facebook 粉專」。
2. 用管理粉專的 Facebook 帳號登入，勾選要連結的粉專（可以多選），全部允許。
3. 回到網站後會自動匯入最近 25 篇貼文的留言。連結前的舊留言不會自動回覆、也不計回覆時效。

## 限制

- 審查前（開發模式）：只有應用程式的管理員、開發者、測試人員（在「應用程式角色」加入的 Facebook 帳號）能連結粉專。
- 沒有 `pages_read_user_content` 進階權限時，Facebook 可能不提供留言者名稱，會顯示「Facebook 使用者」。
- 封鎖使用者無法透過 API 從留言執行，請到 Facebook 粉專設定操作。
- 要讓任何企業都能連結，需要通過 Meta 商家驗證與應用程式審查（和 Instagram 相同）。
