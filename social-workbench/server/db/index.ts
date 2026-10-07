import './suppressWarning';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION, TABLES_IN_ORDER } from './schema';
import { bootstrapSystemData } from './bootstrap';

// 以 getBuiltinModule 延後載入 node:sqlite，讓 suppressWarning 先生效（靜態 import 會在模組連結階段就印出警告）
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type DB = DatabaseSyncType;

/**
 * 開啟資料庫並套用結構。path 為 ':memory:' 時使用記憶體資料庫（測試用）。
 */
export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  bootstrapSystemData(db);
}

/** 刪除所有資料表後重建（重設模擬資料用） */
export function resetDatabase(db: DB): void {
  stmtCache.delete(db);
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const table of [...TABLES_IN_ORDER].reverse()) db.exec(`DROP TABLE IF EXISTS ${table};`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  migrate(db);
}

// ---------------- 交易 ----------------
const txDepth = new WeakMap<DB, number>();

/**
 * 在交易中執行 fn；可巢狀呼叫（內層使用 SAVEPOINT）。fn 丟出錯誤時整筆回復。
 * 注意：fn 必須是同步函式（node:sqlite 為同步 API）。
 */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('tx() 只接受同步函式');
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

// ---------------- 查詢輔助 ----------------
// node:sqlite 不接受 boolean / undefined / 物件參數，這裡統一轉換：
// boolean → 0/1、undefined → null、Date → ISO 字串、陣列與一般物件 → JSON 字串。
type SqlValue = string | number | bigint | null | Uint8Array;
export type Params = Record<string, unknown> | unknown[];

function toSqlValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

function normalize(params: Params | undefined): SqlValue[] | Record<string, SqlValue> {
  if (!params) return [];
  if (Array.isArray(params)) return params.map(toSqlValue);
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = toSqlValue(v);
  return out;
}

const stmtCache = new WeakMap<DB, Map<string, StatementSync>>();
function prepare(db: DB, sql: string): StatementSync {
  let cache = stmtCache.get(db);
  if (!cache) stmtCache.set(db, (cache = new Map()));
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

function exec<R>(stmt: StatementSync, method: 'all' | 'get' | 'run', params: Params | undefined): R {
  const p = normalize(params);
  const fn = stmt[method].bind(stmt) as (...args: unknown[]) => R;
  return Array.isArray(p) ? fn(...p) : fn(p);
}

/**
 * 具名參數用 :name 寫在 SQL 中，params 傳 { name: value }；位置參數用 ?，params 傳陣列。
 */
export function all<T = Record<string, unknown>>(db: DB, sql: string, params?: Params): T[] {
  return exec<T[]>(prepare(db, sql), 'all', params);
}

export function get<T = Record<string, unknown>>(db: DB, sql: string, params?: Params): T | undefined {
  return exec<T | undefined>(prepare(db, sql), 'get', params);
}

export function run(db: DB, sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const r = exec<{ changes: number | bigint; lastInsertRowid: number | bigint }>(prepare(db, sql), 'run', params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`不合法的欄位名稱：${name}`);
  return name;
}

/** 依物件欄位產生 INSERT，回傳新 id。欄位名稱必須是 snake_case。 */
export function insert(db: DB, table: string, row: Record<string, unknown>): number {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined).map(assertIdent);
  const sql = `INSERT INTO ${assertIdent(table)} (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`;
  const params: Record<string, unknown> = {};
  for (const c of cols) params[c] = row[c];
  return run(db, sql, params).lastInsertRowid;
}

/** 依物件欄位產生 UPDATE ... WHERE id = :id，回傳異動筆數。 */
export function updateById(db: DB, table: string, id: number, patch: Record<string, unknown>): number {
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined).map(assertIdent);
  if (cols.length === 0) return 0;
  const sql = `UPDATE ${assertIdent(table)} SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :__id`;
  const params: Record<string, unknown> = { __id: id };
  for (const c of cols) params[c] = patch[c];
  return run(db, sql, params).changes;
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

/** SQLite 0/1 → boolean */
export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}
