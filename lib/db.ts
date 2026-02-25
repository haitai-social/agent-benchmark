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
      namedPlaceholders: false
    });
  }
  return mySqlPool;
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

async function executeQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
  executor?: PgPool | PgClient | MySqlPool | MySqlPoolConnection
): Promise<DbResult<T>> {
  if (dbEngine === "mysql") {
    return runMySqlQuery<T>((executor as MySqlPool | MySqlPoolConnection | undefined) ?? getMySqlPool(), text, params);
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

function toCount(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

async function ensureMySqlColumn(tableName: string, columnName: string, alterSql: string) {
  const result = await executeQuery<{ c: number | string }>(
    `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1 AND COLUMN_NAME = $2`,
    [tableName, columnName]
  );

  if (toCount(result.rows[0]?.c) === 0) {
    await executeQuery(alterSql);
  }
}

async function ensureMySqlSchemaCompatibility() {
  await ensureMySqlColumn(
    "datasets",
    "created_by",
    "ALTER TABLE datasets ADD COLUMN created_by VARCHAR(255) NOT NULL DEFAULT 'shesl-meow'"
  );
  await ensureMySqlColumn(
    "datasets",
    "updated_by",
    "ALTER TABLE datasets ADD COLUMN updated_by VARCHAR(255) NOT NULL DEFAULT 'shesl-meow'"
  );
  await ensureMySqlColumn(
    "datasets",
    "updated_at",
    "ALTER TABLE datasets ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
  );
}

async function ensurePostgresColumnNullable(tableName: string, columnName: string, alterSql: string) {
  const result = await executeQuery<{ is_nullable: string }>(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );

  if (result.rows[0]?.is_nullable === "NO") {
    await executeQuery(alterSql);
  }
}

async function ensurePostgresSchemaCompatibility() {
  await ensurePostgresColumnNullable(
    "data_items",
    "agent_trajectory",
    "ALTER TABLE data_items ALTER COLUMN agent_trajectory DROP NOT NULL"
  );
}

export async function ensureDbReady() {
  if (!initPromise) {
    initPromise = (async () => {
      const initSql = await loadInitSql();
      await executeSqlScript(initSql);
      if (dbEngine === "mysql") {
        await ensureMySqlSchemaCompatibility();
      } else {
        await ensurePostgresSchemaCompatibility();
      }
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
