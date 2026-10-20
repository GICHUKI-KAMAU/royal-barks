import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { PostgresDatabase } from "./postgresDatabase.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function createDatabase() {
  loadEnvironment(repositoryRoot);

  if (process.env.DATABASE_URL) {
    return createPostgresDatabase();
  }

  const databasePath =
    process.env.ROYAL_BARKS_DB || path.join(repositoryRoot, "API", "data", "royal_barks.sqlite3");

  mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.kind = "sqlite";
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");

  createBaseSchema(database);
  migrateImportSupplementalField(database);

  return database;
}

function createPostgresDatabase() {
  const database = new PostgresDatabase({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL !== "false",
  });
  const schema = database.prepare("SELECT to_regclass('public.members') AS members_table").get();

  if (!schema?.members_table) {
    database.close();
    throw new Error("PostgreSQL schema is missing. Run npm run db:migrate:postgres first.");
  }

  return database;
}

function loadEnvironment(rootDirectory) {
  try {
    process.loadEnvFile(path.join(rootDirectory, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function createBaseSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS members(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS status_history(
      id INTEGER PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      previous_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      effective_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      official TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS obligations(
      id INTEGER PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      category TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount>=0),
      obligation_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source_key TEXT UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions(
      id INTEGER PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      category TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount>=0),
      transaction_date TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source_key TEXT UNIQUE,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetings(
      id INTEGER PRIMARY KEY,
      meeting_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendance(
      id INTEGER PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      attended INTEGER NOT NULL CHECK(attended IN (0,1)),
      UNIQUE(meeting_id,member_id)
    );
    CREATE TABLE IF NOT EXISTS imports(
      id INTEGER PRIMARY KEY,
      fingerprint TEXT UNIQUE NOT NULL,
      statement_date TEXT NOT NULL,
      source TEXT NOT NULL,
      imported_by TEXT NOT NULL,
      reviewed_by TEXT,
      approved_by TEXT,
      status TEXT NOT NULL,
      reference_json TEXT NOT NULL,
      reconciliation_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_rows(
      id INTEGER PRIMARY KEY,
      import_id INTEGER NOT NULL REFERENCES imports(id),
      member_name TEXT NOT NULL,
      existing_status TEXT NOT NULL,
      amounts_json TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      issues_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opening_balances(
      id INTEGER PRIMARY KEY,
      import_row_id INTEGER NOT NULL REFERENCES import_rows(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_type TEXT NOT NULL,
      statement_date TEXT NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(import_row_id,category,balance_type)
    );
    CREATE TABLE IF NOT EXISTS audit_log(
      id INTEGER PRIMARY KEY,
      event TEXT NOT NULL,
      actor TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function migrateImportSupplementalField(database) {
  const columns = database.prepare("PRAGMA table_info(imports)").all();
  const hasSupplementalField = columns.some((column) => column.name === "supplemental_json");

  if (!hasSupplementalField) {
    database.exec("ALTER TABLE imports ADD COLUMN supplemental_json TEXT NOT NULL DEFAULT '{}'");
  }
}
