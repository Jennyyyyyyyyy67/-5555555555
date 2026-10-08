// 資料庫存取層（Postgres）。
// - 正式環境（Vercel）：設定 DATABASE_URL（或 POSTGRES_URL）連到雲端 Postgres（例如 Neon / Vercel Postgres）。
// - 本機開發與測試：未設定時使用 PGlite（內嵌在程式裡的 Postgres），不需要另外安裝資料庫。
// 所有查詢都是非同步的；交易內的查詢會自動使用同一條連線（AsyncLocalStorage）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
// PGlite 只在本機使用，延後載入，雲端部署時不需要它
import type { PGlite } from '@electric-sql/pglite';
import { DROP_SQL, SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { bootstrapSystemData } from './bootstrap';

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** 可執行查詢的對象（資料庫本身或交易中的連線） */
interface Queryable {
  query(sql: string, params: unknown[]): Promise<QueryResult>;
  exec(sql: string): Promise<void>;
}

export interface DB extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** 取得專用連線並執行交易；回呼中的查詢須使用傳入的 Queryable */
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------- 開啟資料庫 ----------------

// COUNT 等 bigint 與 numeric 一律轉成 JS number（本系統的數值都在安全範圍內）
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

function wrapPg(pool: pg.Pool): DB {
  const fromClient = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query(sql, params) {
      const r = await c.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await c.query(sql);
    },
  });
  const root = fromClient(pool);
  return {
    kind: 'pg',
    ...root,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(fromClient(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function wrapPglite(lite: PGlite): DB {
  type LiteLike = Pick<PGlite, 'query' | 'exec'>;
  const fromLite = (l: LiteLike): Queryable => ({
    async query(sql, params) {
      const r = await l.query<Record<string, unknown>>(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) {
      await l.exec(sql);
    },
  });
  const root = fromLite(lite);
  return {
    kind: 'pglite',
    ...root,
    // PGlite 是單一連線；transaction() 會鎖住整個資料庫直到交易結束
    transaction: (fn) => lite.transaction((t) => fn(fromLite(t as unknown as LiteLike))),
    close: () => lite.close(),
  };
}

/**
 * 開啟資料庫並套用資料表結構。
 * - postgres:// 或 postgresql:// → 雲端 Postgres
 * - pglite:<資料夾> → 本機 PGlite（資料存在該資料夾）
 * - memory: → 記憶體中的 PGlite（測試用）
 */
export async function openDb(url: string, opts: { migrate?: boolean } = {}): Promise<DB> {
  let db: DB;
  if (/^postgres(ql)?:\/\//.test(url)) {
    db = wrapPg(new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 3), connectionTimeoutMillis: 10_000 }));
  } else {
    const dir = url.startsWith('pglite:') ? url.slice('pglite:'.length) : undefined;
    if (dir) mkdirSync(dir, { recursive: true });
    const { PGlite, types: pgliteTypes } = await import('@electric-sql/pglite');
    const lite = new PGlite(dir, {
      parsers: {
        [pgliteTypes.INT8]: (v: string) => Number.parseInt(v, 10),
        [pgliteTypes.NUMERIC]: (v: string) => Number.parseFloat(v),
      },
    });
    await lite.waitReady;
    db = wrapPglite(lite);
  }
  if (opts.migrate !== false) await migrate(db);
  return db;
}

/** 建立資料表（已存在則略過）與系統基本資料。以 advisory lock 避免多個執行個體同時初始化。 */
export async function migrate(db: DB): Promise<void> {
  await tx(db, async () => {
    await run(db, 'SELECT pg_advisory_xact_lock(724501)');
    await execSql(db, SCHEMA_SQL);
    await run(
      db,
      `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [String(SCHEMA_VERSION)],
    );
    await bootstrapSystemData(db);
  });
}

/** 刪除所有資料表後重建（重設模擬資料用）。可在交易中呼叫。 */
export async function resetDatabase(db: DB): Promise<void> {
  await tx(db, async () => {
    await run(db, 'SELECT pg_advisory_xact_lock(724501)');
    await execSql(db, DROP_SQL);
    await execSql(db, SCHEMA_SQL);
    await run(db, `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
    await bootstrapSystemData(db);
  });
}

// ---------------- 交易 ----------------
interface TxContext {
  db: DB;
  q: Queryable;
  depth: number;
}
const txStore = new AsyncLocalStorage<TxContext>();

function current(db: DB): Queryable {
  const ctx = txStore.getStore();
  return ctx && ctx.db === db ? ctx.q : db;
}

/**
 * 在交易中執行 fn；可巢狀呼叫（內層使用 SAVEPOINT）。fn 丟出錯誤時整筆回復。
 * fn 內透過 all/get/run/insert/updateById 執行的查詢都會自動走同一筆交易。
 */
export async function tx<T>(db: DB, fn: () => Promise<T>): Promise<T> {
  const ctx = txStore.getStore();
  if (ctx && ctx.db === db) {
    const sp = `sp_${ctx.depth}`;
    await ctx.q.exec(`SAVEPOINT ${sp}`);
    try {
      const result = await txStore.run({ ...ctx, depth: ctx.depth + 1 }, fn);
      await ctx.q.exec(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await ctx.q.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
      throw err;
    }
  }
  return db.transaction((q) => txStore.run({ db, q, depth: 1 }, fn));
}

// ---------------- 查詢輔助 ----------------
// 參數會統一轉換：boolean → 0/1（欄位為 INTEGER）、undefined → null、Date → ISO 字串、陣列與一般物件 → JSON 字串。
export type Params = Record<string, unknown> | unknown[];

function toSqlValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

const convertCache = new Map<string, { sql: string; names: (string | number)[] }>();

/**
 * 把 SQL 中的 `?`（位置參數）與 `:name`（具名參數）轉成 Postgres 的 $1、$2…
 * 會略過字串常值、識別字引號、`::` 型別轉換與 $$ 區塊。
 */
function convertSql(sql: string): { sql: string; names: (string | number)[] } {
  const cached = convertCache.get(sql);
  if (cached) return cached;
  const names: (string | number)[] = [];
  const named = new Map<string, number>();
  let out = '';
  let positional = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '$' && sql[i + 1] === '$') {
      const end = sql.indexOf('$$', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === '?') {
      names.push(positional++);
      out += `$${names.length}`;
      i++;
    } else if (ch === ':' && sql[i + 1] === ':') {
      out += '::';
      i += 2;
    } else if (ch === ':' && /[a-zA-Z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      let idx = named.get(name);
      if (idx === undefined) {
        names.push(name);
        idx = names.length;
        named.set(name, idx);
      }
      out += `$${idx}`;
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  const result = { sql: out, names };
  if (convertCache.size < 5000) convertCache.set(sql, result);
  return result;
}

async function query(db: DB, sql: string, params?: Params): Promise<QueryResult> {
  const { sql: text, names } = convertSql(sql);
  let values: unknown[] = [];
  if (Array.isArray(params)) {
    values = names.map((n) => toSqlValue(params[n as number]));
  } else if (params) {
    values = names.map((n) => {
      if (typeof n === 'number') throw new Error('同一個查詢不可混用 ? 與 :name 參數');
      if (!(n in params)) throw new Error(`缺少查詢參數：${n}`);
      return toSqlValue(params[n]);
    });
  } else if (names.length) {
    throw new Error('查詢缺少參數');
  }
  return current(db).query(text, values);
}

/** 執行多個以分號分隔、沒有參數的 SQL 敘述 */
export async function execSql(db: DB, sql: string): Promise<void> {
  await current(db).exec(sql);
}

/**
 * 具名參數用 :name 寫在 SQL 中，params 傳 { name: value }；位置參數用 ?，params 傳陣列。
 */
export async function all<T = Record<string, unknown>>(db: DB, sql: string, params?: Params): Promise<T[]> {
  return (await query(db, sql, params)).rows as T[];
}

export async function get<T = Record<string, unknown>>(db: DB, sql: string, params?: Params): Promise<T | undefined> {
  return (await query(db, sql, params)).rows[0] as T | undefined;
}

export async function run(db: DB, sql: string, params?: Params): Promise<{ changes: number }> {
  const r = await query(db, sql, params);
  return { changes: r.rowCount };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`不合法的欄位名稱：${name}`);
  return name;
}

/** 沒有 id 欄位的資料表 */
const TABLES_WITHOUT_ID = new Set(['schema_meta', 'user_brands', 'sessions', 'brand_category_settings', 'brand_styles']);

/** 依物件欄位產生 INSERT，回傳新 id（沒有 id 欄位的資料表回傳 0）。欄位名稱必須是 snake_case。 */
export async function insert(db: DB, table: string, row: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined).map(assertIdent);
  const hasId = !TABLES_WITHOUT_ID.has(table);
  const sql = `INSERT INTO ${assertIdent(table)} (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})${
    hasId ? ' RETURNING id' : ''
  }`;
  const params: Record<string, unknown> = {};
  for (const c of cols) params[c] = row[c];
  const r = await query(db, sql, params);
  return hasId ? Number(r.rows[0].id) : 0;
}

/** 依物件欄位產生 UPDATE ... WHERE id = :id，回傳異動筆數。 */
export async function updateById(db: DB, table: string, id: number, patch: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined).map(assertIdent);
  if (cols.length === 0) return 0;
  const sql = `UPDATE ${assertIdent(table)} SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :__id`;
  const params: Record<string, unknown> = { __id: id };
  for (const c of cols) params[c] = patch[c];
  return (await run(db, sql, params)).changes;
}

/**
 * 產生 `column IN (1,2,3)` 片段。只接受整數 id（會驗證），因此可以安全地直接嵌入 SQL。
 * ids 為空陣列時回傳永遠為假的條件 `0 = 1`。
 */
export function sqlIn(column: string, ids: readonly number[]): string {
  if (!/^[a-z_][a-z0-9_.]*$/.test(column)) throw new Error(`不合法的欄位名稱：${column}`);
  if (ids.length === 0) return '0 = 1';
  for (const id of ids) if (!Number.isSafeInteger(id)) throw new Error(`不合法的 id：${id}`);
  return `${column} IN (${ids.join(',')})`;
}

/** 解析 JSON 欄位；解析失敗時回傳 fallback */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 0/1 → boolean */
export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}
