import http from "node:http";
import { createDatabase } from "./database.js";
import { initializeAuth } from "./auth.js";
import { initializeChama } from "./modules/chama.js";
import { createFinanceQueries } from "./modules/financeQueries.js";
import { createImportService, REFERENCE } from "./modules/imports.js";
import { MEMBERSHIP_STATUSES } from "../../shared/contracts.js";

const db = createDatabase();

const STATUSES = MEMBERSHIP_STATUSES;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const dateOnly = (d) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
const audit = db.prepare(
  "INSERT INTO audit_log(event,actor,entity,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)",
);
function log(event, actor, entity, id, details) {
  audit.run(event, actor, entity, id, JSON.stringify(details), now());
}
const auth = initializeAuth(db, log);
const chama = initializeChama(db, {
  statusOn,
  requireRole: auth.requireRole,
  requireActiveMember: auth.requireActiveMember,
  session: auth.session,
  log,
});
function statusOn(memberId, onDate) {
  return (
    db
      .prepare(
        "SELECT new_status FROM status_history WHERE member_id=? AND effective_date<=? ORDER BY effective_date DESC,id DESC LIMIT 1",
      )
      .get(memberId, onDate)?.new_status || "STATUS TO CONFIRM"
  );
}
const financeQueries = createFinanceQueries(db, {
  statuses: STATUSES,
  reference: REFERENCE,
  statusOn,
});
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(400, `${label} is required.`);
  return value.trim();
}
function validDate(value, label = "Date") {
  if (!dateOnly(value)) fail(400, `${label} must be a valid ISO date.`);
  return value;
}
function validStatus(value) {
  if (!STATUSES.includes(value)) fail(400, "Choose a valid member status.");
  return value;
}
const importService = createImportService({ db, now, required, validDate, money, log, fail });

async function route(method, url, p, req, res, user) {
  const path = url.pathname;
  const authResult = await auth.route(method, url, p, req, res, user);
  if (authResult !== null) return authResult;
  if (method === "GET" && path === "/api/health") return { status: "ok" };
  auth.requireAuth(user);
  const chamaResult = await chama.route(method, url, p, req, res, user);
  if (chamaResult !== null) return chamaResult;
  const actorName =
    db.prepare("SELECT display_name FROM profiles WHERE id=?").get(user.id)?.display_name ||
    "Authenticated official";
  if (
    path === "/api/users" ||
    path === "/api/auth/audit" ||
    path === "/api/audit" ||
    (path === "/api/members" && method === "POST") ||
    /^\/api\/members\/\d+\/status(?:-preview)?$/.test(path)
  )
    auth.requireRole(user, ["ADMIN"]);
  if (
    path === "/api/imports" &&
    method === "GET" &&
    !user.roles.some((r) => ["TREASURER", "ADMIN"].includes(r))
  )
    return [];
  if (
    (path === "/api/imports/preview" && method === "POST") ||
    (path === "/api/imports" && method === "POST")
  )
    auth.requireRole(user, ["TREASURER", "ADMIN"]);
  if (
    path === "/api/payments" ||
    path === "/api/obligations" ||
    path === "/api/obligations/monthly"
  )
    auth.requireRole(user, ["TREASURER", "ADMIN"]);
  if (path === "/api/meetings" && method === "POST")
    auth.requireRole(user, ["TREASURER", "CHAMA_COORDINATOR", "ADMIN"]);
  if (path === "/api/import-officials") auth.requireRole(user, ["TREASURER", "ADMIN"]);
  if (
    path === "/api/report" &&
    !user.roles.some((r) => ["TREASURER", "ADMIN", "MEMBER"].includes(r))
  )
    fail(403, "You do not have permission to view financial reports.");
  if (
    path === "/api/report" &&
    user.roles.includes("MEMBER") &&
    !user.roles.some((r) => ["TREASURER", "ADMIN"].includes(r))
  )
    auth.requireActiveMember(user);
  if (method === "GET" && path === "/api/dashboard") {
    const d = financeQueries.dashboard();
    if (!user.roles.some((r) => ["TREASURER", "ADMIN"].includes(r)))
      return {
        members: d.members,
        new_paid: null,
        new_obligations: null,
        opening_arrears: null,
        reference: null,
      };
    return d;
  }
  if (method === "GET" && path === "/api/members") {
    const financial = user.roles.some((r) => ["TREASURER", "ADMIN"].includes(r)),
      coordinator = user.roles.includes("CHAMA_COORDINATOR"),
      memberId = db.prepare("SELECT member_id FROM profiles WHERE id=?").get(user.id)?.member_id;
    let list;
    if (financial) list = db.prepare("SELECT * FROM members ORDER BY name COLLATE NOCASE").all();
    else if (coordinator)
      list = db
        .prepare("SELECT * FROM members WHERE status='ACTIVE' ORDER BY name COLLATE NOCASE")
        .all();
    else list = memberId ? db.prepare("SELECT * FROM members WHERE id=?").all(memberId) : [];
    return list.map((m) => {
      const summary = financeQueries.memberSummary(m);
      return financial || m.id === memberId
        ? summary
        : { id: m.id, name: m.name, status: m.status, categories: {}, status_history: [] };
    });
  }
  let match = path.match(/^\/api\/members\/(\d+)\/status-preview$/);
  if (method === "GET" && match) {
    auth.requireRole(user, ["ADMIN"]);
    const id = Number(match[1]),
      member = db.prepare("SELECT * FROM members WHERE id=?").get(id);
    if (!member) fail(404, "Member not found.");
    const effective = validDate(url.searchParams.get("effective_date"), "Effective date"),
      proposed = validStatus(url.searchParams.get("new_status"));
    const future = db
      .prepare(
        "SELECT COUNT(*) n,COALESCE(SUM(amount),0) total FROM obligations WHERE member_id=? AND category IN ('monthly','meeting') AND obligation_date>=?",
      )
      .get(id, effective);
    const arrears = db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) n FROM opening_balances WHERE member_id=? AND balance_type='opening_arrears'",
      )
      .get(id).n;
    return {
      current_status_on_date: statusOn(id, effective),
      proposed_status: proposed,
      effective_date: effective,
      opening_arrears: arrears,
      existing_future_obligations: future.n,
      existing_future_obligation_amount: money(future.total),
      historical_balances_preserved: true,
      dormant_period_charges_generated: false,
    };
  }
  if (method === "POST" && path === "/api/members") {
    auth.requireRole(user, ["ADMIN"]);
    const name = required(p.name, "Member name"),
      status = validStatus(p.status || "STATUS TO CONFIRM"),
      effective = validDate(p.effective_date, "Effective date"),
      reason = required(p.reason, "Reason"),
      official = db
        .prepare("SELECT display_name FROM profiles WHERE id=?")
        .get(user.id).display_name;
    if (status !== "STATUS TO CONFIRM" && p.confirmed !== true)
      fail(400, "Confirm the initial active or dormant status before saving.");
    try {
      const id = Number(
        db
          .prepare("INSERT INTO members(name,status,created_at) VALUES(?,?,?)")
          .run(name, status, now()).lastInsertRowid,
      );
      db.prepare(
        "INSERT INTO status_history(member_id,previous_status,new_status,effective_date,reason,official,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id, "NONE", status, effective, reason, official, now());
      db.prepare("UPDATE members SET status=? WHERE id=?").run(
        statusOn(id, new Date().toISOString().slice(0, 10)),
        id,
      );
      log("member_created", official, "member", id, { name, status });
      return { id };
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
        fail(409, "A member with this name already exists.");
      throw e;
    }
  }
  match = path.match(/^\/api\/members\/(\d+)\/status$/);
  if (method === "POST" && match) {
    auth.requireRole(user, ["ADMIN"]);
    const id = Number(match[1]),
      m = db.prepare("SELECT id FROM members WHERE id=?").get(id);
    if (!m) fail(404, "Member not found.");
    const status = validStatus(p.new_status),
      effective = validDate(p.effective_date, "Effective date"),
      reason = required(p.reason, "Reason"),
      official = db
        .prepare("SELECT display_name FROM profiles WHERE id=?")
        .get(user.id).display_name;
    if (p.confirmed !== true)
      fail(400, "Confirm the status change after reviewing its financial impact.");
    const previous = statusOn(id, effective);
    db.prepare(
      "INSERT INTO status_history(member_id,previous_status,new_status,effective_date,reason,official,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(id, previous, status, effective, reason, official, now());
    db.prepare("UPDATE members SET status=? WHERE id=?").run(
      statusOn(id, new Date().toISOString().slice(0, 10)),
      id,
    );
    log("member_status_changed", official, "member", id, {
      previous,
      new: status,
      effective_date: effective,
      reason,
    });
    return { ok: true };
  }
  if (method === "POST" && path === "/api/obligations/monthly") {
    const month = String(p.month || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(400, "Choose a valid month.");
    const amount = Number(p.amount),
      official = actorName;
    if (!(amount > 0 && Number.isFinite(amount))) fail(400, "Amount must be greater than zero.");
    const day = `${month}-01`;
    let created = 0;
    const run = db.transaction(() => {
      for (const m of db.prepare("SELECT id FROM members").all()) {
        if (statusOn(m.id, day) !== "ACTIVE") continue;
        created += db
          .prepare(
            "INSERT OR IGNORE INTO obligations(member_id,category,amount,obligation_date,note,source_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            m.id,
            "monthly",
            amount,
            day,
            month,
            `monthly:${m.id}:${month}`,
            official,
            now(),
          ).changes;
      }
      log("monthly_obligations_generated", official, "monthly_batch", null, {
        month,
        amount,
        created,
      });
    });
    run();
    return { created, month };
  }
  if (method === "POST" && path === "/api/obligations") {
    const memberId = Number(p.member_id),
      category = p.category,
      amount = Number(p.amount),
      day = validDate(p.obligation_date, "Obligation date"),
      official = actorName;
    if (!db.prepare("SELECT id FROM members WHERE id=?").get(memberId))
      fail(404, "Member not found.");
    if (!["monthly", "meeting", "penalty", "food", "other"].includes(category))
      fail(400, "Choose a valid obligation category.");
    if (!(amount > 0 && Number.isFinite(amount))) fail(400, "Amount must be greater than zero.");
    if (category === "food" && p.food_rule_confirmed !== true)
      fail(400, "Confirm the approved food eligibility rule before recording a food obligation.");
    if (category === "meeting" && amount !== 500)
      fail(400, "The meeting contribution is fixed at KSh 500.");
    if (["monthly", "meeting"].includes(category) && statusOn(memberId, day) !== "ACTIVE")
      fail(
        400,
        "Monthly and KSh 500 obligations can only be recorded for an active member on that date.",
      );
    try {
      const id = Number(
        db
          .prepare(
            "INSERT INTO obligations(member_id,category,amount,obligation_date,note,source_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(memberId, category, amount, day, p.note || "", p.source_key || null, official, now())
          .lastInsertRowid,
      );
      log("obligation_recorded", official, "obligation", id, { category, amount });
      return { id };
    } catch (e) {
      if (e.code?.startsWith("SQLITE_CONSTRAINT")) fail(409, "Duplicate financial entry.");
      throw e;
    }
  }
  if (method === "POST" && path === "/api/payments") {
    const memberId = Number(p.member_id),
      category = p.category,
      amount = Number(p.amount),
      day = validDate(p.transaction_date, "Payment date"),
      official = actorName;
    if (!db.prepare("SELECT id FROM members WHERE id=?").get(memberId))
      fail(404, "Member not found.");
    if (!["monthly", "meeting", "penalty", "savings_500", "food", "other"].includes(category))
      fail(400, "Choose a valid payment category.");
    if (!(amount > 0 && Number.isFinite(amount))) fail(400, "Amount must be greater than zero.");
    try {
      const id = Number(
        db
          .prepare(
            "INSERT INTO transactions(member_id,category,amount,transaction_date,note,source_key,recorded_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(memberId, category, amount, day, p.note || "", p.source_key || null, official, now())
          .lastInsertRowid,
      );
      log("payment_recorded", official, "transaction", id, { category, amount });
      return { id };
    } catch (e) {
      if (e.code?.startsWith("SQLITE_CONSTRAINT")) fail(409, "Duplicate financial entry.");
      throw e;
    }
  }
  if (method === "POST" && path === "/api/meetings") {
    const day = validDate(p.meeting_date, "Meeting date"),
      official = actorName,
      contribution = Number(p.contribution ?? 500);
    if (contribution !== 500) fail(400, "The meeting contribution is fixed at KSh 500.");
    const run = db.transaction(() => {
      const id = Number(
        db
          .prepare("INSERT INTO meetings(meeting_date,title,created_by,created_at) VALUES(?,?,?,?)")
          .run(day, p.title || "Member meeting", official, now()).lastInsertRowid,
      );
      let created = 0;
      for (const m of db.prepare("SELECT id FROM members").all()) {
        db.prepare(
          "INSERT OR IGNORE INTO attendance(meeting_id,member_id,attended) VALUES(?,?,?)",
        ).run(id, m.id, p.attendance?.[m.id] ? 1 : 0);
        if (statusOn(m.id, day) === "ACTIVE") {
          created += db
            .prepare(
              "INSERT OR IGNORE INTO obligations(member_id,category,amount,obligation_date,note,source_key,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              m.id,
              "meeting",
              500,
              day,
              p.title || "Member meeting",
              `meeting:${id}:member:${m.id}`,
              official,
              now(),
            ).changes;
        }
      }
      log("meeting_created", official, "meeting", id, {
        date: day,
        contribution_obligations: created,
      });
      return { id, contribution_obligations: created };
    });
    try {
      return run();
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
        fail(409, "A meeting is already recorded for this date.");
      throw e;
    }
  }
  if (method === "GET" && path === "/api/meetings")
    return db
      .prepare("SELECT * FROM meetings ORDER BY meeting_date DESC")
      .all()
      .map((m) => {
        const allAttendance = db
            .prepare(
              "SELECT a.member_id,m.name,a.attended FROM attendance a JOIN members m ON m.id=a.member_id WHERE meeting_id=? ORDER BY m.name COLLATE NOCASE",
            )
            .all(m.id),
          privileged = user.roles.some((r) =>
            ["TREASURER", "ADMIN", "CHAMA_COORDINATOR"].includes(r),
          ),
          memberId = db
            .prepare("SELECT member_id FROM profiles WHERE id=?")
            .get(user.id)?.member_id;
        return {
          ...m,
          attendance: privileged
            ? allAttendance
            : allAttendance.filter((a) => a.member_id === memberId),
          attendance_count: allAttendance.filter((a) => a.attended).length,
        };
      });
  if (method === "GET" && path === "/api/ledger") {
    let rows = db
      .prepare(
        "SELECT * FROM (SELECT 'obligation' kind,o.id,o.member_id,m.name,o.category,o.amount,o.obligation_date record_date,o.created_by actor,o.note FROM obligations o JOIN members m ON m.id=o.member_id UNION ALL SELECT 'payment' kind,t.id,t.member_id,m.name,t.category,t.amount,t.transaction_date record_date,t.recorded_by actor,t.note FROM transactions t JOIN members m ON m.id=t.member_id) ledger_entries ORDER BY record_date DESC, id DESC",
      )
      .all();
    if (!user.roles.some((r) => ["TREASURER", "ADMIN"].includes(r))) {
      const memberId = db
        .prepare("SELECT member_id FROM profiles WHERE id=?")
        .get(user.id)?.member_id;
      if (!user.roles.includes("MEMBER") || !memberId) return [];
      rows = rows.filter((x) => x.member_id === memberId);
    }
    return rows;
  }
  if (method === "GET" && path === "/api/report") {
    const asOf = validDate(url.searchParams.get("as_of"), "Report date");
    const memberOnly =
      user.roles.includes("MEMBER") &&
      !user.roles.some((role) => ["TREASURER", "ADMIN"].includes(role));
    const memberId = memberOnly
      ? db.prepare("SELECT member_id FROM profiles WHERE id=?").get(user.id)?.member_id
      : null;

    return financeQueries.report(asOf, memberId, memberOnly);
  }
  if (method === "GET" && path === "/api/audit")
    return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100").all();
  if (method === "GET" && path === "/api/import-officials")
    return db
      .prepare(
        "SELECT p.id,p.display_name,p.email FROM profiles p JOIN role_assignments r ON r.profile_id=p.id WHERE p.account_status='ACTIVE' AND r.role IN ('TREASURER','ADMIN') ORDER BY p.display_name COLLATE NOCASE",
      )
      .all();
  if (method === "POST" && (path === "/api/imports/preview" || path === "/api/imports")) {
    const lookup = db.prepare(
        "SELECT p.id,p.display_name FROM profiles p WHERE p.id=? AND p.account_status='ACTIVE' AND EXISTS(SELECT 1 FROM role_assignments r WHERE r.profile_id=p.id AND r.role IN ('TREASURER','ADMIN'))",
      ),
      byName = db.prepare(
        "SELECT p.id,p.display_name FROM profiles p WHERE p.display_name=? COLLATE NOCASE AND p.account_status='ACTIVE' AND EXISTS(SELECT 1 FROM role_assignments r WHERE r.profile_id=p.id AND r.role IN ('TREASURER','ADMIN'))",
      );
    const reviewer = p.reviewed_by_profile_id
        ? lookup.get(Number(p.reviewed_by_profile_id))
        : byName.get(String(p.reviewed_by || "")),
      approver = p.approved_by_profile_id
        ? lookup.get(Number(p.approved_by_profile_id))
        : byName.get(String(p.approved_by || ""));
    if (!reviewer || !approver || reviewer.id === approver.id)
      fail(400, "Reviewer and approver must be different active Treasurer/Admin accounts.");
    p = {
      ...p,
      imported_by: actorName,
      reviewed_by: reviewer.display_name,
      approved_by: approver.display_name,
      imported_by_profile_id: user.id,
      reviewed_by_profile_id: reviewer.id,
      approved_by_profile_id: approver.id,
    };
    if (path === "/api/imports/preview") {
      const x = importService.preview(p);
      return {
        fingerprint: x.fingerprint,
        duplicate: x.duplicate,
        reference: REFERENCE,
        reconciliation: x.reconciliation,
        supplemental: x.supplemental,
        rows: x.rows,
        reviewed_by: x.reviewedBy,
        approved_by: x.approvedBy,
      };
    }
    return importService.post(p);
  }
  if (method === "GET" && path === "/api/imports")
    return db
      .prepare("SELECT * FROM imports ORDER BY id DESC")
      .all()
      .map((x) => ({
        ...x,
        reconciliation: JSON.parse(x.reconciliation_json || "[]"),
        supplemental: JSON.parse(x.supplemental_json || "{}"),
        approvals:
          db
            .prepare(
              "SELECT ia.imported_by_profile_id,ia.reviewed_by_profile_id,ia.approved_by_profile_id FROM import_approvals ia WHERE import_id=?",
            )
            .get(x.id) || null,
        rows: db
          .prepare("SELECT * FROM import_rows WHERE import_id=? ORDER BY member_name")
          .all(x.id)
          .map((r) => ({
            ...r,
            amounts: JSON.parse(r.amounts_json),
            issues: JSON.parse(r.issues_json),
          })),
      }));
  fail(404, "Not found.");
}

const server = http.createServer(async (req, res) => {
  const allowedOrigins = [
    process.env.APP_BASE_URL || "http://127.0.0.1:5173",
    ...(process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()),
  ];
  const requestOrigin = req.headers.origin;

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  try {
    let body = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 5_000_000) fail(413, "Request body is too large.");
      }
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        fail(400, "Request body must be valid JSON.");
      }
    }
    const url = new URL(req.url, "http://127.0.0.1:8000"),
      user = auth.session(req),
      result = await route(req.method, url, body, req, res, user);
    if (result?.streaming) return;
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (e) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(e.status || 400);
    res.end(JSON.stringify({ detail: e.message || "Request failed." }));
  }
});
const port = Number(process.env.PORT || 8001);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
server.listen(port, host, () => console.log(`Royal Barks API running at http://${host}:${port}`));
process.on("SIGINT", () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
process.on("SIGTERM", () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
