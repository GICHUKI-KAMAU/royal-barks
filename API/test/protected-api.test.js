import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scryptSync, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { initializeAuth, bootstrapAdmin } from "../src/auth.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
async function freePort() {
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function json(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await res.json();
  return { res, body };
}

test("HTTP API requires session, applies role and member scope, and revokes logout sessions", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "royal-barks-auth-")),
    dbPath = path.join(dir, "auth.sqlite3"),
    port = await freePort(),
    base = `http://127.0.0.1:${port}`;
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(`
   CREATE TABLE members(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,status TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE audit_log(id INTEGER PRIMARY KEY,event TEXT,actor TEXT,entity TEXT,entity_id INTEGER,details_json TEXT,created_at TEXT);
   CREATE TABLE imports(id INTEGER PRIMARY KEY,fingerprint TEXT,statement_date TEXT,source TEXT,imported_by TEXT,reviewed_by TEXT,approved_by TEXT,status TEXT,reference_json TEXT,reconciliation_json TEXT,created_at TEXT);
  `);
  db.prepare("INSERT INTO members(id,name,status,created_at) VALUES(1,?,?,?)").run(
    "Linked Member",
    "ACTIVE",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO members(id,name,status,created_at) VALUES(2,?,?,?)").run(
    "Other Member",
    "ACTIVE",
    new Date().toISOString(),
  );
  initializeAuth(db, () => {});
  const adminId = await bootstrapAdmin(db, {
    email: "admin@example.org",
    displayName: "Admin",
    password: "admin-test-password-123",
  });
  const salt = randomBytes(16),
    password = "member-test-password-123",
    memberHash = `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`,
    stamp = new Date().toISOString();
  const memberId = Number(
    db
      .prepare(
        "INSERT INTO profiles(auth_user_id,member_id,display_name,email,password_hash,account_status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)",
      )
      .run(randomUUID(), 1, "Linked Member", "member@example.org", memberHash, stamp, stamp, stamp)
      .lastInsertRowid,
  );
  db.prepare("INSERT INTO role_assignments(profile_id,role,assigned_at) VALUES(?,'MEMBER',?)").run(
    memberId,
    stamp,
  );
  db.close();
  const child = spawn(process.execPath, [path.join(root, "API", "src", "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ROYAL_BARKS_DB: dbPath, NODE_ENV: "test" },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {
      // The child API has not started listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(ready, true, "API started");
  const denied = await json(`${base}/api/members`);
  assert.equal(denied.res.status, 401);
  const forged = await json(`${base}/api/members/1/status`, {
    method: "POST",
    body: JSON.stringify({
      roles: ["ADMIN"],
      new_status: "DORMANT",
      effective_date: "2026-10-18",
      reason: "forged",
      official: "browser",
      confirmed: true,
    }),
  });
  assert.equal(forged.res.status, 401);
  const login = await json(`${base}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ email: "member@example.org", password }),
  });
  assert.equal(login.res.status, 200);
  const cookie = login.res.headers.get("set-cookie").split(";")[0];
  const own = await json(`${base}/api/members`, { headers: { cookie } });
  assert.equal(own.res.status, 200);
  assert.equal(own.body.length, 1);
  assert.equal(own.body[0].name, "Linked Member");
  const blocked = await json(`${base}/api/payments`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      member_id: 1,
      amount: 100,
      category: "monthly",
      transaction_date: "2026-10-18",
      official: "fake",
    }),
  });
  assert.equal(blocked.res.status, 403);
  const logout = await json(`${base}/api/auth/logout`, {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(logout.res.status, 200);
  const revoked = await json(`${base}/api/members`, { headers: { cookie } });
  assert.equal(revoked.res.status, 401);
  const admin = await json(`${base}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.org", password: "admin-test-password-123" }),
  });
  assert.equal(admin.res.status, 200);
  const all = await json(`${base}/api/members`, {
    headers: { cookie: admin.res.headers.get("set-cookie").split(";")[0] },
  });
  assert.equal(all.body.length, 2);
  assert.equal(admin.body.user.id, adminId);
});
