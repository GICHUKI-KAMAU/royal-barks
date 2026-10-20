import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const apiDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(apiDirectory, "migrations");

function loadEnvironment() {
  const repositoryRoot = path.resolve(apiDirectory, "..");

  try {
    process.loadEnvFile(path.join(repositoryRoot, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function createClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("Set DATABASE_URL in the root .env before applying PostgreSQL migrations.");
  }

  return new Client({
    connectionString,
    ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: true },
  });
}

async function ensureMigrationTable(client) {
  await client.query("CREATE SCHEMA IF NOT EXISTS app_private");
  await client.query("REVOKE ALL ON SCHEMA app_private FROM PUBLIC");
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_private.schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles() {
  const files = await readdir(migrationDirectory);

  return files.filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
}

async function migrationAlreadyApplied(client, version) {
  const result = await client.query(
    "SELECT 1 FROM app_private.schema_migrations WHERE version = $1",
    [version],
  );

  return result.rowCount > 0;
}

async function applyMigration(client, fileName) {
  const [version, ...nameParts] = fileName.replace(/\.sql$/, "").split("_");

  if (await migrationAlreadyApplied(client, version)) {
    return false;
  }

  const query = await readFile(path.join(migrationDirectory, fileName), "utf8");
  await client.query("BEGIN");

  try {
    await client.query(query);
    await client.query("INSERT INTO app_private.schema_migrations(version, name) VALUES($1, $2)", [
      version,
      nameParts.join("_"),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return true;
}

async function main() {
  loadEnvironment();
  const client = createClient();
  await client.connect();

  try {
    await ensureMigrationTable(client);
    const files = await listMigrationFiles();

    for (const fileName of files) {
      const applied = await applyMigration(client, fileName);
      console.log(`${applied ? "Applied" : "Already applied"}: ${fileName}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PostgreSQL migration failed: ${error.message}`);
  process.exitCode = 1;
});
