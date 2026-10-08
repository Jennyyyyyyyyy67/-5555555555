# 開發慣例（給所有參與開發的人與 AI 代理）

## 技術與指令

- 後端：Node.js 20.18+、Express 5、zod 3、TypeScript（本機以 `tsx` 執行）
- 資料庫：Postgres。雲端（Vercel）用 `DATABASE_URL`；本機與測試沒設定時自動使用 PGlite（內嵌 Postgres，資料在 `data/pglite`）
- 前端：React 19、react-router-dom 7、Vite 8，純 CSS（`web/src/styles.css` 的 tokens 與 class）
- 測試：vitest + supertest（`server/**/*.test.ts`）

```bash
npm run dev        # 同時啟動 API（:3001）與前端（:5173）
npm run typecheck  # tsc 型別檢查（前後端一起）
npm test           # 後端 API 測試
npm run build      # 建置前端到 dist/
npm run seed       # 清空並重建示範資料
```

## 目錄

```
shared/              前後端共用：constants.ts（列舉與中文標籤）、permissions.ts（角色權限）、types.ts（API 型別）
server/
  app.ts             createApp(db)
  config.ts
  db/                schema.ts（完整資料表）、index.ts（openDb、tx、查詢輔助）、bootstrap.ts
  auth/              密碼、session、middleware（requireAuth/requirePermission/authed）、scope（品牌範圍）
  services/audit.ts  操作紀錄 audit()
  adapters/          平台 adapter 介面與模擬實作（registry.ts）
  routes/            每個領域一個檔案，匯出 xxxRoutes(): Router，在 routes/index.ts 掛載
  seed/              示範資料
  test/              測試輔助（createTestContext、fixture）
web/src/
  lib/               api.ts、useQuery.ts、format.ts、meta.tsx
  auth/ brand/       登入狀態、品牌切換
  components/        ui.tsx（共用元件）、icons.tsx、Toast.tsx
  layout/            AppShell、nav（側欄選單）
  pages/             各頁面
```

## 後端慣例

### 路由

```ts
export function brandRoutes(): Router {
  const r = Router();
  r.get('/', (req, res) => {
    const { user, scope } = authed(req);          // 已在 routes/index.ts 套用 requireAuth()
    ...
  });
  r.post('/', requirePermission('manageBrands'), (req, res) => {
    const input = schema.parse(req.body);          // zod 驗證；錯誤會自動轉成 400 中文訊息
    const id = tx(req.db, () => {                  // 資料異動與 audit 放在同一個交易
      const id = insert(req.db, 'brands', {...});
      audit(req.db, { actorType: 'user', actorUserId: user.id, brandId: id, action: 'brand.create', targetType: 'brand', targetId: id, summary: `新增品牌「${name}」`, after: {...} });
      return id;
    });
    res.status(201).json(...);
  });
  return r;
}
```

- Express 5：handler 丟出的錯誤（含 async）會自動交給 errorHandler，不需要 try/catch。
- 錯誤用 `server/lib/errors.ts` 的 `badRequest / forbidden / notFound / conflict / HttpError`，**訊息一律繁體中文、可直接給使用者看**。
- API 回應欄位一律 camelCase，時間為 ISO 字串（UTC）。型別寫在 `shared/types.ts`（已有的請直接用）。
- 時間一律用 `server/lib/clock.ts` 的 `nowIso()`，不要直接 `new Date()`（測試需要固定時間）。

### 權限與品牌隔離（最重要）

- 角色權限：`requirePermission('manageBrands')` 等，權限表在 `shared/permissions.ts`。
- 品牌範圍：`req.scope.brandIds`（可存取的品牌；管理員為全部含停用）、`req.scope.activeBrandIds`（啟用中的）。
- **每一個查詢品牌資料的 SQL 都必須加上品牌過濾**：
  - 列表：`const ids = resolveBrandFilter(scope, req.query.brand)` → `WHERE ${sqlIn('c.brand_id', ids)}`
  - 單筆（用 id 取資料）：查到後若 `brand_id` 不在 `scope.brandIds` 內，**回 404（找不到資料）**，不要洩漏資料存在。
  - 使用者明確指定 `?brand=其他品牌` → `resolveBrandFilter` 會回 403。
- 寫入時，`brandId` 從資料本身取得或驗證 `assertBrandAccess(scope, brandId)`。

### 資料庫輔助（server/db/index.ts）

- `all / get / run(db, sql, params)`：具名參數 `:name` + 物件，或 `?` + 陣列。
- `insert(db, table, row)` 回傳新 id；`updateById(db, table, id, patch)`。
- **全部都是非同步的，一定要 `await`**（漏掉 await 不會有型別錯誤，但資料不會寫入或順序錯亂）。
- SQL 仍可用 `?` 或 `:name` 寫參數，輔助函式會轉成 Postgres 的 `$1`；也會自動把 boolean 轉 0/1、undefined 轉 null、物件/陣列轉 JSON 字串。
- Postgres 注意事項：不分大小寫比對用 `lower(x) = lower(?)`、搜尋用 `ILIKE`；`INSERT ... SELECT ?` 這類無法推斷型別的參數要加 `?::integer` 等轉型。
- `sqlIn(column, ids)` 產生安全的 `IN (...)`；ids 空陣列時回傳 `0 = 1`。
- `parseJson(text, fallback)` 讀 JSON 欄位、`bool(v)` 讀 0/1 欄位。
- `await tx(db, async () => { ... })` 交易，可巢狀（內層用 SAVEPOINT）；交易內用輔助函式執行的查詢會自動走同一條連線。

### 操作紀錄（不可妥協）

- 所有重要操作都要 `audit()`：新增、修改、停用、登入、權限變更、重設資料、回覆、狀態變更、轉交、隱藏、刪除…
- `action` 格式 `領域.動作`（例如 `brand.update`、`account.test_connection`、`user.reset_password`）。
- `summary` 是給人看的繁體中文句子；`before / after` 只放有變動的欄位（可用 `diffFields`）。**密碼、token 絕不寫入紀錄。**
- 由人操作：`actorType: 'user'` + `actorUserId`；由規則：`actorType: 'rule'` + `ruleId`；AI：`'ai'`；系統：`'system'`。
- 操作紀錄只能新增（資料庫有 trigger 擋修改與刪除）。

### 測試

```ts
import { createTestContext } from '../test/helpers';
const ctx = createTestContext();            // 記憶體資料庫 + fixture
const agent = await ctx.loginAs('opA');     // admin | sup | opA | opB
const res = await agent.get('/api/brands');
```

fixture（`server/test/fixture.ts`）：品牌甲 `fx.brandA`（主管 sup、操作人員 opA）、品牌乙 `fx.brandB`（操作人員 opB）、管理員 admin；每品牌一個 Facebook 粉專帳號、一篇貼文、一則留言。

每個 API 至少測：正常流程、未授權角色被擋（403）、跨品牌存取被擋（403/404）、輸入驗證（400）、有寫入操作紀錄。

## 前端慣例

- API：`api.get<T>(path, query)`、`api.post / patch / put / del`；path 可省略 `/api` 前綴。錯誤為 `ApiError`，用 `errorMessage(err)` 取得中文訊息。
- 載入資料：`const { data, loading, error, reload } = useQuery(() => api.get<T>('/brands'), [deps])`。
- 登入者：`const { user, can, refresh } = useAuth()`；按鈕顯示與否用 `can('manageBrands')`（後端仍會再擋）。
- 品牌切換：`const { brandParam, currentBrand, activeBrands } = useBrandScope()`，查詢時帶 `{ brand: brandParam }`。
- 中繼資料：`const { meta, platformLabel, accountTypeLabel, platform } = useMeta()`。
- 元件（`components/ui.tsx`）：`Button`（variant: primary/secondary/ghost/danger, size, loading, icon）、`Badge`（tone）、`PageHeader`、`Card`、`EmptyState`、`Loading`、`ErrorMessage`、`Alert`、`Field`、`TextInput`、`Select`、`Textarea`、`Checkbox`、`Switch`、`Modal`、`ConfirmDialog`（`requireReason` 會要求填理由）、`Dropdown`、`Avatar`。
- 圖示（`components/icons.tsx`）：`PlatformIcon`、`BrandTag`、各種 `IconXxx`。
- 提示：`const toast = useToast(); toast.success('已儲存')`。
- 格式：`formatDateTime / formatShortDateTime / formatRelative / formatMinutes / formatNumber / formatPercent`（`lib/format.ts`）。
- 標籤：狀態、角色、平台等中文名稱一律從 `shared/constants.ts` 取，不要在頁面裡寫死。
- 高風險或不可逆的操作（停用、重設、刪除、封鎖）一律用 `ConfirmDialog`。
- 版面：表格包在 `<div className="table-wrap">` 內；表單兩欄用 `.form-row`；手機寬度（390px）必須可用、不可出現整頁水平捲動。

## 文案（繁體中文、台灣用語）

- 用「帳號、設定、資料、訊息、網路、影片、品質、預設、儲存、檔案、使用者、登入、建立、啟用／停用」。
- 不用「賬號、設置、信息、網絡、視頻、質量、默認、文件（指檔案時）、用戶、登錄、創建」。
- 按鈕用動詞：「新增品牌」「儲存」「取消」「停用」；錯誤訊息說明原因與下一步。
- 中英文、數字之間加半形空格（例如「60 分鐘」「Facebook 粉絲專頁」）。
