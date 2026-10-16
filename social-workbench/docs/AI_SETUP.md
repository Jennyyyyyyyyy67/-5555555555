# 啟用真正的 AI（Claude）

沒有設定時，系統使用「模擬 AI」（關鍵字規則與範本）。設定 Anthropic API 金鑰後，留言判斷與回覆建議會改由 Claude 產生。

## 設定步驟

1. 到 https://console.anthropic.com 註冊並儲值，在「API Keys」建立一把金鑰。
2. Vercel → Environment Variables 新增：

| Key | Value | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 你的金鑰（Type 選 Secret） | 必填 |
| `AI_MODEL` | 例如 `claude-haiku-5-5` | 選填；預設 `claude-opus-5-5`（品質最好）。想要更快、更便宜可改用 Haiku |

3. Deployments → Redeploy。到「AI 回覆風格」頁，上方會顯示「目前使用真正的 AI（Claude）」。

## Claude 負責什麼、不負責什麼

- **負責**：判斷留言類型、標籤、情緒、風險、優先級；依品牌風格寫多版本回覆建議；自動回覆的內容。
- **不負責安全決定**：客訴、退款、補償、敏感議題、無法確認的承諾、信心不足等「一律轉人工」的條件，仍由程式強制檢查。Claude 判斷的風險只會讓處理更保守，不會放寬。
- **不編造事實**：價格、規格、活動等只能引用知識庫內容；送出前還會檢查金額、日期、承諾與禁用詞。
- **出錯時**：Claude 逾時或無法使用時，自動改用模擬 AI，網站照常運作。
- **節省費用**：連結帳號前就存在的大量舊留言，用關鍵字規則判斷，不呼叫 Claude。

## 費用參考

每則留言判斷約 1 次 API 呼叫，產生回覆建議約 1 次。實際費用依留言長度與模型而定，可在 Anthropic Console 的 Usage 頁查看。
