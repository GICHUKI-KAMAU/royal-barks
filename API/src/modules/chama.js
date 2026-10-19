import { randomInt, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { CHAMA_CYCLE_STATES } from "../../../shared/contracts.js";

const now = () => new Date().toISOString(),
  day = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)),
  positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;
const nairobiToday = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((x) => x.type === "year").value}-${parts.find((x) => x.type === "month").value}-${parts.find((x) => x.type === "day").value}`;
};
const STATES = CHAMA_CYCLE_STATES;
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const COORDINATORS = ["CHAMA_COORDINATOR", "ADMIN"];
const FINANCE = ["TREASURER", "ADMIN"];
function monthDate(first, offset) {
  const d = new Date(`${first}T12:00:00Z`),
    dayNum = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dayNum, last));
  return d.toISOString().slice(0, 10);
}
function shuffled(values) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export function initializeChama(db, { statusOn, requireRole, requireActiveMember, session, log }) {
  db.exec(`
 CREATE TABLE IF NOT EXISTS chama_cycles(
   id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
   expected_start_date TEXT NOT NULL,expected_end_date TEXT NOT NULL,first_payout_date TEXT NOT NULL,opt_in_deadline TEXT NOT NULL,
   min_seats INTEGER NOT NULL CHECK(min_seats>0),max_seats INTEGER NOT NULL CHECK(max_seats>=min_seats),duration_months INTEGER NOT NULL CHECK(duration_months>0),
   monthly_amount_per_seat REAL CHECK(monthly_amount_per_seat IS NULL OR monthly_amount_per_seat>0),
   state TEXT NOT NULL CHECK(state IN ('DRAFT','OPT_IN_OPEN','OPT_IN_CLOSED','CARD_PICKING_OPEN','CARD_PICKING_CLOSED','RESULTS_REVEALED','PAYOUTS_IN_PROGRESS','COMPLETED','CANCELLED')),
   created_by INTEGER NOT NULL REFERENCES profiles(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS chama_participants(
   id TEXT PRIMARY KEY,cycle_id TEXT NOT NULL REFERENCES chama_cycles(id),member_id INTEGER NOT NULL REFERENCES members(id),
   requested_seats INTEGER NOT NULL CHECK(requested_seats>0),frozen_seats INTEGER CHECK(frozen_seats IS NULL OR frozen_seats>0),
   member_name_snapshot TEXT,membership_status_snapshot TEXT,confirmed_at TEXT NOT NULL,updated_at TEXT NOT NULL,
   UNIQUE(cycle_id,member_id)
 );
 CREATE TABLE IF NOT EXISTS chama_cards(
   id TEXT PRIMARY KEY,cycle_id TEXT NOT NULL REFERENCES chama_cycles(id),official_number INTEGER NOT NULL CHECK(official_number>0),
   display_position INTEGER NOT NULL CHECK(display_position>0),UNIQUE(cycle_id,official_number),UNIQUE(cycle_id,display_position)
 );
 CREATE TABLE IF NOT EXISTS chama_selections(
   id TEXT PRIMARY KEY,cycle_id TEXT NOT NULL REFERENCES chama_cycles(id),card_id TEXT NOT NULL REFERENCES chama_cards(id),
   participant_id TEXT NOT NULL REFERENCES chama_participants(id),selected_at TEXT NOT NULL,idempotency_key TEXT NOT NULL,
   UNIQUE(cycle_id,card_id),UNIQUE(cycle_id,idempotency_key)
 );
 CREATE TABLE IF NOT EXISTS chama_selection_events(
   id INTEGER PRIMARY KEY,cycle_id TEXT NOT NULL REFERENCES chama_cycles(id),selection_id TEXT NOT NULL REFERENCES chama_selections(id),
   action TEXT NOT NULL,official_number INTEGER NOT NULL,member_name TEXT NOT NULL,actor_profile_id INTEGER REFERENCES profiles(id),created_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS chama_payouts(
   id TEXT PRIMARY KEY,cycle_id TEXT NOT NULL REFERENCES chama_cycles(id),position INTEGER NOT NULL CHECK(position>0),
   official_card_number INTEGER NOT NULL,selection_id TEXT NOT NULL REFERENCES chama_selections(id),participant_id TEXT NOT NULL REFERENCES chama_participants(id),
   expected_date TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('UPCOMING','DUE','PAID','DELAYED')),
   actual_date TEXT,amount_paid REAL CHECK(amount_paid IS NULL OR amount_paid>0),reference_number TEXT,recorded_by INTEGER REFERENCES profiles(id),notes TEXT NOT NULL DEFAULT '',
   UNIQUE(cycle_id,position),UNIQUE(cycle_id,official_card_number)
 );
 CREATE TABLE IF NOT EXISTS chama_payout_events(
   id INTEGER PRIMARY KEY,payout_id TEXT NOT NULL REFERENCES chama_payouts(id),actor_profile_id INTEGER NOT NULL REFERENCES profiles(id),
   action TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS chama_selection_corrections(
   id INTEGER PRIMARY KEY,cycle_id TEXT NOT NULL REFERENCES chama_cycles(id),selection_id TEXT NOT NULL REFERENCES chama_selections(id),
   previous_card_id TEXT NOT NULL REFERENCES chama_cards(id),replacement_card_id TEXT NOT NULL REFERENCES chama_cards(id),
   other_selection_id TEXT REFERENCES chama_selections(id),actor_profile_id INTEGER NOT NULL REFERENCES profiles(id),reason TEXT NOT NULL,created_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS chama_cycle_history(
   id INTEGER PRIMARY KEY,cycle_id TEXT NOT NULL REFERENCES chama_cycles(id),actor_profile_id INTEGER NOT NULL REFERENCES profiles(id),
   previous_state TEXT,new_state TEXT NOT NULL,reason TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS chama_audit_events(
   id INTEGER PRIMARY KEY,cycle_id TEXT REFERENCES chama_cycles(id),actor_profile_id INTEGER REFERENCES profiles(id),
   action TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS chama_cycles_state_idx ON chama_cycles(state);
 CREATE INDEX IF NOT EXISTS chama_participants_cycle_idx ON chama_participants(cycle_id);
 CREATE INDEX IF NOT EXISTS chama_cards_cycle_position_idx ON chama_cards(cycle_id,display_position);
 CREATE INDEX IF NOT EXISTS chama_payouts_cycle_date_idx ON chama_payouts(cycle_id,expected_date);
 `);
  if (
    !db
      .prepare("PRAGMA table_info(chama_payouts)")
      .all()
      .some((c) => c.name === "selection_id")
  )
    db.exec(
      "ALTER TABLE chama_payouts ADD COLUMN selection_id TEXT REFERENCES chama_selections(id)",
    );
  if (
    !db
      .prepare("PRAGMA table_info(chama_selection_corrections)")
      .all()
      .some((c) => c.name === "other_selection_id")
  )
    db.exec(
      "ALTER TABLE chama_selection_corrections ADD COLUMN other_selection_id TEXT REFERENCES chama_selections(id)",
    );
  const events = new EventEmitter();
  events.setMaxListeners(500);
  const audit = (cycleId, actor, action, details) => {
    const stamp = now();
    db.prepare(
      "INSERT INTO chama_audit_events(cycle_id,actor_profile_id,action,details_json,created_at) VALUES(?,?,?,?,?)",
    ).run(cycleId || null, actor?.id || null, action, JSON.stringify(details || {}), stamp);
    log?.(
      `chama_${action}`,
      String(actor?.id || "system"),
      "chama_cycle",
      cycleId || null,
      details || {},
    );
  };
  const cycle = (id) => db.prepare("SELECT * FROM chama_cycles WHERE id=?").get(id);
  const memberOf = (user) =>
    db
      .prepare(
        "SELECT p.member_id,m.name,m.status FROM profiles p LEFT JOIN members m ON m.id=p.member_id WHERE p.id=?",
      )
      .get(user.id);
  function publicCycle(c, user) {
    const active = memberOf(user),
      isActive = active?.member_id && active.status === "ACTIVE",
      own = isActive
        ? db
            .prepare(
              "SELECT id,requested_seats,frozen_seats,confirmed_at FROM chama_participants WHERE cycle_id=? AND member_id=?",
            )
            .get(c.id, active.member_id)
        : null;
    const view = {
      id: c.id,
      name: c.name,
      description: c.description,
      notes: c.notes,
      expected_start_date: c.expected_start_date,
      expected_end_date: c.expected_end_date,
      first_payout_date: c.first_payout_date,
      opt_in_deadline: c.opt_in_deadline,
      duration_months: c.duration_months,
      min_seats: c.min_seats,
      max_seats: c.max_seats,
      monthly_amount_per_seat: c.monthly_amount_per_seat,
      state: c.state,
      created_at: c.created_at,
      own_registration: c.state === "OPT_IN_OPEN" ? own || null : undefined,
      participant_count:
        c.state === "OPT_IN_OPEN" && user.roles.some((r) => COORDINATORS.includes(r))
          ? db.prepare("SELECT COUNT(*) n FROM chama_participants WHERE cycle_id=?").get(c.id).n
          : undefined,
    };
    if (
      isActive &&
      [
        "OPT_IN_CLOSED",
        "CARD_PICKING_OPEN",
        "CARD_PICKING_CLOSED",
        "RESULTS_REVEALED",
        "PAYOUTS_IN_PROGRESS",
        "COMPLETED",
      ].includes(c.state)
    )
      view.participants = db
        .prepare(
          "SELECT id,member_name_snapshot member_name,frozen_seats seats FROM chama_participants WHERE cycle_id=? ORDER BY member_name_snapshot COLLATE NOCASE",
        )
        .all(c.id);
    else if (user.roles.some((r) => COORDINATORS.includes(r)) && c.state === "OPT_IN_OPEN")
      view.participants = db
        .prepare(
          "SELECT p.id,m.name member_name,p.requested_seats seats,p.confirmed_at FROM chama_participants p JOIN members m ON m.id=p.member_id WHERE p.cycle_id=? ORDER BY m.name COLLATE NOCASE",
        )
        .all(c.id);
    return view;
  }
  function board(c, user) {
    const member = memberOf(user);
    if (!member?.member_id || member.status !== "ACTIVE")
      fail(403, "Active membership is required to view Chama card results.");
    if (
      ![
        "CARD_PICKING_OPEN",
        "CARD_PICKING_CLOSED",
        "RESULTS_REVEALED",
        "PAYOUTS_IN_PROGRESS",
        "COMPLETED",
      ].includes(c.state)
    )
      fail(409, "Card board is not available at this cycle stage.");
    const cards = db
      .prepare(
        `SELECT c.id card_id,c.display_position,s.id selection_id,card.official_number,p.member_name_snapshot selected_by,s.selected_at FROM chama_cards c LEFT JOIN chama_selections s ON s.card_id=c.id LEFT JOIN chama_cards card ON card.id=s.card_id LEFT JOIN chama_participants p ON p.id=s.participant_id WHERE c.cycle_id=? ORDER BY c.display_position`,
      )
      .all(c.id)
      .map((x) => ({
        card_id: x.card_id,
        display_position: x.display_position,
        selected: Boolean(x.selection_id),
        selection_id: x.selection_id || null,
        official_number: x.selection_id ? x.official_number : null,
        selected_by: x.selection_id ? x.selected_by : null,
        selected_at: x.selection_id ? x.selected_at : null,
      }));
    const own = member?.member_id
      ? db
          .prepare(
            "SELECT id,frozen_seats FROM chama_participants WHERE cycle_id=? AND member_id=?",
          )
          .get(c.id, member.member_id)
      : null;
    const picked = own
      ? db.prepare("SELECT COUNT(*) n FROM chama_selections WHERE participant_id=?").get(own.id).n
      : 0;
    return {
      cycle_id: c.id,
      state: c.state,
      cards,
      remaining_cards: cards.filter((x) => !x.selected).length,
      total_cards: cards.length,
      selected_count: cards.filter((x) => x.selected).length,
      own: {
        participant_id: own?.id || null,
        seats: own?.frozen_seats || 0,
        picked,
        remaining: Math.max(0, (own?.frozen_seats || 0) - picked),
      },
      participants: db
        .prepare(
          "SELECT id,member_name_snapshot member_name,frozen_seats seats FROM chama_participants WHERE cycle_id=? ORDER BY member_name_snapshot COLLATE NOCASE",
        )
        .all(c.id),
      corrections: db
        .prepare(
          "SELECT x.id,x.reason,x.created_at,x.selection_id,x.other_selection_id,old.official_number previous_card_number,new.official_number replacement_card_number FROM chama_selection_corrections x JOIN chama_cards old ON old.id=x.previous_card_id JOIN chama_cards new ON new.id=x.replacement_card_id WHERE x.cycle_id=? ORDER BY x.id",
        )
        .all(c.id),
    };
  }
  function payoutRows(c, user) {
    const member = memberOf(user);
    if (!member?.member_id || member.status !== "ACTIVE")
      fail(403, "Active membership is required to view the payout schedule.");
    const today = nairobiToday(),
      rows = db
        .prepare(
          `SELECT p.id,p.position,p.official_card_number,p.expected_date,p.status,p.participant_id,cp.member_name_snapshot member_name,p.actual_date,p.amount_paid,p.reference_number,p.notes FROM chama_payouts p JOIN chama_participants cp ON cp.id=p.participant_id WHERE p.cycle_id=? ORDER BY p.official_card_number`,
        )
        .all(c.id)
        .map((p) => ({
          ...p,
          status: p.status === "UPCOMING" && p.expected_date < today ? "DUE" : p.status,
        }));
    if (
      user.roles.some((r) => FINANCE.includes(r)) ||
      user.roles.some((r) => COORDINATORS.includes(r))
    )
      return rows;
    return rows.map((row) => {
      const safe = { ...row };
      delete safe.amount_paid;
      delete safe.reference_number;
      delete safe.notes;
      return safe;
    });
  }
  function existingCycle(user, id) {
    const c = cycle(id);
    if (!c) fail(404, "Cycle not found.");
    return c;
  }
  function transition(p, user, id) {
    requireRole(user, COORDINATORS);
    const c = existingCycle(user, id),
      to = String(p.to_state || ""),
      reason = String(p.reason || "").trim();
    if (!STATES.includes(to) || !reason)
      fail(400, "Choose a valid next state and provide a reason.");
    const transitions = {
      DRAFT: ["OPT_IN_OPEN", "CANCELLED"],
      OPT_IN_OPEN: ["OPT_IN_CLOSED", "CANCELLED"],
      OPT_IN_CLOSED: ["OPT_IN_OPEN", "CARD_PICKING_OPEN", "CANCELLED"],
      CARD_PICKING_OPEN: ["CARD_PICKING_CLOSED", "CANCELLED"],
      CARD_PICKING_CLOSED: ["RESULTS_REVEALED", "CANCELLED"],
      RESULTS_REVEALED: ["PAYOUTS_IN_PROGRESS", "CANCELLED"],
      PAYOUTS_IN_PROGRESS: ["COMPLETED", "CANCELLED"],
    };
    if (!transitions[c.state]?.includes(to))
      fail(409, `Cannot transition from ${c.state} to ${to}.`);
    const work = db.transaction(() => {
      let before = { state: c.state, monthly_amount_per_seat: c.monthly_amount_per_seat };
      if (to === "OPT_IN_OPEN") {
        const amount = Number(p.monthly_amount_per_seat ?? c.monthly_amount_per_seat);
        if (!positive(amount))
          fail(400, "Set a positive monthly contribution per seat before opening opt-in.");
        if (
          c.state === "OPT_IN_CLOSED" &&
          db.prepare("SELECT COUNT(*) n FROM chama_participants WHERE cycle_id=?").get(id).n !== 0
        )
          fail(409, "Opt-in can only be reopened when no one registered.");
        db.prepare(
          "UPDATE chama_cycles SET state='OPT_IN_OPEN',monthly_amount_per_seat=?,updated_at=? WHERE id=?",
        ).run(amount, now(), id);
      }
      if (to === "OPT_IN_CLOSED") {
        const people = db
          .prepare(
            "SELECT p.*,m.name,m.status FROM chama_participants p JOIN members m ON m.id=p.member_id WHERE p.cycle_id=?",
          )
          .all(id);
        if (!people.length)
          fail(409, "No members opted in. Reopen opt-in or cancel with a reason.");
        const ineligible = people.filter(
          (x) => statusOn(x.member_id, new Date().toISOString().slice(0, 10)) !== "ACTIVE",
        );
        if (ineligible.length)
          fail(
            409,
            `Resolve membership eligibility for: ${ineligible.map((x) => x.name).join(", ")}.`,
          );
        const total = people.reduce((n, x) => n + x.requested_seats, 0);
        const stamp = now();
        for (const person of people)
          db.prepare(
            "UPDATE chama_participants SET frozen_seats=requested_seats,member_name_snapshot=?,membership_status_snapshot=?,updated_at=? WHERE id=?",
          ).run(person.name, person.status, stamp, person.id);
        const numbers = shuffled(Array.from({ length: total }, (_, i) => i + 1));
        const insert = db.prepare(
          "INSERT INTO chama_cards(id,cycle_id,official_number,display_position) VALUES(?,?,?,?)",
        );
        numbers.forEach((num, i) => insert.run(randomUUID(), id, num, i + 1));
        db.prepare("UPDATE chama_cycles SET state='OPT_IN_CLOSED',updated_at=? WHERE id=?").run(
          stamp,
          id,
        );
        audit(id, user, "participants_frozen", {
          participants: people.length,
          total_seats: total,
          seat_snapshots: people.map((x) => ({ member_id: x.member_id, seats: x.requested_seats })),
        });
      }
      if (to === "OPT_IN_OPEN" && c.state === "OPT_IN_CLOSED")
        db.prepare("UPDATE chama_cycles SET opt_in_deadline=?,updated_at=? WHERE id=?").run(
          p.opt_in_deadline && day(p.opt_in_deadline) ? p.opt_in_deadline : c.opt_in_deadline,
          now(),
          id,
        );
      if (to === "CARD_PICKING_OPEN") {
        if (!db.prepare("SELECT COUNT(*) n FROM chama_cards WHERE cycle_id=?").get(id).n)
          fail(409, "Close opt-in with confirmed seats before opening card picking.");
        db.prepare("UPDATE chama_cycles SET state='CARD_PICKING_OPEN',updated_at=? WHERE id=?").run(
          now(),
          id,
        );
      }
      if (to === "CARD_PICKING_CLOSED") {
        const tally = db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM chama_cards WHERE cycle_id=?) cards,(SELECT COUNT(*) FROM chama_selections WHERE cycle_id=?) selected",
          )
          .get(id, id);
        const bad = db
          .prepare(
            "SELECT 1 FROM chama_participants p WHERE p.cycle_id=? AND (p.frozen_seats<>(SELECT COUNT(*) FROM chama_selections s WHERE s.participant_id=p.id)) LIMIT 1",
          )
          .get(id);
        if (tally.cards === 0 || tally.cards !== tally.selected || bad)
          fail(
            409,
            "Picking is incomplete: every card and every frozen seat must be selected exactly once.",
          );
        db.prepare(
          "UPDATE chama_cycles SET state='CARD_PICKING_CLOSED',updated_at=? WHERE id=?",
        ).run(now(), id);
      }
      if (to === "RESULTS_REVEALED") {
        const n = db.prepare("SELECT COUNT(*) n FROM chama_cards WHERE cycle_id=?").get(id).n,
          sel = db.prepare("SELECT COUNT(*) n FROM chama_selections WHERE cycle_id=?").get(id).n;
        if (!n || n !== sel)
          fail(409, "Results cannot be revealed until every official card has been selected.");
        const selections = db
          .prepare(
            "SELECT s.id selection_id,s.participant_id,c.official_number FROM chama_selections s JOIN chama_cards c ON c.id=s.card_id WHERE s.cycle_id=? ORDER BY c.official_number",
          )
          .all(id);
        if (selections.some((x, i) => x.official_number !== i + 1))
          fail(409, "Official card numbers are missing or duplicated.");
        const insert = db.prepare(
          "INSERT INTO chama_payouts(id,cycle_id,position,official_card_number,selection_id,participant_id,expected_date,status) VALUES(?,?,?,?,?,?,?,'UPCOMING')",
        );
        selections.forEach((s, i) =>
          insert.run(
            randomUUID(),
            id,
            i + 1,
            s.official_number,
            s.selection_id,
            s.participant_id,
            monthDate(c.first_payout_date, i),
          ),
        );
        db.prepare("UPDATE chama_cycles SET state='RESULTS_REVEALED',updated_at=? WHERE id=?").run(
          now(),
          id,
        );
        audit(id, user, "results_published", {
          payout_order: selections.map((s) => ({
            position: s.official_number,
            participant_id: s.participant_id,
          })),
        });
      }
      if (to === "COMPLETED") {
        const total = db.prepare("SELECT COUNT(*) n FROM chama_payouts WHERE cycle_id=?").get(id).n,
          paid = db
            .prepare("SELECT COUNT(*) n FROM chama_payouts WHERE cycle_id=? AND status='PAID'")
            .get(id).n;
        if (!total || total !== paid)
          fail(
            409,
            "A cycle can be completed only after every scheduled payout is recorded as paid.",
          );
      }
      if (to === "CANCELLED" && reason.length < 8)
        fail(400, "Provide a clear cancellation reason (at least 8 characters).");
      const stamp = now(),
        after = {
          state: to,
          monthly_amount_per_seat: db
            .prepare("SELECT monthly_amount_per_seat FROM chama_cycles WHERE id=?")
            .get(id).monthly_amount_per_seat,
        };
      if (
        to !== "OPT_IN_OPEN" &&
        to !== "OPT_IN_CLOSED" &&
        to !== "CARD_PICKING_OPEN" &&
        to !== "CARD_PICKING_CLOSED" &&
        to !== "RESULTS_REVEALED"
      )
        db.prepare("UPDATE chama_cycles SET state=?,updated_at=? WHERE id=?").run(to, stamp, id);
      db.prepare(
        "INSERT INTO chama_cycle_history(cycle_id,actor_profile_id,previous_state,new_state,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(id, user.id, c.state, to, reason, JSON.stringify(before), JSON.stringify(after), stamp);
      audit(id, user, "state_transition", { from: c.state, to, reason });
      return { id, state: to };
    });
    const result = work.immediate();
    events.emit(id, { event: "cycle_updated" });
    return result;
  }
  async function route(method, url, p, req, res, user) {
    const path = url.pathname;
    if (!path.startsWith("/api/chama")) return null;
    const list = "/api/chama/cycles";
    if (method === "GET" && path === list)
      return db
        .prepare("SELECT * FROM chama_cycles ORDER BY created_at DESC")
        .all()
        .map((c) => publicCycle(c, user));
    if (method === "POST" && path === list) {
      requireRole(user, COORDINATORS);
      const name = String(p.name || "").trim(),
        description = String(p.description || ""),
        start = p.expected_start_date,
        end = p.expected_end_date,
        first = p.first_payout_date,
        deadline = p.opt_in_deadline,
        min = Number(p.min_seats ?? 1),
        max = Number(p.max_seats ?? 10),
        duration = Number(p.duration_months);
      if (
        !name ||
        ![start, end, first, deadline].every(day) ||
        start > end ||
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        !Number.isInteger(duration) ||
        min < 1 ||
        max < min ||
        duration < 1
      )
        fail(400, "Provide a name, valid dates, and valid seat limits and cycle duration.");
      const id = randomUUID(),
        stamp = now();
      db.prepare(
        "INSERT INTO chama_cycles(id,name,description,notes,expected_start_date,expected_end_date,first_payout_date,opt_in_deadline,min_seats,max_seats,duration_months,state,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)",
      ).run(
        id,
        name,
        description,
        String(p.notes || ""),
        start,
        end,
        first,
        deadline,
        min,
        max,
        duration,
        user.id,
        stamp,
        stamp,
      );
      db.prepare(
        "INSERT INTO chama_cycle_history(cycle_id,actor_profile_id,previous_state,new_state,reason,before_json,after_json,created_at) VALUES(?,? ,NULL,?,?,?, ?,?)",
      ).run(
        id,
        user.id,
        "DRAFT",
        "Cycle created",
        "{}",
        JSON.stringify({ name, expected_start_date: start, expected_end_date: end }),
        stamp,
      );
      audit(id, user, "cycle_created", {
        name,
        dates: { start, end, first_payout: first, opt_in_deadline: deadline },
      });
      return { id, state: "DRAFT" };
    }
    let match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)$/);
    if (method === "GET" && match) {
      const c = existingCycle(user, match[1]);
      return publicCycle(c, user);
    }
    match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)\/transition$/);
    if (method === "POST" && match) return transition(p, user, match[1]);
    match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)\/opt-in$/);
    if (method === "POST" && match) {
      const c = existingCycle(user, match[1]);
      if (c.state !== "OPT_IN_OPEN") fail(409, "Opt-in is not open.");
      if (nairobiToday() > c.opt_in_deadline) fail(409, "The opt-in deadline has passed.");
      const { member_id: memberId } = requireActiveMember(user);
      if (statusOn(memberId, new Date().toISOString().slice(0, 10)) !== "ACTIVE")
        fail(403, "Only active Royal Barks members may opt in.");
      const seats = Number(p.seats),
        confirmed = p.confirmed === true;
      if (!Number.isInteger(seats) || seats < c.min_seats || seats > c.max_seats)
        fail(400, `Choose between ${c.min_seats} and ${c.max_seats} seats.`);
      if (!confirmed)
        fail(400, "Confirm the per-seat monthly contribution and total commitment before saving.");
      const old = db
        .prepare("SELECT * FROM chama_participants WHERE cycle_id=? AND member_id=?")
        .get(c.id, memberId);
      if (old?.frozen_seats) fail(409, "Seat counts are frozen.");
      const stamp = now(),
        commitment = Number(c.monthly_amount_per_seat) * seats;
      if (old)
        db.prepare(
          "UPDATE chama_participants SET requested_seats=?,confirmed_at=?,updated_at=? WHERE id=?",
        ).run(seats, stamp, stamp, old.id);
      else
        db.prepare(
          "INSERT INTO chama_participants(id,cycle_id,member_id,requested_seats,confirmed_at,updated_at) VALUES(?,?,?,?,?,?)",
        ).run(randomUUID(), c.id, memberId, seats, stamp, stamp);
      audit(c.id, user, old ? "seats_updated" : "member_opted_in", {
        member_id: memberId,
        seats,
        monthly_commitment: commitment,
        per_seat_amount: c.monthly_amount_per_seat,
      });
      events.emit(c.id, { event: "opt_in_updated" });
      return {
        ok: true,
        seats,
        per_seat_amount: c.monthly_amount_per_seat,
        monthly_commitment: commitment,
      };
    }
    match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)\/selections\/([0-9a-f-]+)\/correct$/);
    if (method === "POST" && match) {
      requireRole(user, ["ADMIN"]);
      const id = match[1],
        selectionId = match[2],
        c = existingCycle(user, id),
        reason = String(p.reason || "").trim();
      if (
        ![
          "CARD_PICKING_OPEN",
          "CARD_PICKING_CLOSED",
          "RESULTS_REVEALED",
          "PAYOUTS_IN_PROGRESS",
        ].includes(c.state)
      )
        fail(409, "Selections cannot be corrected at this cycle stage.");
      if (reason.length < 10)
        fail(400, "A correction requires a clear reason of at least 10 characters.");
      const selection = db
        .prepare(
          "SELECT s.*,p.member_name_snapshot,p.frozen_seats FROM chama_selections s JOIN chama_participants p ON p.id=s.participant_id WHERE s.id=? AND s.cycle_id=?",
        )
        .get(selectionId, id);
      if (!selection) fail(404, "Selection not found.");
      const replacement = db
        .prepare("SELECT * FROM chama_cards WHERE id=? AND cycle_id=?")
        .get(String(p.new_card_id || ""), id);
      if (!replacement || replacement.id === selection.card_id)
        fail(400, "Choose a different card from this cycle.");
      const other =
        db
          .prepare("SELECT * FROM chama_selections WHERE cycle_id=? AND card_id=?")
          .get(id, replacement.id) || null;
      const oldCard = db.prepare("SELECT * FROM chama_cards WHERE id=?").get(selection.card_id);
      const published = ["RESULTS_REVEALED", "PAYOUTS_IN_PROGRESS"].includes(c.state),
        stamp = now();
      if (published) {
        const affected = [selection.id, ...(other ? [other.id] : [])];
        const marks = affected.map(() => "?").join(",");
        if (
          db
            .prepare(
              `SELECT 1 FROM chama_payouts WHERE selection_id IN (${marks}) AND status='PAID' LIMIT 1`,
            )
            .get(...affected)
        )
          fail(
            409,
            "A selection tied to an already-paid payout cannot be changed through this workflow.",
          );
      }
      try {
        db.transaction(() => {
          if (other) {
            const max = db.prepare("SELECT COUNT(*) n FROM chama_cards WHERE cycle_id=?").get(id).n,
              temporaryId = randomUUID();
            db.prepare(
              "INSERT INTO chama_cards(id,cycle_id,official_number,display_position) VALUES(?,?,?,?)",
            ).run(temporaryId, id, max + 1, max + 1);
            db.prepare("UPDATE chama_selections SET card_id=? WHERE id=?").run(
              temporaryId,
              selection.id,
            );
            db.prepare("UPDATE chama_selections SET card_id=? WHERE id=?").run(
              oldCard.id,
              other.id,
            );
            db.prepare("UPDATE chama_selections SET card_id=? WHERE id=?").run(
              replacement.id,
              selection.id,
            );
            db.prepare("DELETE FROM chama_cards WHERE id=?").run(temporaryId);
          } else
            db.prepare("UPDATE chama_selections SET card_id=? WHERE id=?").run(
              replacement.id,
              selection.id,
            );
          if (published) {
            const affected = [selection, ...(other ? [other] : [])],
              max = 1000000;
            for (const s of affected)
              db.prepare(
                "UPDATE chama_payouts SET position=position+?,official_card_number=official_card_number+? WHERE selection_id=?",
              ).run(max, max, s.id);
            for (const s of affected) {
              const current = db
                .prepare(
                  "SELECT c.official_number,p.participant_id FROM chama_selections p JOIN chama_cards c ON c.id=p.card_id WHERE p.id=?",
                )
                .get(s.id);
              db.prepare(
                "UPDATE chama_payouts SET position=?,official_card_number=?,expected_date=?,participant_id=? WHERE selection_id=?",
              ).run(
                current.official_number,
                current.official_number,
                monthDate(c.first_payout_date, current.official_number - 1),
                current.participant_id,
                s.id,
              );
            }
          }
          db.prepare(
            "INSERT INTO chama_selection_corrections(cycle_id,selection_id,previous_card_id,replacement_card_id,other_selection_id,actor_profile_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            id,
            selection.id,
            oldCard.id,
            replacement.id,
            other?.id || null,
            user.id,
            reason,
            stamp,
          );
          const memberName = selection.member_name_snapshot;
          db.prepare(
            "INSERT INTO chama_selection_events(cycle_id,selection_id,action,official_number,member_name,actor_profile_id,created_at) VALUES(?,?,'SELECTION_CORRECTED',?,?,?,?)",
          ).run(id, selection.id, replacement.official_number, memberName, user.id, stamp);
          audit(id, user, "selection_corrected", {
            selection_id: selection.id,
            previous_card_number: oldCard.official_number,
            replacement_card_number: replacement.official_number,
            other_selection_id: other?.id || null,
            reason,
          });
        }).immediate();
      } catch (e) {
        if (e.code?.startsWith("SQLITE_CONSTRAINT"))
          fail(409, "Correction conflicts with a card or payout already recorded.");
        throw e;
      }
      events.emit(id, { event: "selection_corrected" });
      return {
        ok: true,
        previous_card_number: oldCard.official_number,
        replacement_card_number: replacement.official_number,
        other_selection_id: other?.id || null,
      };
    }
    match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)\/board$/);
    if (method === "GET" && match) {
      const c = existingCycle(user, match[1]);
      return board(c, user);
    }
    match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)\/pick$/);
    if (method === "POST" && match) {
      const id = match[1],
        c = existingCycle(user, id);
      if (c.state !== "CARD_PICKING_OPEN") fail(409, "Card picking is closed.");
      const { member_id: memberId } = requireActiveMember(user);
      if (statusOn(memberId, new Date().toISOString().slice(0, 10)) !== "ACTIVE")
        fail(403, "Only an active member may select cards.");
      const part = db
        .prepare("SELECT * FROM chama_participants WHERE cycle_id=? AND member_id=?")
        .get(id, memberId);
      if (!part?.frozen_seats) fail(403, "Only members with frozen seats can pick cards.");
      const card = db
        .prepare("SELECT * FROM chama_cards WHERE cycle_id=? AND id=?")
        .get(id, String(p.card_id || ""));
      if (!card) fail(404, "Card is not part of this cycle.");
      const idem = String(p.idempotency_key || "");
      if (idem.length < 12) fail(400, "An idempotency key is required for each card pick.");
      const prior = db
        .prepare("SELECT * FROM chama_selections WHERE cycle_id=? AND idempotency_key=?")
        .get(id, idem);
      if (prior) {
        if (prior.participant_id === part.id && prior.card_id === card.id)
          return { ok: true, replayed: true, official_number: card.official_number };
        fail(409, "Idempotency key was already used for another selection.");
      }
      let pick;
      try {
        pick = db
          .transaction(() => {
            const count = db
              .prepare("SELECT COUNT(*) n FROM chama_selections WHERE participant_id=?")
              .get(part.id).n;
            if (count >= part.frozen_seats)
              fail(409, "All frozen seats have already selected a card.");
            const stamp = now(),
              selectionId = randomUUID();
            db.prepare(
              "INSERT INTO chama_selections(id,cycle_id,card_id,participant_id,selected_at,idempotency_key) VALUES(?,?,?,?,?,?)",
            ).run(selectionId, id, card.id, part.id, stamp, idem);
            db.prepare(
              "INSERT INTO chama_selection_events(cycle_id,selection_id,action,official_number,member_name,actor_profile_id,created_at) VALUES(?,?,'CARD_REVEALED',?,?,?,?)",
            ).run(
              id,
              selectionId,
              card.official_number,
              part.member_name_snapshot || memberOf(user).name,
              user.id,
              stamp,
            );
            audit(id, user, "card_revealed", {
              selection_id: selectionId,
              official_number: card.official_number,
              member_id: memberId,
            });
            return {
              ok: true,
              official_number: card.official_number,
              selected_by: part.member_name_snapshot || memberOf(user).name,
              selected_at: stamp,
            };
          })
          .immediate();
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE")
          fail(409, "This card was already claimed or the request key was reused.");
        throw e;
      }
      events.emit(id, { event: "card_revealed" });
      return pick;
    }
    match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)\/payouts$/);
    if (method === "GET" && match) {
      const c = existingCycle(user, match[1]);
      if (!["RESULTS_REVEALED", "PAYOUTS_IN_PROGRESS", "COMPLETED"].includes(c.state))
        fail(409, "Payout schedule is not published yet.");
      return payoutRows(c, user);
    }
    match = path.match(/^\/api\/chama\/payouts\/([0-9a-f-]+)$/);
    if (method === "POST" && match) {
      requireRole(user, COORDINATORS);
      const payout = db.prepare("SELECT * FROM chama_payouts WHERE id=?").get(match[1]);
      if (!payout) fail(404, "Payout position not found.");
      const c = existingCycle(user, payout.cycle_id),
        status = String(p.status || ""),
        reason = String(p.reason || "").trim();
      if (!["PAYOUTS_IN_PROGRESS", "RESULTS_REVEALED"].includes(c.state))
        fail(409, "Payouts cannot be updated at this cycle stage.");
      if (!["PAID", "DELAYED", "DUE"].includes(status)) fail(400, "Choose PAID, DUE, or DELAYED.");
      if (
        status === "PAID" &&
        (!day(p.actual_date) ||
          !positive(p.amount_paid) ||
          !String(p.reference_number || "").trim())
      )
        fail(400, "A paid payout requires actual date, positive amount, and reference number.");
      if (status === "DELAYED" && reason.length < 5)
        fail(400, "A delayed payout requires a reason.");
      const before = { ...payout },
        after = {
          status,
          actual_date: status === "PAID" ? p.actual_date : null,
          amount_paid: status === "PAID" ? Number(p.amount_paid) : null,
          reference_number: status === "PAID" ? String(p.reference_number).trim() : null,
          recorded_by: user.id,
          notes: reason || String(p.notes || ""),
        };
      db.transaction(() => {
        db.prepare(
          "UPDATE chama_payouts SET status=?,actual_date=?,amount_paid=?,reference_number=?,recorded_by=?,notes=? WHERE id=?",
        ).run(
          after.status,
          after.actual_date,
          after.amount_paid,
          after.reference_number,
          after.recorded_by,
          after.notes,
          payout.id,
        );
        db.prepare(
          "INSERT INTO chama_payout_events(payout_id,actor_profile_id,action,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          payout.id,
          user.id,
          "payout_status_updated",
          JSON.stringify(before),
          JSON.stringify(after),
          reason,
          now(),
        );
        audit(c.id, user, "payout_status_updated", {
          payout_id: payout.id,
          before: before.status,
          after: status,
          reference_number: after.reference_number,
        });
      })();
      events.emit(c.id, { event: "payout_updated" });
      return { ok: true };
    }
    match = path.match(/^\/api\/chama\/cycles\/([0-9a-f-]+)\/events$/);
    if (method === "GET" && match) {
      const c = existingCycle(user, match[1]);
      if (!memberOf(user)?.member_id || memberOf(user).status !== "ACTIVE")
        fail(403, "Active membership is required for live Chama updates.");
      if (
        ![
          "CARD_PICKING_OPEN",
          "CARD_PICKING_CLOSED",
          "RESULTS_REVEALED",
          "PAYOUTS_IN_PROGRESS",
          "COMPLETED",
        ].includes(c.state)
      )
        fail(409, "Live board is not available at this stage.");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: ready\ndata: ${JSON.stringify(board(c, user))}\n\n`);
      const send = () => {
        const live = memberOf(user);
        if (!live?.member_id || live.status !== "ACTIVE") {
          res.end();
          return;
        }
        try {
          res.write(`event: update\ndata: ${JSON.stringify(board(c, user))}\n\n`);
        } catch {
          res.end();
        }
      };
      events.on(c.id, send);
      const heartbeat = setInterval(() => {
        if (!session(req)) res.end();
        else res.write(": keep-alive\n\n");
      }, 15000);
      req.on("close", () => {
        events.off(c.id, send);
        clearInterval(heartbeat);
      });
      return { streaming: true };
    }
    return null;
  }
  return { route, events };
}
