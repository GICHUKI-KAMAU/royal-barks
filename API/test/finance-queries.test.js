import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFinanceQueries } from "../src/modules/financeQueries.js";

test("financial report applies its as-of date and preserves member-only scope", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE members(id INTEGER PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE opening_balances(
      member_id INTEGER, category TEXT, amount REAL, balance_type TEXT, statement_date TEXT
    );
    CREATE TABLE obligations(
      member_id INTEGER, category TEXT, amount REAL, obligation_date TEXT
    );
    CREATE TABLE transactions(
      member_id INTEGER, category TEXT, amount REAL, transaction_date TEXT
    );
  `);
  db.prepare(
    "INSERT INTO members(id,name,status) VALUES(1,'Alice','ACTIVE'),(2,'Bob','DORMANT')",
  ).run();
  db.prepare(
    "INSERT INTO opening_balances VALUES(1,'monthly',50,'opening_arrears','2026-04-01'),(1,'monthly',100,'paid_historical','2026-04-01'),(2,'monthly',30,'opening_arrears','2026-04-01')",
  ).run();
  db.prepare(
    "INSERT INTO obligations VALUES(1,'monthly',20,'2026-04-10'),(1,'monthly',40,'2026-05-01'),(2,'monthly',15,'2026-04-12')",
  ).run();
  db.prepare(
    "INSERT INTO transactions VALUES(1,'monthly',10,'2026-04-20'),(1,'monthly',5,'2026-05-02')",
  ).run();

  const queries = createFinanceQueries(db, {
    statuses: ["ACTIVE", "DORMANT", "STATUS TO CONFIRM"],
    reference: {},
    statusOn: (memberId) => (memberId === 1 ? "ACTIVE" : "DORMANT"),
  });

  const scoped = queries.report("2026-04-30", 1, true);
  assert.equal(scoped.members.length, 1);
  assert.equal(scoped.members[0].member_name, "Alice");
  assert.equal(scoped.members[0].categories.monthly.historical_paid, 100);
  assert.equal(scoped.members[0].categories.monthly.due, 60);
  assert.deepEqual(queries.report("2026-04-30", null, true).members, []);
  assert.equal(queries.report("2026-04-30").members.length, 2);

  db.close();
});
