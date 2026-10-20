import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const RESPONSE_BUFFER_BYTES = 8 * 1024 * 1024 + 8;
const WAIT_TIMEOUT_MS = 36_000;
const IDENTITY_TABLES = new Set([
  "members",
  "status_history",
  "obligations",
  "transactions",
  "meetings",
  "attendance",
  "imports",
  "import_rows",
  "opening_balances",
  "audit_log",
  "profiles",
  "auth_tokens",
  "auth_sessions",
  "auth_audit",
  "chama_selection_events",
  "chama_payout_events",
  "chama_selection_corrections",
  "chama_cycle_history",
  "chama_audit_events",
]);

function createBuffer() {
  return new SharedArrayBuffer(RESPONSE_BUFFER_BYTES);
}

function readResponse(buffer) {
  const state = new Int32Array(buffer, 0, 2);
  const resultLength = Atomics.load(state, 1);
  const resultBytes = new Uint8Array(buffer, 8, resultLength);
  const result = JSON.parse(new TextDecoder().decode(resultBytes));

  if (Atomics.load(state, 0) === 2) {
    throw new Error(result.error || "PostgreSQL request failed.");
  }

  return result;
}

function waitForResponse(buffer, label) {
  const state = new Int32Array(buffer, 0, 2);
  const result = Atomics.wait(state, 0, 0, WAIT_TIMEOUT_MS);

  if (result === "timed-out") {
    throw new Error(`Timed out waiting for PostgreSQL ${label}.`);
  }

  return readResponse(buffer);
}

export function normalizeSql(sql) {
  let parameterIndex = 0;
  let normalized = sql.replace(/([\w.]+)\s*=\s*\?\s+COLLATE\s+NOCASE/gi, "LOWER($1) = LOWER(?)");
  normalized = normalized.replace(/ORDER BY\s+([\w.]+)\s+COLLATE\s+NOCASE/gi, "ORDER BY LOWER($1)");

  const ignoresConflicts = /^\s*INSERT\s+OR\s+IGNORE\s+/i.test(normalized);
  normalized = normalized.replace(/^\s*INSERT\s+OR\s+IGNORE\s+/i, "INSERT ");
  normalized = normalized.replace(/\?/g, () => `$${++parameterIndex}`);

  return {
    sql: ignoresConflicts ? `${normalized} ON CONFLICT DO NOTHING` : normalized,
  };
}

function insertTableName(sql) {
  return sql.match(/^\s*INSERT\s+INTO\s+([a-z_]+)/i)?.[1]?.toLowerCase() || null;
}

export function queryForRun(sql) {
  const statement = normalizeSql(sql).sql.trim().replace(/;$/, "");
  const tableName = insertTableName(statement);

  if (tableName && IDENTITY_TABLES.has(tableName) && !/\bRETURNING\b/i.test(statement)) {
    return `${statement} RETURNING id`;
  }

  return statement;
}

export class PostgresDatabase {
  constructor({ connectionString, ssl = true }) {
    const readyBuffer = createBuffer();
    this.worker = new Worker(fileURLToPath(new URL("./postgres.worker.js", import.meta.url)), {
      workerData: { connectionString, ssl, readyBuffer },
    });
    this.readyBuffer = readyBuffer;
    this.queryBuffer = createBuffer();
    this.kind = "postgres";
    try {
      waitForResponse(readyBuffer, "connection startup");
    } catch (error) {
      this.worker.terminate();
      throw error;
    }
  }

  request(action, sql = "", parameters = []) {
    const buffer = this.queryBuffer;
    const state = new Int32Array(buffer, 0, 2);
    Atomics.store(state, 0, 0);
    Atomics.store(state, 1, 0);
    this.worker.postMessage({ action, sql, parameters, buffer });
    return waitForResponse(buffer, "query");
  }

  prepare(sql) {
    return {
      all: (...parameters) => this.request("query", normalizeSql(sql).sql, parameters).rows,
      get: (...parameters) => this.request("query", normalizeSql(sql).sql, parameters).rows[0],
      run: (...parameters) => {
        const result = this.request("query", queryForRun(sql), parameters);
        return {
          changes: result.rowCount,
          lastInsertRowid: result.rows[0]?.id ?? 0,
        };
      },
    };
  }

  exec(sql) {
    return this.request("exec", sql);
  }

  pragma() {
    return undefined;
  }

  transaction(callback) {
    return (...parameters) => {
      this.exec("BEGIN");

      try {
        const result = callback(...parameters);
        this.exec("COMMIT");
        return result;
      } catch (error) {
        this.exec("ROLLBACK");
        throw error;
      }
    };
  }

  close() {
    this.request("close");
    return this.worker.terminate();
  }
}
