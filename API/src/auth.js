import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { ROLES } from "../../shared/contracts.js";
import { createMailTransporter } from "./email.js";

const scrypt = promisify(scryptCb);
const SESSION_MS = 12 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const normalizeEmail = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function sessionCookie(token, maxAgeSeconds) {
  const production = process.env.NODE_ENV === "production";
  const sameSite = process.env.SESSION_COOKIE_SAME_SITE || (production ? "None" : "Strict");
  const secure = production || sameSite === "None";
  const secureFlag = secure ? "; Secure" : "";

  return `rb_session=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

export function initializeAuth(db, log) {
  if (db.kind !== "postgres") {
    db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY, auth_user_id TEXT NOT NULL UNIQUE, member_id INTEGER UNIQUE REFERENCES members(id),
      display_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT,
      account_status TEXT NOT NULL CHECK(account_status IN ('INVITED','ACTIVE','SUSPENDED')),
      email_verified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_assignments (
      profile_id INTEGER NOT NULL REFERENCES profiles(id), role TEXT NOT NULL CHECK(role IN ('MEMBER','TREASURER','CHAMA_COORDINATOR','ADMIN')),
      assigned_by INTEGER REFERENCES profiles(id), assigned_at TEXT NOT NULL, PRIMARY KEY(profile_id, role)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS exactly_one_admin_role ON role_assignments(role) WHERE role='ADMIN';
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL CHECK(purpose IN ('INVITATION','PASSWORD_RESET')),
      expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      key TEXT PRIMARY KEY, window_started_at TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_audit (
      id INTEGER PRIMARY KEY, actor_profile_id INTEGER REFERENCES profiles(id), target_profile_id INTEGER REFERENCES profiles(id),
      action TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_approvals (
      import_id INTEGER PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
      imported_by_profile_id INTEGER NOT NULL REFERENCES profiles(id),
      reviewed_by_profile_id INTEGER NOT NULL REFERENCES profiles(id),
      approved_by_profile_id INTEGER NOT NULL REFERENCES profiles(id),
      CHECK(reviewed_by_profile_id<>approved_by_profile_id)
    );
    CREATE TRIGGER IF NOT EXISTS block_second_active_admin BEFORE INSERT ON role_assignments
      WHEN NEW.role='ADMIN' AND EXISTS(SELECT 1 FROM role_assignments ra JOIN profiles p ON p.id=ra.profile_id WHERE ra.role='ADMIN' AND p.account_status='ACTIVE')
      BEGIN SELECT RAISE(ABORT,'An active Admin already exists'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_admin_suspension BEFORE UPDATE OF account_status ON profiles
      WHEN OLD.account_status='ACTIVE' AND NEW.account_status!='ACTIVE' AND EXISTS(SELECT 1 FROM role_assignments WHERE profile_id=OLD.id AND role='ADMIN')
      BEGIN SELECT RAISE(ABORT,'Transfer Admin role before suspending this account'); END;
    `);
    const approvalsSql =
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='import_approvals'")
        .get()?.sql || "";
    if (approvalsSql.includes("imported_by_profile_id<>"))
      db.transaction(() => {
        db.exec(
          `CREATE TABLE import_approvals_v2(import_id INTEGER PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,imported_by_profile_id INTEGER NOT NULL REFERENCES profiles(id),reviewed_by_profile_id INTEGER NOT NULL REFERENCES profiles(id),approved_by_profile_id INTEGER NOT NULL REFERENCES profiles(id),CHECK(reviewed_by_profile_id<>approved_by_profile_id));INSERT INTO import_approvals_v2 SELECT * FROM import_approvals;DROP TABLE import_approvals;ALTER TABLE import_approvals_v2 RENAME TO import_approvals;`,
        );
      })();
  }
  const transporter = () => {
    try {
      return createMailTransporter();
    } catch (error) {
      fail(503, error.message);
    }
  };
  const audit = db.prepare(
    "INSERT INTO auth_audit(actor_profile_id,target_profile_id,action,details_json,created_at) VALUES(?,?,?,?,?)",
  );
  const auditEvent = (actor, target, action, details = {}) => {
    audit.run(actor || null, target || null, action, JSON.stringify(details), now());
    log?.(`auth_${action}`, String(actor || "system"), "profile", target || null, details);
  };
  const roles = (id) =>
    db
      .prepare("SELECT role FROM role_assignments WHERE profile_id=? ORDER BY role")
      .all(id)
      .map((r) => r.role);
  const publicProfile = (id) => {
    const p = db
      .prepare(
        "SELECT id,auth_user_id,member_id,display_name,email,account_status,email_verified_at,created_at FROM profiles WHERE id=?",
      )
      .get(id);
    return p
      ? {
          ...p,
          roles: roles(id),
          member: p.member_id
            ? db.prepare("SELECT id,name,status FROM members WHERE id=?").get(p.member_id)
            : null,
        }
      : null;
  };
  const session = (req) => {
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("rb_session="))
      ?.slice(11);
    if (!cookie) return null;
    const s = db
      .prepare(
        "SELECT s.id session_id,s.profile_id,s.expires_at,p.account_status FROM auth_sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.token_hash=? AND s.revoked_at IS NULL",
      )
      .get(hash(cookie));
    if (!s || s.account_status !== "ACTIVE" || s.expires_at <= now()) return null;
    db.prepare("UPDATE auth_sessions SET expires_at=? WHERE id=?").run(
      new Date(Date.now() + SESSION_MS).toISOString(),
      s.session_id,
    );
    return { id: s.profile_id, roles: roles(s.profile_id), session_id: s.session_id };
  };
  const requireAuth = (user) => {
    if (!user) fail(401, "Sign in to continue.");
    return user;
  };
  const requireRole = (user, allowed) => {
    requireAuth(user);
    if (!allowed.some((r) => user.roles.includes(r)))
      fail(403, "You do not have permission to perform this action.");
  };
  const requireActiveMember = (user) => {
    requireAuth(user);
    const p = db
      .prepare(
        "SELECT p.member_id,m.status FROM profiles p LEFT JOIN members m ON m.id=p.member_id WHERE p.id=?",
      )
      .get(user.id);
    if (!p?.member_id || p.status !== "ACTIVE")
      fail(403, "An active linked member account is required.");
    return p;
  };
  const assertSameOrigin = (req) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;

    let requestOrigin;
    let appOrigin;
    try {
      requestOrigin = new URL(origin).origin;
      appOrigin = new URL(process.env.APP_BASE_URL || "http://127.0.0.1:5173").origin;
    } catch {
      fail(403, "Request origin is not allowed.");
    }

    const apiHost = req.headers.host;
    if (requestOrigin !== appOrigin && new URL(requestOrigin).host !== apiHost) {
      fail(403, "Request origin is not allowed.");
    }
  };
  async function route(method, url, p, req, res, user) {
    assertSameOrigin(req);
    if (method === "GET" && url.pathname === "/api/auth/session")
      return { user: user ? publicProfile(user.id) : null };
    if (method === "GET" && url.pathname === "/api/auth/invitation") {
      const token = String(url.searchParams.get("token") || "");
      const entry = db
        .prepare(
          "SELECT t.expires_at,t.used_at,p.email,p.account_status FROM auth_tokens t JOIN profiles p ON p.id=t.profile_id WHERE t.token_hash=? AND t.purpose='INVITATION'",
        )
        .get(hash(token));
      if (
        !entry ||
        entry.used_at ||
        entry.expires_at <= now() ||
        entry.account_status !== "INVITED"
      ) {
        fail(400, "This invitation link is invalid or expired. Ask an Admin for a new one.");
      }
      return { email: entry.email };
    }
    if (method === "POST" && url.pathname === "/api/auth/login") {
      const email = normalizeEmail(p.email),
        profile = db.prepare("SELECT * FROM profiles WHERE email=? COLLATE NOCASE").get(email);
      const rateKey = hash(`${req.socket?.remoteAddress || "unknown"}:${email}`),
        rate = db.prepare("SELECT * FROM auth_rate_limits WHERE key=?").get(rateKey),
        windowMs = 15 * 60 * 1000;
      if (rate && Date.now() - Date.parse(rate.window_started_at) < windowMs && rate.failures >= 10)
        fail(429, "Too many sign-in attempts. Try again later.");
      const candidate = profile?.password_hash || DUMMY_PASSWORD_HASH;
      const [, salt, stored] = candidate.split("$"),
        derived = await scrypt(String(p.password || ""), Buffer.from(salt, "hex"), 64),
        valid = timingSafeEqual(derived, Buffer.from(stored, "hex")) && Boolean(profile);
      if (!valid || profile.account_status !== "ACTIVE" || !profile.email_verified_at) {
        if (rate && Date.now() - Date.parse(rate.window_started_at) < windowMs)
          db.prepare("UPDATE auth_rate_limits SET failures=failures+1 WHERE key=?").run(rateKey);
        else
          db.prepare(
            "INSERT INTO auth_rate_limits(key,window_started_at,failures) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_started_at=excluded.window_started_at,failures=excluded.failures",
          ).run(rateKey, now());
        fail(401, "Email or password is incorrect, or the account is not active.");
      }
      db.prepare("DELETE FROM auth_rate_limits WHERE key=?").run(rateKey);
      const token = randomBytes(32).toString("base64url");
      db.prepare(
        "INSERT INTO auth_sessions(profile_id,token_hash,created_at,expires_at) VALUES(?,?,?,?)",
      ).run(profile.id, hash(token), now(), new Date(Date.now() + SESSION_MS).toISOString());
      res.setHeader("Set-Cookie", sessionCookie(token, SESSION_MS / 1000));
      auditEvent(profile.id, profile.id, "login");
      return { user: publicProfile(profile.id) };
    }
    if (method === "POST" && url.pathname === "/api/auth/logout") {
      const token = String(req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("rb_session="))
        ?.slice(11);
      if (token)
        db.prepare(
          "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
        ).run(now(), hash(token));
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      if (user) auditEvent(user.id, user.id, "logout");
      return { ok: true };
    }
    if (method === "POST" && url.pathname === "/api/auth/accept-invitation") {
      const token = String(p.token || ""),
        entry = db
          .prepare(
            "SELECT t.*,p.email FROM auth_tokens t JOIN profiles p ON p.id=t.profile_id WHERE t.token_hash=? AND t.purpose='INVITATION' AND t.used_at IS NULL",
          )
          .get(hash(token));
      if (!entry || entry.expires_at <= now())
        fail(400, "This invitation is invalid or has expired.");
      if (String(p.password || "").length < 12)
        fail(400, "Use a password with at least 12 characters.");
      const salt = randomBytes(16),
        derived = await scrypt(p.password, salt, 64),
        passwordHash = `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
      const run = db.transaction(() => {
        db.prepare(
          "UPDATE profiles SET password_hash=?,account_status='ACTIVE',email_verified_at=?,updated_at=? WHERE id=? AND account_status='INVITED'",
        ).run(passwordHash, now(), now(), entry.profile_id);
        db.prepare("UPDATE auth_tokens SET used_at=? WHERE id=?").run(now(), entry.id);
        auditEvent(entry.profile_id, entry.profile_id, "invitation_accepted");
      });
      run();
      return { ok: true };
    }
    if (method === "POST" && url.pathname === "/api/auth/password-reset/request") {
      const email = normalizeEmail(p.email),
        profile = db
          .prepare(
            "SELECT id FROM profiles WHERE email=? COLLATE NOCASE AND account_status='ACTIVE'",
          )
          .get(email);
      if (profile) {
        const token = randomBytes(32).toString("base64url"),
          expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        db.prepare(
          "INSERT INTO auth_tokens(profile_id,token_hash,purpose,expires_at,created_at) VALUES(?,?,'PASSWORD_RESET',?,?)",
        ).run(profile.id, hash(token), expires, now());
        try {
          const base = process.env.APP_BASE_URL || "http://127.0.0.1:5173";
          await transporter().sendMail({
            from: process.env.SMTP_FROM,
            to: email,
            subject: "Royal Barks password reset",
            text: `Reset your password within 30 minutes: ${base}/#reset-password?token=${encodeURIComponent(token)}`,
          });
          auditEvent(null, profile.id, "password_reset_requested");
        } catch {
          db.prepare("DELETE FROM auth_tokens WHERE token_hash=?").run(hash(token));
          console.error(
            "Password reset email delivery failed; SMTP configuration should be checked.",
          );
        }
      }
      return {
        ok: true,
        message: "If an active account matches that address, reset instructions will be sent.",
      };
    }
    if (method === "POST" && url.pathname === "/api/auth/password-reset/complete") {
      const entry = db
        .prepare(
          "SELECT * FROM auth_tokens WHERE token_hash=? AND purpose='PASSWORD_RESET' AND used_at IS NULL",
        )
        .get(hash(String(p.token || "")));
      if (!entry || entry.expires_at <= now())
        fail(400, "This password reset link is invalid or has expired.");
      if (String(p.password || "").length < 12)
        fail(400, "Use a password with at least 12 characters.");
      const salt = randomBytes(16),
        derived = await scrypt(p.password, salt, 64),
        passwordHash = `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
      db.transaction(() => {
        db.prepare("UPDATE profiles SET password_hash=?,updated_at=? WHERE id=?").run(
          passwordHash,
          now(),
          entry.profile_id,
        );
        db.prepare("UPDATE auth_tokens SET used_at=? WHERE id=?").run(now(), entry.id);
        db.prepare(
          "UPDATE auth_sessions SET revoked_at=? WHERE profile_id=? AND revoked_at IS NULL",
        ).run(now(), entry.profile_id);
        auditEvent(entry.profile_id, entry.profile_id, "password_reset_completed");
      })();
      return { ok: true };
    }
    if (method === "POST" && url.pathname === "/api/invitations") {
      requireRole(user, ["ADMIN"]);
      const email = normalizeEmail(p.email),
        name = String(p.display_name || "").trim(),
        role = String(p.role || "MEMBER"),
        memberId =
          p.member_id === null || p.member_id === "" || p.member_id === undefined
            ? null
            : Number(p.member_id);
      if (!validEmail(email) || !name || !ROLES.includes(role))
        fail(400, "Provide a valid email, display name, and role.");
      if (role === "ADMIN")
        fail(400, "Use the one-time bootstrap or audited Admin transfer to assign Admin.");
      if (memberId && !db.prepare("SELECT id FROM members WHERE id=?").get(memberId))
        fail(400, "Linked member record does not exist.");
      if (memberId && db.prepare("SELECT id FROM profiles WHERE member_id=?").get(memberId))
        fail(409, "This member already has a linked account.");
      if (db.prepare("SELECT id FROM profiles WHERE email=? COLLATE NOCASE").get(email))
        fail(409, "That email or member is already linked to an account.");
      const token = randomBytes(32).toString("base64url"),
        expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        base = process.env.APP_BASE_URL || "http://127.0.0.1:5173";
      const create = db.transaction(() => {
        const profileId = Number(
          db
            .prepare(
              "INSERT INTO profiles(auth_user_id,member_id,display_name,email,account_status,created_at,updated_at) VALUES(?,?,?,?, 'INVITED',?,?)",
            )
            .run(randomUUID(), memberId, name, email, now(), now()).lastInsertRowid,
        );
        db.prepare(
          "INSERT INTO role_assignments(profile_id,role,assigned_by,assigned_at) VALUES(?,?,?,?)",
        ).run(profileId, role, user.id, now());
        db.prepare(
          "INSERT INTO auth_tokens(profile_id,token_hash,purpose,expires_at,created_at) VALUES(?,?,'INVITATION',?,?)",
        ).run(profileId, hash(token), expires, now());
        return profileId;
      });
      const target = create();
      try {
        await transporter().sendMail({
          from: process.env.SMTP_FROM,
          to: email,
          subject: "You are invited to Royal Barks",
          text: `Hello ${name}, accept your invitation within seven days: ${base}/#accept-invitation?token=${encodeURIComponent(token)}`,
        });
      } catch (e) {
        db.transaction(() => {
          db.prepare("DELETE FROM profiles WHERE id=?").run(target);
        })();
        throw e;
      }
      auditEvent(user.id, target, "invitation_sent", { role, member_id: memberId });
      return { ok: true };
    }
    if (method === "GET" && url.pathname === "/api/profile")
      return publicProfile(requireAuth(user).id);
    if (method === "GET" && url.pathname === "/api/users") {
      requireRole(user, ["ADMIN"]);
      return db
        .prepare(
          "SELECT id,auth_user_id,member_id,display_name,email,account_status,email_verified_at,created_at,updated_at FROM profiles ORDER BY display_name COLLATE NOCASE",
        )
        .all()
        .map((x) => ({ ...x, roles: roles(x.id) }));
    }
    const linkMatch = url.pathname.match(/^\/api\/users\/(\d+)\/member-link$/);
    if (method === "POST" && linkMatch) {
      requireRole(user, ["ADMIN"]);
      const targetId = Number(linkMatch[1]);
      if (targetId === user.id) fail(403, "You cannot change your own member link.");
      const target = db.prepare("SELECT id,member_id FROM profiles WHERE id=?").get(targetId);
      if (!target) fail(404, "Account not found.");
      const memberId = p.member_id === null || p.member_id === "" ? null : Number(p.member_id);
      if (memberId !== null && !db.prepare("SELECT id FROM members WHERE id=?").get(memberId))
        fail(400, "Member record does not exist.");
      if (
        memberId &&
        db.prepare("SELECT id FROM profiles WHERE member_id=? AND id<>?").get(memberId, targetId)
      )
        fail(409, "That member already has a linked account.");
      db.prepare("UPDATE profiles SET member_id=?,updated_at=? WHERE id=?").run(
        memberId,
        now(),
        targetId,
      );
      auditEvent(user.id, targetId, "member_link_changed", {
        previous_member_id: target.member_id,
        new_member_id: memberId,
      });
      return { ok: true, member_id: memberId };
    }
    const userMatch = url.pathname.match(/^\/api\/users\/(\d+)\/(suspend|reactivate|roles)$/);
    if (method === "POST" && userMatch) {
      requireRole(user, ["ADMIN"]);
      const targetId = Number(userMatch[1]),
        target = db.prepare("SELECT * FROM profiles WHERE id=?").get(targetId);
      if (!target) fail(404, "Account not found.");
      if (userMatch[2] === "suspend" || userMatch[2] === "reactivate") {
        const status = userMatch[2] === "suspend" ? "SUSPENDED" : "ACTIVE";
        if (target.account_status === status) fail(409, "Account already has that status.");
        try {
          db.prepare("UPDATE profiles SET account_status=?,updated_at=? WHERE id=?").run(
            status,
            now(),
            targetId,
          );
        } catch (e) {
          if (String(e.message).includes("Transfer Admin"))
            fail(409, "Transfer Admin role before suspending this account.");
          throw e;
        }
        if (status === "SUSPENDED")
          db.prepare(
            "UPDATE auth_sessions SET revoked_at=? WHERE profile_id=? AND revoked_at IS NULL",
          ).run(now(), targetId);
        auditEvent(
          user.id,
          targetId,
          status === "SUSPENDED" ? "account_suspended" : "account_reactivated",
        );
        return { ok: true, account_status: status };
      }
      if (targetId === user.id) fail(403, "You cannot change your own role or account access.");
      const next = String(p.role || "");
      if (!ROLES.includes(next) || next === "ADMIN")
        fail(400, "Invalid role. Admin uses the audited transfer workflow.");
      db.transaction(() => {
        if (p.remove === true) {
          db.prepare("DELETE FROM role_assignments WHERE profile_id=? AND role=?").run(
            targetId,
            next,
          );
        } else {
          db.prepare(
            "INSERT OR IGNORE INTO role_assignments(profile_id,role,assigned_by,assigned_at) VALUES(?,?,?,?)",
          ).run(targetId, next, user.id, now());
        }
        auditEvent(user.id, targetId, "role_changed", { role: next, removed: p.remove === true });
      })();
      return { ok: true, roles: roles(targetId) };
    }
    if (method === "POST" && url.pathname === "/api/admin/transfer") {
      requireRole(user, ["ADMIN"]);
      const targetId = Number(p.target_profile_id),
        target = db
          .prepare(
            "SELECT * FROM profiles WHERE id=? AND account_status='ACTIVE' AND email_verified_at IS NOT NULL",
          )
          .get(targetId);
      if (!target || targetId === user.id)
        fail(400, "Choose another active, email-verified account for Admin transfer.");
      db.transaction(() => {
        db.prepare("DELETE FROM role_assignments WHERE profile_id=? AND role='ADMIN'").run(user.id);
        db.prepare(
          "INSERT INTO role_assignments(profile_id,role,assigned_by,assigned_at) VALUES(?,'ADMIN',?,?)",
        ).run(targetId, user.id, now());
        db.prepare(
          "UPDATE auth_sessions SET revoked_at=? WHERE profile_id=? AND revoked_at IS NULL",
        ).run(now(), user.id);
        auditEvent(user.id, targetId, "admin_transferred", {
          from_profile_id: user.id,
          to_profile_id: targetId,
        });
      })();
      return { ok: true };
    }
    if (method === "GET" && url.pathname === "/api/auth/audit") {
      requireRole(user, ["ADMIN"]);
      return db
        .prepare(
          "SELECT id,actor_profile_id,target_profile_id,action,details_json,created_at FROM auth_audit ORDER BY id DESC LIMIT 200",
        )
        .all()
        .map((x) => ({ ...x, details: JSON.parse(x.details_json) }));
    }
    return null;
  }
  return { route, session, requireAuth, requireRole, requireActiveMember, roles };
}

export async function bootstrapAdmin(db, { email, displayName, memberId, password }) {
  email = normalizeEmail(email);
  if (!validEmail(email) || !displayName || String(password || "").length < 12)
    throw new Error(
      "Bootstrap requires a valid email, display name, and password of at least 12 characters.",
    );
  if (db.prepare("SELECT 1 FROM role_assignments WHERE role='ADMIN'").get())
    throw new Error("An Admin has already been bootstrapped.");
  if (memberId && !db.prepare("SELECT id FROM members WHERE id=?").get(memberId))
    throw new Error("Member ID does not exist.");
  if (
    db
      .prepare("SELECT 1 FROM profiles WHERE email=? COLLATE NOCASE OR member_id=?")
      .get(email, memberId || null)
  )
    throw new Error("Email or member is already linked.");
  const salt = randomBytes(16),
    derived = await scrypt(password, salt, 64),
    passwordHash = `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`,
    stamp = now();
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          "INSERT INTO profiles(auth_user_id,member_id,display_name,email,password_hash,account_status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,?,?)",
        )
        .run(randomUUID(), memberId || null, displayName, email, passwordHash, stamp, stamp, stamp)
        .lastInsertRowid,
    );
    db.prepare("INSERT INTO role_assignments(profile_id,role,assigned_at) VALUES(?,'ADMIN',?)").run(
      id,
      stamp,
    );
    db.prepare(
      "INSERT INTO auth_audit(actor_profile_id,target_profile_id,action,details_json,created_at) VALUES(?,?, 'admin_bootstrapped','{}',?)",
    ).run(id, id, stamp);
    return id;
  })();
}

export function createAdminInvitation(db, { email, displayName }) {
  email = normalizeEmail(email);
  if (!validEmail(email) || !String(displayName || "").trim()) {
    throw new Error("Admin invitation requires a valid email and display name.");
  }
  if (db.prepare("SELECT 1 FROM role_assignments WHERE role='ADMIN'").get()) {
    throw new Error("An Admin has already been bootstrapped.");
  }
  if (db.prepare("SELECT 1 FROM profiles WHERE email=? COLLATE NOCASE").get(email)) {
    throw new Error("This email is already linked to an account.");
  }

  const token = randomBytes(32).toString("base64url");
  const stamp = now();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const create = db.transaction(() => {
    const profileId = Number(
      db
        .prepare(
          "INSERT INTO profiles(auth_user_id,display_name,email,account_status,created_at,updated_at) VALUES(?,?,?,'INVITED',?,?)",
        )
        .run(randomUUID(), String(displayName).trim(), email, stamp, stamp).lastInsertRowid,
    );
    db.prepare("INSERT INTO role_assignments(profile_id,role,assigned_at) VALUES(?,'ADMIN',?)").run(
      profileId,
      stamp,
    );
    db.prepare(
      "INSERT INTO auth_tokens(profile_id,token_hash,purpose,expires_at,created_at) VALUES(?,?,'INVITATION',?,?)",
    ).run(profileId, hash(token), expires, stamp);
    db.prepare(
      "INSERT INTO auth_audit(actor_profile_id,target_profile_id,action,details_json,created_at) VALUES(NULL,?,'admin_invitation_created',?,?)",
    ).run(profileId, JSON.stringify({ email }), stamp);
    return profileId;
  });

  return { profileId: create(), token, email, displayName: String(displayName).trim() };
}
