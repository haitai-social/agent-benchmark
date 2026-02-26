import fs from "node:fs/promises";
import path from "node:path";
import mysql, { type Pool as MySqlPool, type PoolConnection as MySqlPoolConnection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { Pool as PgPool, type PoolClient as PgClient, type QueryResultRow } from "pg";

type DbEngine = "postgres" | "mysql";

type DbSelectResult<T> = {
  rows: T[];
  rowCount: number;
};

type DbExecResult<T> = DbSelectResult<T> & {
  affectedRows: number;
  insertId: number;
};

type DbResult<T> = DbSelectResult<T> | DbExecResult<T>;

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<DbResult<T>>;
};

const rawEngine = (process.env.DATEBASE_ENGINE ?? process.env.DATABASE_ENGINE ?? "postgres").toLowerCase();
const dbEngine: DbEngine = rawEngine === "mysql" ? "mysql" : "postgres";

function ensureEnv(name: string) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return process.env[name] as string;
}

let pgPool: PgPool | null = null;
let mySqlPool: MySqlPool | null = null;
let mySqlPoolRecyclePromise: Promise<void> | null = null;
const MYSQL_RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "ECONNRESET",
  "EPIPE"
]);

function getPgPool() {
  if (!pgPool) {
    const connectionString = [
      `postgresql://${ensureEnv("POSTGRES_USER")}:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "")}`,
      `@${ensureEnv("POSTGRES_SERVER")}:${process.env.POSTGRES_PORT ?? "5432"}/${ensureEnv("POSTGRES_DB")}`
    ].join("");

    pgPool = new PgPool({ connectionString });
  }
  return pgPool;
}

function getMySqlPool() {
  if (!mySqlPool) {
    mySqlPool = mysql.createPool({
      host: ensureEnv("MYSQL_SERVER"),
      port: Number(process.env.MYSQL_PORT ?? "3306"),
      user: ensureEnv("MYSQL_USER"),
      password: process.env.MYSQL_PASSWORD ?? "",
      database: ensureEnv("MYSQL_DB"),
      waitForConnections: true,
      connectionLimit: 10,
      namedPlaceholders: false,
      connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT_MS ?? "10000"),
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });
  }
  return mySqlPool;
}

async function resetMySqlPool() {
  if (mySqlPoolRecyclePromise) {
    await mySqlPoolRecyclePromise;
    return;
  }
  const stalePool = mySqlPool;
  mySqlPool = null;
  if (!stalePool) return;

  mySqlPoolRecyclePromise = (async () => {
    try {
      await stalePool.end();
    } catch {
      // no-op: stale pool can already be broken/closed
    }
  })();

  try {
    await mySqlPoolRecyclePromise;
  } finally {
    mySqlPoolRecyclePromise = null;
  }
}

function toMySqlQuery(text: string, params: unknown[] = []) {
  const convertedParams: unknown[] = [];
  const convertedText = text.replace(/\$(\d+)/g, (_, indexText: string) => {
    const index = Number(indexText) - 1;
    convertedParams.push(params[index]);
    return "?";
  });

  if (!/\$(\d+)/.test(text)) {
    return { text, params };
  }

  return { text: convertedText, params: convertedParams };
}

async function runPgQuery<T extends QueryResultRow = QueryResultRow>(
  executor: PgPool | PgClient,
  text: string,
  params?: unknown[]
): Promise<DbResult<T>> {
  const result = await executor.query<T>(text, params);
  return {
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length,
    affectedRows: result.rowCount ?? 0,
    insertId: 0
  };
}

async function runMySqlQuery<T extends QueryResultRow = QueryResultRow>(
  executor: MySqlPool | MySqlPoolConnection,
  text: string,
  params?: unknown[]
): Promise<DbResult<T>> {
  const { text: sql, params: values } = toMySqlQuery(text, params);
  const [result] = await executor.query<RowDataPacket[] | ResultSetHeader>(sql, values);

  if (Array.isArray(result)) {
    return {
      rows: result as unknown as T[],
      rowCount: result.length,
      affectedRows: 0,
      insertId: 0
    };
  }

  return {
    rows: [],
    rowCount: result.affectedRows,
    affectedRows: result.affectedRows,
    insertId: result.insertId
  };
}

function isRetryableMySqlError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode === "string" && MYSQL_RETRYABLE_ERROR_CODES.has(maybeCode)) {
    return true;
  }
  const maybeMessage = (error as { message?: unknown }).message;
  return typeof maybeMessage === "string" && maybeMessage.toLowerCase().includes("pool is closed");
}

async function executeQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
  executor?: PgPool | PgClient | MySqlPool | MySqlPoolConnection
): Promise<DbResult<T>> {
  if (dbEngine === "mysql") {
    const activeExecutor = (executor as MySqlPool | MySqlPoolConnection | undefined) ?? getMySqlPool();
    try {
      return await runMySqlQuery<T>(activeExecutor, text, params);
    } catch (error) {
      // Retry once for transient network failures for non-transactional queries.
      if (!executor && isRetryableMySqlError(error)) {
        await resetMySqlPool();
        return runMySqlQuery<T>(getMySqlPool(), text, params);
      }
      throw error;
    }
  }

  return runPgQuery<T>((executor as PgPool | PgClient | undefined) ?? getPgPool(), text, params);
}

let initPromise: Promise<void> | null = null;
let initSqlPromise: Promise<string> | null = null;

async function loadInitSql() {
  if (!initSqlPromise) {
    const filePath = path.join(process.cwd(), "db", dbEngine === "mysql" ? "init.mysql.sql" : "init.postgres.sql");
    initSqlPromise = fs.readFile(filePath, "utf-8");
  }
  return initSqlPromise;
}

function splitSqlStatements(sql: string) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function executeSqlScript(sql: string) {
  const statements = splitSqlStatements(sql);
  for (const statement of statements) {
    await executeQuery(statement);
  }
}

export async function ensureDbReady() {
  if (!initPromise) {
    initPromise = (async () => {
      const initSql = await loadInitSql();
      await executeSqlScript(initSql);
    })();
  }
  return initPromise;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  await ensureDbReady();
  return executeQuery<T>(text, params);
}

export async function withTransaction<T>(run: (tx: Queryable) => Promise<T>) {
  await ensureDbReady();

  if (dbEngine === "mysql") {
    const connection = await getMySqlPool().getConnection();
    try {
      await connection.beginTransaction();
      const tx: Queryable = {
        query: <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
          executeQuery<R>(text, params, connection)
      };
      const result = await run(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  const client = await getPgPool().connect();
  try {
    await client.query("BEGIN");
    const tx: Queryable = {
      query: <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
        executeQuery<R>(text, params, client)
    };
    const result = await run(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const engine = dbEngine;
export const pool = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => dbQuery<T>(text, params)
};
