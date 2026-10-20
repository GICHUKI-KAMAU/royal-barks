import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../src/database.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_DATABASE_NAME = "royal_barks_test";

function loadEnvironment() {
  try {
    process.loadEnvFile(path.join(repositoryRoot, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function assertDedicatedLocalDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL to your local royal_barks_test database in .env.");
  }

  const connectionUrl = new URL(process.env.DATABASE_URL);
  const databaseName = decodeURIComponent(connectionUrl.pathname.replace(/^\//, ""));
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(connectionUrl.hostname);

  if (!isLoopback || databaseName !== TEST_DATABASE_NAME) {
    throw new Error(
      `Adapter integration checks only run against local database ${TEST_DATABASE_NAME}.`,
    );
  }
}

function createTestMemberName() {
  return `ADAPTER TEST ${randomUUID()}`;
}

function verifyTransactionAndInsertResults(database, memberName) {
  const rollbackMarker = new Error("Rollback the adapter test transaction.");

  assert.throws(
    () =>
      database.transaction(() => {
        const inserted = database
          .prepare("INSERT INTO members(name,status,created_at) VALUES(?,?,?)")
          .run(memberName, "ACTIVE", new Date().toISOString());

        assert.ok(Number(inserted.lastInsertRowid) > 0);

        const found = database
          .prepare("SELECT name,status FROM members WHERE name=? COLLATE NOCASE")
          .get(memberName.toLowerCase());
        assert.equal(found.name, memberName);
        assert.equal(found.status, "ACTIVE");

        const changed = database
          .prepare("UPDATE members SET status=? WHERE name=? COLLATE NOCASE")
          .run("DORMANT", memberName);
        assert.equal(changed.changes, 1);

        const duplicate = database
          .prepare("INSERT OR IGNORE INTO members(name,status,created_at) VALUES(?,?,?)")
          .run(memberName.toLowerCase(), "ACTIVE", new Date().toISOString());
        assert.equal(duplicate.changes, 0);

        throw rollbackMarker;
      })(),
    (error) => error === rollbackMarker,
  );
}

function verifyRollback(database, memberName) {
  const row = database
    .prepare("SELECT id FROM members WHERE name=? COLLATE NOCASE")
    .get(memberName);

  assert.equal(row, undefined, "the transaction should leave no test member behind");
}

async function main() {
  loadEnvironment();
  assertDedicatedLocalDatabase();
  const database = createDatabase();

  try {
    if (database.kind !== "postgres") {
      throw new Error("DATABASE_URL did not select the PostgreSQL adapter.");
    }

    const memberName = createTestMemberName();
    verifyTransactionAndInsertResults(database, memberName);
    verifyRollback(database, memberName);
    console.log("PostgreSQL adapter integration checks passed; no test rows remain.");
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(`PostgreSQL adapter integration check failed: ${error.message}`);
  process.exitCode = 1;
});
