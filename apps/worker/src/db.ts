import type { Env } from "./env";
import { migrate, type Scope } from "./migrations";

// One SQL dialect for both backends. Each Durable Object runs its queries against its own SQLite
// storage, or against the shared D1 database when STORAGE_BACKEND is "d1"; only the driver differs.

export type Value = string | number | null;

/** A query and the values it binds, as `Db.batch` takes them. */
export interface Statement {
  query: string;
  params: Value[];
}

export const statement = (query: string, ...params: Value[]): Statement => ({ query, params });

export interface Db {
  all<T>(query: string, ...params: Value[]): Promise<T[]>;
  run(query: string, ...params: Value[]): Promise<void>;
  /**
   * Runs the statements in order as one transaction and returns each one's rows: if one fails, none
   * of them take effect. D1 has no other kind of transaction, so a write that has to be atomic is
   * one batch whose statements check their own conditions, rather than a read followed by writes.
   */
  batch(statements: Statement[]): Promise<unknown[][]>;
}

function durableObjectDb(storage: DurableObjectStorage): Db {
  const { sql } = storage;
  return {
    async all<T>(query: string, ...params: Value[]) {
      return rowsOf(sql.exec(query, ...params)) as T[];
    },
    async run(query: string, ...params: Value[]) {
      sql.exec(query, ...params);
    },
    async batch(statements: Statement[]) {
      // `sql.exec` can't run BEGIN, so the transaction comes from the storage API instead. Its
      // statements return few rows or none, where `rowsOf` costs more than `toArray`: with it,
      // profiles showed posting a message slower.
      return storage.transactionSync(() => statements.map(({ query, params }) => sql.exec(query, ...params).toArray()));
    },
  };
}

/**
 * A cursor's rows as objects, made here from its rows of values. The cursor's own objects, which
 * `toArray` gives, are made a column at a time by the runtime, and profiles showed that costing more
 * than running the query. A name that appears twice keeps its last column's value, as there.
 */
function rowsOf(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): Record<string, SqlStorageValue>[] {
  const names = cursor.columnNames;
  const rows: Record<string, SqlStorageValue>[] = [];
  for (const values of cursor.raw()) {
    const row: Record<string, SqlStorageValue> = {};
    for (let i = 0; i < names.length; i++) row[names[i]!] = values[i]!;
    rows.push(row);
  }
  return rows;
}

function d1Db(db: D1Database): Db {
  return {
    async all<T>(query: string, ...params: Value[]) {
      return (await db.prepare(query).bind(...params).all<T>()).results;
    },
    async run(query: string, ...params: Value[]) {
      await db.prepare(query).bind(...params).run();
    },
    async batch(statements: Statement[]) {
      // D1 refuses an empty batch, where DO SQLite has nothing to do.
      if (statements.length === 0) return [];
      const results = await db.batch(statements.map(({ query, params }) => db.prepare(query).bind(...params)));
      return results.map((result) => result.results);
    },
  };
}

/** The D1 database every object keeps its tables in when STORAGE_BACKEND is "d1", or null when each keeps its own. */
export function sharedDb(env: Env): Db | null {
  if (env.STORAGE_BACKEND !== "d1") return null;
  if (!env.DB) throw new Error('STORAGE_BACKEND is "d1" but no D1 database is bound as DB in wrangler.jsonc.');
  return d1Db(env.DB);
}

/**
 * The database that a Durable Object of `scope`'s kind keeps its tables in. On DO SQLite that's the
 * object's own storage, which first gets whichever of the scope's migrations it's missing; wrangler
 * applies every migration to D1. The search index keeps its tables in its own storage whatever the
 * backend (`SEARCH_MIGRATIONS`), so it has no scope here.
 */
export function openDb(env: Env, storage: DurableObjectStorage, scope: Exclude<Scope, "search">): Db {
  const shared = sharedDb(env);
  if (shared) return shared;
  migrate(storage, scope);
  return durableObjectDb(storage);
}
