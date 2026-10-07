# 末班車衝刺 Metro Dash

台灣風格的 3D 鐵道跑酷遊戲：鐵道、鹽埕老街、六合夜市，白天到黃昏到夜晚。
整個遊戲只有一個檔案 `index.html`，不需要安裝或建置。

## 本機試玩
直接用瀏覽器打開 `index.html` 即可（需要網路，用來載入 three.js 與字型）。

## 上傳到 GitHub
1. 到 https://github.com/new 建立一個新的 repository（例如 `metro-dash`）。
2. 在 repository 頁面點「Add file」→「Upload files」，把 `index.html` 和 `README.md` 拖進去，按「Commit changes」。

## 部署到 Vercel
1. 到 https://vercel.com/new ，用 GitHub 帳號登入。
2. 選擇剛剛的 `metro-dash` repository，按「Import」。
3. Framework Preset 選「Other」，其他設定都不用改，按「Deploy」。
4. 完成後會得到一個網址，例如 `https://metro-dash.vercel.app`。之後每次推送到 GitHub 都會自動重新部署。

## 注意
- 全服排行榜與即時多人分身，只在 Claude 的 Artifact 環境中可用。部署到 Vercel 後會自動改用「本機排行榜」，其他玩法都正常。
- 最佳分數、已兌換的服裝與技能，存在玩家各自的瀏覽器裡（localStorage）。

## 操作
- ← → 換軌、↑ / 空白鍵跳躍、↓ 滑行（手機用滑動）
- F 鍵或右下角按鈕：丟藍白拖
- P / Esc：暫停
