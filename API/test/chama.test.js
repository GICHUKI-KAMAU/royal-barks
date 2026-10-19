import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initializeAuth, bootstrapAdmin } from "../src/auth.js";
import { initializeChama } from "../src/modules/chama.js";

const stamp = () => new Date().toISOString();
function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    `CREATE TABLE members(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,status TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE audit_log(id INTEGER PRIMARY KEY,event TEXT,actor TEXT,entity TEXT,entity_id INTEGER,details_json TEXT,created_at TEXT);CREATE TABLE imports(id INTEGER PRIMARY KEY,fingerprint TEXT,statement_date TEXT,source TEXT,imported_by TEXT,reviewed_by TEXT,approved_by TEXT,status TEXT,reference_json TEXT,reconciliation_json TEXT,created_at TEXT);`,
  );
  const time = stamp();
  for (const [id, name, status] of [
    [1, "Picker Member", "ACTIVE"],
    [2, "Active Observer", "ACTIVE"],
    [3, "Dormant Member", "DORMANT"],
  ])
    db.prepare("INSERT INTO members(id,name,status,created_at) VALUES(?,?,?,?)").run(
      id,
      name,
      status,
      time,
    );
  const auth = initializeAuth(db, () => {});
  const statusOn = (id) =>
    db.prepare("SELECT status FROM members WHERE id=?").get(id)?.status || "STATUS TO CONFIRM";
  const chama = initializeChama(db, {
    statusOn,
    requireRole: auth.requireRole,
    requireActiveMember: auth.requireActiveMember,
    session: auth.session,
    log: () => {},
  });
  return { db, auth, chama };
}
const req = { method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
  res = { setHeader() {} };
const call = (chama, method, path, p, user) =>
  chama.route(method, new URL(`http://localhost${path}`), p, req, res, user);

test("Chama freezes opt-in, shuffles face-down cards, reveals picks, and publishes payout order", async () => {
  const { db, chama } = setup(),
    stampNow = stamp(),
    coordinatorId = await bootstrapAdmin(db, {
      email: "admin@chama.org",
      displayName: "Cycle Admin",
      password: "a-secure-password-123",
    }),
    coordinator = { id: coordinatorId, roles: ["ADMIN"] },
    addUser = (memberId, name, email, roles) => {
      const id = Number(
        db
          .prepare(
            "INSERT INTO profiles(auth_user_id,member_id,display_name,email,account_status,email_verified_at,created_at,updated_at) VALUES(?,?,?,?, 'ACTIVE',?,?,?)",
          )
          .run(`uid-${memberId}`, memberId, name, email, stampNow, stampNow, stampNow)
          .lastInsertRowid,
      );
      for (const role of roles)
        db.prepare("INSERT INTO role_assignments(profile_id,role,assigned_at) VALUES(?,?,?)").run(
          id,
          role,
          stampNow,
        );
      return { id, roles };
    };
  const picker = addUser(1, "Picker Member", "picker@chama.org", ["MEMBER"]),
    observer = addUser(2, "Active Observer", "observer@chama.org", ["MEMBER"]),
    dormant = addUser(3, "Dormant Member", "dormant@chama.org", ["MEMBER"]);
  const created = await call(
      chama,
      "POST",
      "/api/chama/cycles",
      {
        name: "Spring Circle",
        description: "Monthly merry-go-round",
        expected_start_date: "2027-01-01",
        expected_end_date: "2027-10-31",
        first_payout_date: "2027-01-15",
        opt_in_deadline: "2026-12-15",
        min_seats: 1,
        max_seats: 10,
        duration_months: 10,
      },
      coordinator,
    ),
    id = created.id;
  await assert.rejects(
    () =>
      call(
        chama,
        "POST",
        `/api/chama/cycles/${id}/transition`,
        { to_state: "OPT_IN_OPEN", reason: "Open cycle" },
        coordinator,
      ),
    /positive monthly contribution/,
  );
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/transition`,
    { to_state: "OPT_IN_OPEN", monthly_amount_per_seat: 5000, reason: "Approved rate" },
    coordinator,
  );
  await assert.rejects(
    () =>
      call(chama, "POST", `/api/chama/cycles/${id}/opt-in`, { seats: 1, confirmed: true }, dormant),
    /active linked member/,
  );
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/opt-in`,
    { seats: 10, confirmed: true },
    picker,
  );
  const privateCycle = await call(chama, "GET", `/api/chama/cycles/${id}`, {}, observer);
  assert.equal(privateCycle.participants, undefined);
  assert.equal(privateCycle.own_registration, null);
  const own = await call(chama, "GET", `/api/chama/cycles/${id}`, {}, picker);
  assert.equal(own.own_registration.requested_seats, 10);
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/transition`,
    { to_state: "OPT_IN_CLOSED", reason: "Deadline reached" },
    coordinator,
  );
  const closed = await call(chama, "GET", `/api/chama/cycles/${id}`, {}, observer);
  assert.equal(closed.participants.length, 1);
  assert.equal(closed.participants[0].seats, 10);
  await assert.rejects(
    () =>
      call(chama, "POST", `/api/chama/cycles/${id}/opt-in`, { seats: 1, confirmed: true }, picker),
    /not open/,
  );
  await assert.rejects(
    () => call(chama, "GET", `/api/chama/cycles/${id}/board`, {}, dormant),
    /Active membership/,
  );
  await assert.rejects(
    () => call(chama, "GET", `/api/chama/cycles/${id}/board`, {}, observer),
    /not available/,
  );
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/transition`,
    { to_state: "CARD_PICKING_OPEN", reason: "Open board" },
    coordinator,
  );
  let board = await call(chama, "GET", `/api/chama/cycles/${id}/board`, {}, observer);
  assert.equal(board.cards.length, 10);
  assert.equal(board.remaining_cards, 10);
  assert.ok(board.cards.every((c) => c.official_number === null && !c.selected_by));
  assert.notDeepEqual(
    db
      .prepare("SELECT official_number FROM chama_cards WHERE cycle_id=? ORDER BY display_position")
      .all(id)
      .map((c) => c.official_number),
    Array.from({ length: 10 }, (_, i) => i + 1),
  );
  await assert.rejects(
    () =>
      call(
        chama,
        "POST",
        `/api/chama/cycles/${id}/pick`,
        { card_id: board.cards[0].card_id, idempotency_key: "observer-not-in-cycle" },
        observer,
      ),
    /frozen seats/,
  );
  const first = board.cards[0],
    claim = await call(
      chama,
      "POST",
      `/api/chama/cycles/${id}/pick`,
      { card_id: first.card_id, idempotency_key: "pick-request-0001" },
      picker,
    );
  assert.ok(claim.official_number > 0);
  await assert.rejects(
    () =>
      call(
        chama,
        "POST",
        `/api/chama/cycles/${id}/transition`,
        { to_state: "CARD_PICKING_CLOSED", reason: "Close picking" },
        coordinator,
      ),
    /Picking is incomplete/,
  );
  const replay = await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/pick`,
    { card_id: first.card_id, idempotency_key: "pick-request-0001" },
    picker,
  );
  assert.equal(replay.replayed, true);
  await assert.rejects(
    () =>
      call(
        chama,
        "POST",
        `/api/chama/cycles/${id}/pick`,
        { card_id: first.card_id, idempotency_key: "pick-request-0002" },
        picker,
      ),
    /already claimed/,
  );
  board = await call(chama, "GET", `/api/chama/cycles/${id}/board`, {}, observer);
  assert.equal(board.remaining_cards, 9);
  assert.equal(board.cards.find((c) => c.card_id === first.card_id).selected_by, "Picker Member");
  const used = new Set([first.card_id]);
  let key = 3;
  for (const c of board.cards) {
    if (used.has(c.card_id)) continue;
    await call(
      chama,
      "POST",
      `/api/chama/cycles/${id}/pick`,
      { card_id: c.card_id, idempotency_key: `pick-request-${String(key++).padStart(4, "0")}` },
      picker,
    );
  }
  // State transitions are sequential: picking closes only after the correct next state and full selection set.
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/transition`,
    { to_state: "CARD_PICKING_CLOSED", reason: "All picks complete" },
    coordinator,
  );
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/transition`,
    { to_state: "RESULTS_REVEALED", reason: "Publish draw" },
    coordinator,
  );
  let finalBoard = await call(chama, "GET", `/api/chama/cycles/${id}/board`, {}, picker);
  const cardOne = finalBoard.cards.find((c) => c.official_number === 1),
    cardTen = finalBoard.cards.find((c) => c.official_number === 10);
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/selections/${cardOne.selection_id}/correct`,
    {
      new_card_id: cardTen.card_id,
      reason: "Verified the selection event was associated with the wrong card.",
    },
    coordinator,
  );
  finalBoard = await call(chama, "GET", `/api/chama/cycles/${id}/board`, {}, picker);
  assert.equal(finalBoard.corrections.length, 1);
  assert.equal(finalBoard.cards.find((c) => c.official_number === 10).selected_by, "Picker Member");
  const payouts = await call(chama, "GET", `/api/chama/cycles/${id}/payouts`, {}, picker);
  assert.equal(payouts.length, 10);
  assert.deepEqual(
    payouts.map((p) => p.official_card_number),
    Array.from({ length: 10 }, (_, i) => i + 1),
  );
  assert.equal(payouts[0].expected_date, "2027-01-15");
  assert.equal(payouts[1].expected_date, "2027-02-15");
  assert.ok(payouts.every((p) => p.status === "UPCOMING" && !p.actual_date));
  await assert.rejects(
    () =>
      call(chama, "POST", `/api/chama/payouts/${payouts[0].id}`, { status: "PAID" }, coordinator),
    /requires actual date/,
  );
  await call(
    chama,
    "POST",
    `/api/chama/cycles/${id}/transition`,
    { to_state: "PAYOUTS_IN_PROGRESS", reason: "Begin disbursements" },
    coordinator,
  );
  await call(
    chama,
    "POST",
    `/api/chama/payouts/${payouts[0].id}`,
    {
      status: "PAID",
      actual_date: "2027-01-16",
      amount_paid: 50000,
      reference_number: "PAY-0001",
      reason: "Verified bank transfer",
    },
    coordinator,
  );
  const details = await call(chama, "GET", `/api/chama/cycles/${id}/payouts`, {}, picker);
  assert.equal(details[0].status, "PAID");
  assert.equal(details[0].amount_paid, undefined);
  assert.ok(
    db
      .prepare("SELECT 1 FROM chama_audit_events WHERE cycle_id=? AND action='card_revealed'")
      .get(id),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM chama_selection_events WHERE cycle_id=?").get(id).n,
    11,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM chama_selection_corrections WHERE cycle_id=?").get(id).n,
    1,
  );
  db.close();
});
