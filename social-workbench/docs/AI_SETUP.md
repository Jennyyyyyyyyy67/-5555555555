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

---

# 免費方案：Google Gemini

不想付費的話，可以用 Google Gemini 的免費額度產生回覆建議。

## 設定步驟

1. 打開 <https://aistudio.google.com/>，用 Google 帳號登入。
2. 左側「Get API key」→「Create API key」→ 選剛剛的 Google Cloud 專案（或建立新的）→ 複製金鑰。**不需要綁信用卡。**
3. Vercel → Environment Variables 新增：

| Key | Value | 說明 |
|---|---|---|
| `GEMINI_API_KEY` | 剛剛的金鑰（Type 選 Secret） | 必填 |
| `GEMINI_MODEL` | 例如 `gemini-flash-latest` | 選填；預設為 Google 最新的 Flash 模型 |

4. Deployments → Redeploy。「AI 回覆風格」頁上方會顯示「回覆建議使用 Google Gemini 免費額度」。

## 和 Claude 的差別

- **Gemini 只負責寫回覆建議**：會依照品牌風格、回覆範例、類型語氣、知識庫寫回覆。留言分類仍用關鍵字規則，以節省免費額度。
- **額度有限**：每天可用的次數由 Google 決定，可在 AI Studio 查看。用完時會自動改用範本回覆，隔天恢復。
- **隱私**：Google 免費方案可能會用送出的內容改善服務。網站的隱私權政策已經寫明。
- **同時設定兩者時**：同時有 `ANTHROPIC_API_KEY` 時，一律優先使用 Claude。
