import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSql, queryForRun } from "../src/postgresDatabase.js";

test("translates case-insensitive SQLite comparisons to PostgreSQL", () => {
  const result = normalizeSql("SELECT id FROM profiles WHERE email=? COLLATE NOCASE");

  assert.equal(result.sql, "SELECT id FROM profiles WHERE LOWER(email) = LOWER($1)");
});

test("converts SQLite conflict ignoring inserts to PostgreSQL conflict handling", () => {
  const result = queryForRun(
    "INSERT OR IGNORE INTO attendance(meeting_id,member_id,attended) VALUES(?,?,?)",
  );

  assert.equal(
    result,
    "INSERT INTO attendance(meeting_id,member_id,attended) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
  );
});

test("returns generated IDs for inserts into identity tables", () => {
  const result = queryForRun("INSERT INTO members(name,status,created_at) VALUES(?,?,?)");

  assert.equal(result, "INSERT INTO members(name,status,created_at) VALUES($1,$2,$3) RETURNING id");
});

test("does not add identity returns to Chama UUID inserts", () => {
  const result = queryForRun("INSERT INTO chama_cycles(id,name,description) VALUES(?,?,?)");

  assert.equal(result, "INSERT INTO chama_cycles(id,name,description) VALUES($1,$2,$3)");
});
