import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import pg from "pg";

const { Client } = pg;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TABLES_IN_ORDER = [
  "members",
  "imports",
  "profiles",
  "status_history",
  "obligations",
  "transactions",
  "meetings",
  "attendance",
  "import_rows",
  "opening_balances",
  "audit_log",
  "role_assignments",
  "auth_tokens",
  "auth_audit",
  "import_approvals",
  "chama_cycles",
  "chama_participants",
  "chama_cards",
  "chama_selections",
  "chama_selection_events",
  "chama_payouts",
  "chama_payout_events",
  "chama_selection_corrections",
  "chama_cycle_history",
  "chama_audit_events",
];
const IDENTITY_TABLES = TABLES_IN_ORDER.filter((table) =>
  [
    "members",
    "imports",
    "profiles",
    "status_history",
    "obligations",
    "transactions",
    "meetings",
    "attendance",
    "import_rows",
    "opening_balances",
    "audit_log",
    "auth_tokens",
    "auth_audit",
    "chama_selection_events",
    "chama_payout_events",
    "chama_selection_corrections",
    "chama_cycle_history",
    "chama_audit_events",
  ].includes(table),
);
const EPHEMERAL_TABLES = new Set(["auth_sessions", "auth_rate_limits"]);

function loadEnvironment() {
  try {
    process.loadEnvFile(path.join(repositoryRoot, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function createPostgresClient() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL in the root .env before importing application data.");
  }

  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: true },
  });
}

async function confirmImport(sourceDatabasePath) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await new Promise((resolve) => {
      prompt.question(
        `Import Royal Barks data from ${sourceDatabasePath} into DATABASE_URL? Type IMPORT to continue: `,
        resolve,
      );
    });

    if (answer !== "IMPORT") {
      throw new Error("Import cancelled.");
    }
  } finally {
    prompt.close();
  }
}

function createSourceDatabase(sourceDatabasePath) {
  if (!existsSync(sourceDatabasePath)) {
    throw new Error(`SQLite source database was not found at ${sourceDatabasePath}.`);
  }

  return new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
}

function readRows(source, tableName) {
  return source.prepare(`SELECT * FROM "${tableName}"`).all();
}

async function insertRows(target, tableName, rows) {
  if (rows.length === 0) {
    return 0;
  }

  const columns = Object.keys(rows[0]);
  const columnSql = columns.map((column) => `"${column}"`).join(", ");
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const statement = `INSERT INTO public."${tableName}" (${columnSql}) VALUES (${placeholders})`;

  for (const row of rows) {
    await target.query(
      statement,
      columns.map((column) => row[column]),
    );
  }

  return rows.length;
}

async function ensureTargetIsEmpty(target) {
  const tableNames = [...TABLES_IN_ORDER, ...EPHEMERAL_TABLES];
  const counts = [];

  for (const tableName of tableNames) {
    const result = await target.query(`SELECT COUNT(*) AS count FROM public."${tableName}"`);
    counts.push(Number(result.rows[0].count));
  }

  if (counts.some((count) => count > 0)) {
    throw new Error(
      "The PostgreSQL target already contains app data; import stopped to prevent duplicates.",
    );
  }
}

async function synchronizeIdentitySequences(target) {
  for (const tableName of IDENTITY_TABLES) {
    await target.query(`
      SELECT setval(
        pg_get_serial_sequence('public.${tableName}', 'id'),
        GREATEST(COALESCE((SELECT MAX(id) FROM public.${tableName}), 1), 1),
        EXISTS (SELECT 1 FROM public.${tableName})
      )
    `);
  }
}

function calculateSourceFingerprint(source) {
  const sourceHash = createHash("sha256");

  for (const tableName of TABLES_IN_ORDER) {
    sourceHash.update(tableName);
    sourceHash.update(JSON.stringify(readRows(source, tableName)));
  }

  return sourceHash.digest("hex");
}

async function ensureImportHistoryTable(target) {
  await target.query(`
    CREATE TABLE IF NOT EXISTS app_private.sqlite_imports (
      fingerprint TEXT PRIMARY KEY,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      row_counts JSONB NOT NULL
    )
  `);
}

async function importRecords(source, target) {
  await ensureTargetIsEmpty(target);
  await ensureImportHistoryTable(target);
  const fingerprint = calculateSourceFingerprint(source);
  const priorImport = await target.query(
    "SELECT 1 FROM app_private.sqlite_imports WHERE fingerprint = $1",
    [fingerprint],
  );

  if (priorImport.rowCount > 0) {
    throw new Error("This SQLite database has already been imported into the target.");
  }

  const counts = {};
  await target.query("BEGIN");

  try {
    for (const tableName of TABLES_IN_ORDER) {
      const rows = readRows(source, tableName);
      counts[tableName] = await insertRows(target, tableName, rows);
    }

    await synchronizeIdentitySequences(target);
    counts.auth_sessions = 0;
    counts.auth_rate_limits = 0;
    await target.query(
      "INSERT INTO app_private.sqlite_imports(fingerprint, row_counts) VALUES($1, $2::jsonb)",
      [fingerprint, JSON.stringify(counts)],
    );
    await target.query("COMMIT");
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  }

  return counts;
}

async function main() {
  loadEnvironment();
  const sourceDatabasePath =
    process.env.ROYAL_BARKS_DB || path.join(repositoryRoot, "API", "data", "royal_barks.sqlite3");
  const target = createPostgresClient();
  const source = createSourceDatabase(sourceDatabasePath);
  source.exec("BEGIN");
  let targetConnected = false;

  try {
    await target.connect();
    targetConnected = true;
    await confirmImport(sourceDatabasePath);
    const counts = await importRecords(source, target);
    console.log(
      "SQLite records imported. Existing sessions and temporary login limits were omitted.",
    );
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    source.exec("ROLLBACK");
    source.close();
    if (targetConnected) {
      await target.end();
    }
  }
}

main().catch((error) => {
  console.error(`SQLite to PostgreSQL import failed: ${error.message}`);
  process.exitCode = 1;
});
