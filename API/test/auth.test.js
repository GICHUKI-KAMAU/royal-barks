import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initializeAuth, bootstrapAdmin, createAdminInvitation } from "../src/auth.js";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE members(id INTEGER PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE audit_log(id INTEGER PRIMARY KEY,event TEXT,actor TEXT,entity TEXT,entity_id INTEGER,details_json TEXT,created_at TEXT);",
  );
  const auth = initializeAuth(db, () => {});
  return { db, auth };
}
const response = () => ({
  headers: {},
  setHeader(k, v) {
    this.headers[k] = v;
  },
});
const request = (cookie = "") => ({ method: "POST", headers: { cookie } });

test("first Admin bootstrap hashes password and cannot run twice", async () => {
  const { db } = setup();
  const profileId = await bootstrapAdmin(db, {
    email: "admin@example.org",
    displayName: "Treasurer Admin",
    password: "a-strong-password-123",
  });
  assert.equal(
    db.prepare("SELECT account_status FROM profiles WHERE id=?").get(profileId).account_status,
    "ACTIVE",
  );
  assert.match(
    db.prepare("SELECT password_hash FROM profiles WHERE id=?").get(profileId).password_hash,
    /^scrypt\$/,
  );
  assert.notEqual(
    db.prepare("SELECT password_hash FROM profiles WHERE id=?").get(profileId).password_hash,
    "a-strong-password-123",
  );
  await assert.rejects(
    () =>
      bootstrapAdmin(db, {
        email: "other@example.org",
        displayName: "Other",
        password: "a-strong-password-456",
      }),
    /already been bootstrapped/,
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO role_assignments(profile_id,role,assigned_at) VALUES(?,'ADMIN',?)")
        .run(profileId, "now"),
    /active Admin already exists/,
  );
  assert.throws(
    () => db.prepare("UPDATE profiles SET account_status='SUSPENDED' WHERE id=?").run(profileId),
    /Transfer Admin role/,
  );
  db.close();
});

test("first Admin invitation stays inactive until password acceptance and is one-time", async () => {
  const { db, auth } = setup();
  const invitation = createAdminInvitation(db, {
    email: "first-admin@example.org",
    displayName: "first-admin",
  });

  assert.equal(
    db.prepare("SELECT account_status FROM profiles WHERE id=?").get(invitation.profileId)
      .account_status,
    "INVITED",
  );
  assert.deepEqual(auth.roles(invitation.profileId), ["ADMIN"]);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM auth_tokens WHERE profile_id=? AND purpose='INVITATION'",
      )
      .get(invitation.profileId).count,
    1,
  );
  const preview = await auth.route(
    "GET",
    new URL(`http://localhost/api/auth/invitation?token=${invitation.token}`),
    {},
    { method: "GET", headers: {} },
    response(),
    null,
  );
  assert.equal(preview.email, "first-admin@example.org");
  assert.throws(
    () =>
      createAdminInvitation(db, {
        email: "another-admin@example.org",
        displayName: "another-admin",
      }),
    /already been bootstrapped/,
  );

  await auth.route(
    "POST",
    new URL("http://localhost/api/auth/accept-invitation"),
    { token: invitation.token, password: "a-strong-password-123" },
    request(),
    response(),
  );
  assert.equal(
    db.prepare("SELECT account_status FROM profiles WHERE id=?").get(invitation.profileId)
      .account_status,
    "ACTIVE",
  );
  assert.equal(
    db.prepare("SELECT email_verified_at FROM profiles WHERE id=?").get(invitation.profileId)
      .email_verified_at !== null,
    true,
  );
  await assert.rejects(
    () =>
      auth.route(
        "GET",
        new URL(`http://localhost/api/auth/invitation?token=${invitation.token}`),
        {},
        { method: "GET", headers: {} },
        response(),
        null,
      ),
    /invalid or expired/,
  );
  db.close();
});

test("login rejects invalid credentials, establishes a cookie session, and logout revokes it", async () => {
  const { db, auth } = setup();
  const id = await bootstrapAdmin(db, {
    email: "admin@example.org",
    displayName: "Admin User",
    password: "a-strong-password-123",
  });
  const url = new URL("http://localhost/api/auth/login"),
    res = response();
  await assert.rejects(
    () =>
      auth.route(
        "POST",
        url,
        { email: "admin@example.org", password: "wrong-password" },
        request(),
        response(),
      ),
    /incorrect/,
  );
  const result = await auth.route(
    "POST",
    url,
    { email: "ADMIN@example.org", password: "a-strong-password-123" },
    request(),
    res,
  );
  assert.equal(result.user.id, id);
  assert.match(res.headers["Set-Cookie"], /HttpOnly/);
  assert.match(res.headers["Set-Cookie"], /SameSite=Strict/);
  const token = res.headers["Set-Cookie"].match(/rb_session=([^;]+)/)[1],
    user = auth.session({ headers: { cookie: `rb_session=${token}` } });
  assert.equal(user.id, id);
  assert.deepEqual(user.roles, ["ADMIN"]);
  const out = response();
  await auth.route(
    "POST",
    new URL("http://localhost/api/auth/logout"),
    {},
    request(`rb_session=${token}`),
    out,
    user,
  );
  assert.equal(auth.session({ headers: { cookie: `rb_session=${token}` } }), null);
  assert.match(out.headers["Set-Cookie"], /Max-Age=0/);
  db.close();
});

test("CSRF check accepts configured frontend origin through API proxy and rejects other origins", async () => {
  const { db, auth } = setup();
  await bootstrapAdmin(db, {
    email: "admin@example.org",
    displayName: "Admin User",
    password: "a-strong-password-123",
  });
  const loginUrl = new URL("http://localhost/api/auth/login");

  await assert.rejects(
    () =>
      auth.route(
        "POST",
        loginUrl,
        { email: "nobody@example.org", password: "not-a-password" },
        {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:5173",
            host: "127.0.0.1:8001",
          },
          socket: { remoteAddress: "127.0.0.1" },
        },
        response(),
      ),
    /incorrect/,
  );
  await assert.rejects(
    () =>
      auth.route(
        "POST",
        loginUrl,
        {},
        {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            host: "127.0.0.1:8001",
          },
        },
        response(),
      ),
    /Request origin is not allowed/,
  );
  db.close();
});

test("role checks deny unauthenticated and underprivileged requests; user cannot change own roles", async () => {
  const { db, auth } = setup();
  const adminId = await bootstrapAdmin(db, {
    email: "admin@example.org",
    displayName: "Admin User",
    password: "a-strong-password-123",
  });
  assert.throws(() => auth.requireRole(null, ["ADMIN"]), /Sign in/);
  assert.throws(
    () => auth.requireRole({ id: 9, roles: ["MEMBER"] }, ["TREASURER", "ADMIN"]),
    /permission/,
  );
  const user = { id: adminId, roles: ["ADMIN"] };
  await assert.rejects(
    () =>
      auth.route(
        "POST",
        new URL(`http://localhost/api/users/${adminId}/roles`),
        { role: "TREASURER" },
        request(),
        response(),
        user,
      ),
    /cannot change your own role/,
  );
  db.close();
});

test("Admin transfer atomically replaces the only Admin and is audited", async () => {
  const { db, auth } = setup();
  const adminId = await bootstrapAdmin(db, {
      email: "admin@example.org",
      displayName: "Admin User",
      password: "a-strong-password-123",
    }),
    stamp = new Date().toISOString();
  const targetId = Number(
    db
      .prepare(
        "INSERT INTO profiles(auth_user_id,display_name,email,account_status,email_verified_at,created_at,updated_at) VALUES('stable-user-2','Member','member@example.org','ACTIVE',?,?,?)",
      )
      .run(stamp, stamp, stamp).lastInsertRowid,
  );
  db.prepare("INSERT INTO role_assignments(profile_id,role,assigned_at) VALUES(?,'MEMBER',?)").run(
    targetId,
    stamp,
  );
  await auth.route(
    "POST",
    new URL("http://localhost/api/admin/transfer"),
    { target_profile_id: targetId },
    request(),
    response(),
    { id: adminId, roles: ["ADMIN"] },
  );
  assert.deepEqual(auth.roles(adminId), []);
  assert.deepEqual(auth.roles(targetId), ["ADMIN", "MEMBER"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM role_assignments WHERE role='ADMIN'").get().n, 1);
  assert.equal(
    db.prepare("SELECT action FROM auth_audit ORDER BY id DESC LIMIT 1").get().action,
    "admin_transferred",
  );
  db.close();
});

test("invitation acceptance verifies email and activates only the account, not membership", async () => {
  const { db, auth } = setup();
  db.prepare(
    "INSERT INTO members(id,name,status,created_at) VALUES(1,'Dormant Member','DORMANT',?)",
  ).run(new Date().toISOString());
  const stamp = new Date().toISOString(),
    memberId = Number(
      db
        .prepare(
          "INSERT INTO profiles(auth_user_id,member_id,display_name,email,account_status,created_at,updated_at) VALUES('invite-uid',1,'Dormant Member','dormant@example.org','INVITED',?,?)",
        )
        .run(stamp, stamp).lastInsertRowid,
    );
  db.prepare("INSERT INTO role_assignments(profile_id,role,assigned_at) VALUES(?,'MEMBER',?)").run(
    memberId,
    stamp,
  );
  const token = "one-time-invitation-secret",
    { createHash } = await import("node:crypto"),
    tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare(
    "INSERT INTO auth_tokens(profile_id,token_hash,purpose,expires_at,created_at) VALUES(?,?,'INVITATION',?,?)",
  ).run(memberId, tokenHash, new Date(Date.now() + 60000).toISOString(), stamp);
  const accepted = await auth.route(
    "POST",
    new URL("http://localhost/api/auth/accept-invitation"),
    { token, password: "member-strong-password-123" },
    request(),
    response(),
    null,
  );
  assert.equal(accepted.ok, true);
  const profile = db
    .prepare(
      "SELECT account_status,email_verified_at,password_hash,member_id FROM profiles WHERE id=?",
    )
    .get(memberId);
  assert.equal(profile.account_status, "ACTIVE");
  assert.ok(profile.email_verified_at);
  assert.equal(profile.member_id, 1);
  assert.match(profile.password_hash, /^scrypt\$/);
  assert.equal(db.prepare("SELECT status FROM members WHERE id=1").get().status, "DORMANT");
  await assert.rejects(
    () =>
      auth.route(
        "POST",
        new URL("http://localhost/api/auth/accept-invitation"),
        { token, password: "another-strong-password-123" },
        request(),
        response(),
        null,
      ),
    /invalid or has expired/,
  );
  db.close();
});
