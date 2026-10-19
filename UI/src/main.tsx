import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  FileUp,
  LayoutDashboard,
  ListFilter,
  Search,
  ShieldCheck,
  Users,
  Wallet,
  Plus,
  CreditCard,
  ClipboardList,
  FileText,
  Settings,
  Shield,
  Activity,
} from "lucide-react";
import { api } from "./services/apiClient";
import { Empty } from "./components/common/TableFeedback";
import { Status } from "./components/common/Status";
import { ReferenceRow as Ref } from "./components/common/ReferenceRow";
import { getCategoryLabel as category } from "./utils/categories";
import { formatKenyanDate, formatKes } from "./utils/format";
import type {
  AuthenticatedUser,
  DashboardSummary,
  FinancialImportReview,
  HistoricalImport,
  LedgerEntry,
  Member,
  MeetingRecord,
} from "./types";
import "./style.css";
import { ReportsView } from "./features/reports/ReportsView";
import { HistoricalReport } from "./features/reports/HistoricalReport";
import { AuthGate } from "./features/auth/AuthGate";
import { ChamaManagement } from "./features/chama/ChamaManagement";
import { UserManagement } from "./features/users/UserManagement";
import { MemberModal } from "./features/members/MemberModal";
import { EntryModal } from "./features/finance/EntryModal";

const kes = formatKes;
const dateKE = formatKenyanDate;
const pageDescriptions: Record<string, string> = {
  Dashboard: "A clear view of member finances and group activity.",
  Members: "Review member status, history, and balances.",
  Meetings: "Attendance and meeting contributions are recorded separately.",
  "Financial records": "Record payments and eligible obligations.",
  "Import & reconcile": "Review historical records before posting opening balances.",
  "Users & Roles": "Invite people and manage account access.",
};
const nav = [
  ["Dashboard", LayoutDashboard],
  ["Members", Users],
  ["Contributions", Activity],
  ["Payments", CreditCard],
  ["Arrears", Banknote],
  ["Meetings", CalendarDays],
  ["Minutes", ClipboardList],
  ["Expenses", Wallet],
  ["Reports", FileText],
  ["Chama", Users],
  ["Financial records", Wallet],
  ["Import & reconcile", FileUp],
  ["Users & Roles", Shield],
  ["Settings", Settings],
] as const;
const pageFromHash = () => {
  const slug = decodeURIComponent(window.location.hash.slice(1));
  return (
    nav.find(([label]) => label.toLowerCase().replaceAll(" ", "-") === slug)?.[0] || "Dashboard"
  );
};
function App() {
  const [user, setUser] = useState<AuthenticatedUser | null>(null),
    [authLoading, setAuthLoading] = useState(true),
    [authExpired, setAuthExpired] = useState(false),
    [page, setPage] = useState(pageFromHash),
    [members, setMembers] = useState<Member[]>([]),
    [dash, setDash] = useState<DashboardSummary | null>(null),
    [ledger, setLedger] = useState<LedgerEntry[]>([]),
    [meetings, setMeetings] = useState<MeetingRecord[]>([]),
    [imports, setImports] = useState<HistoricalImport[]>([]),
    [loading, setLoading] = useState(true),
    [query, setQuery] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [modal, setModal] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<FinancialImportReview | null>(null);
  const refresh = async () => {
    setLoading(true);
    try {
      const [m, d, l, mt, im] = await Promise.all([
        api<Member[]>("/members"),
        api<DashboardSummary>("/dashboard"),
        api<LedgerEntry[]>("/ledger"),
        api<MeetingRecord[]>("/meetings"),
        api<HistoricalImport[]>("/imports"),
      ]);
      setMembers(m);
      setDash(d);
      setLedger(l);
      setMeetings(mt);
      setImports(im);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    api<{ user: AuthenticatedUser | null }>("/auth/session")
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);
  useEffect(() => {
    const expired = () => {
      setUser(null);
      setAuthExpired(true);
      setMembers([]);
      setDash(null);
      window.location.hash = "#login";
    };
    window.addEventListener("rb-auth-expired", expired);
    return () => window.removeEventListener("rb-auth-expired", expired);
  }, []);
  useEffect(() => {
    if (user) refresh();
  }, [user]);
  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.location.hash = "#overview";
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (!user) return;
    const slug = page.toLowerCase().replaceAll(" ", "-");
    if (window.location.hash !== `#${slug}`) window.location.hash = slug;
  }, [page, user]);
  useEffect(() => {
    if (!message && !error) return;
    const t = setTimeout(() => {
      setMessage("");
      setError("");
    }, 4000);
    return () => clearTimeout(t);
  }, [message, error]);
  const filtered = useMemo(
    () =>
      members.filter(
        (m) =>
          (!statusFilter || m.status === statusFilter) &&
          m.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [members, statusFilter, query],
  );
  const submit = async (path: string, body: unknown, success: string) => {
    setBusy(true);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setModal("");
      setPreview(null);
      setMessage(success);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = (m: string) => {
    setModal(m);
    setError("");
  };
  const canViewGroupFinances = Boolean(
    user?.roles.some((role) => ["TREASURER", "ADMIN"].includes(role)),
  );
  const cards = [
    [
      "Active members",
      String(dash?.members.active || 0),
      `${dash?.members.total || 0} members on record`,
      Users,
    ],
    [
      "New payments",
      canViewGroupFinances ? kes(dash?.new_paid || 0) : "Restricted",
      "Recorded transactions",
      ArrowDownLeft,
    ],
    [
      "New obligations",
      canViewGroupFinances ? kes(dash?.new_obligations || 0) : "Restricted",
      "Generated and recorded",
      ArrowUpRight,
    ],
    [
      "Opening arrears",
      canViewGroupFinances ? kes(dash?.opening_arrears || 0) : "Restricted",
      "Historical balances kept separate",
      Banknote,
    ],
  ] as const;
  if (authLoading)
    return (
      <div className="auth-screen">
        <div className="auth-card">Checking your secure session…</div>
      </div>
    );
  if (!user)
    return (
      <AuthGate
        onLogin={(u) => {
          setAuthExpired(false);
          setUser(u);
        }}
        expired={authExpired}
      />
    );
  const logout = async () => {
    await api("/auth/logout", { method: "POST", body: "{}" });
    setUser(null);
    setMembers([]);
    setDash(null);
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Dashboard");
          }}
        >
          <span className="brand-logo">RB</span>
          <span>
            <b>Royal Barks</b>
            <small>MEMBER FINANCE</small>
          </span>
        </a>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              onClick={() => setPage(label)}
              className={`nav-link ${page === label ? "selected" : ""}`}
            >
              <Icon size={17} />
              {label}
              {label === "Import & reconcile" && <ChevronRight className="nav-arrow" size={15} />}
            </button>
          ))}
        </nav>
        <div className="side-note">
          <ShieldCheck size={17} />
          <span>
            <b>{user.roles.join(" · ")}</b>
            <small>{user.display_name}</small>
          </span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            Royal Barks <span>/</span> <b>{page}</b>
          </div>
          <div className="top-right">
            <span>{dateKE(new Date().toISOString())}</span>
            <span>{user.display_name}</span>
            <button className="btn small" onClick={logout}>
              Sign out
            </button>
            {user.roles.includes("ADMIN") && (
              <button className="btn primary small" onClick={() => open("member")}>
                <Plus size={15} /> Add member
              </button>
            )}
          </div>
        </header>
        <section className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "Dashboard" ? "FINANCE WORKSPACE" : page.toUpperCase()}
              </div>
              <h1>{page}</h1>
              <p>{pageDescriptions[page] || "Royal Barks group workspace."}</p>
            </div>
            <div className="heading-actions">
              {page === "Members" && user.roles.includes("ADMIN") && (
                <button className="btn primary" onClick={() => open("member")}>
                  <Plus size={15} /> Add member
                </button>
              )}
              {page === "Meetings" &&
                user.roles.some((role) =>
                  ["CHAMA_COORDINATOR", "TREASURER", "ADMIN"].includes(role),
                ) && (
                  <button className="btn primary" onClick={() => open("meeting")}>
                    <Plus size={15} /> Record meeting
                  </button>
                )}
              {page === "Financial records" &&
                user.roles.some((r: string) => ["TREASURER", "ADMIN"].includes(r)) && (
                  <>
                    <button className="btn" onClick={() => open("import")}>
                      <FileUp size={15} /> Import records CSV
                    </button>
                    <button className="btn" onClick={() => open("batch")}>
                      Generate monthly obligations
                    </button>
                    <button className="btn" onClick={() => open("obligation")}>
                      <Plus size={15} /> Obligation
                    </button>
                    <button className="btn primary" onClick={() => open("payment")}>
                      <Plus size={15} /> Payment
                    </button>
                  </>
                )}
              {page === "Import & reconcile" &&
                user.roles.some((r: string) => ["TREASURER", "ADMIN"].includes(r)) && (
                  <button className="btn primary" onClick={() => open("import")}>
                    <FileUp size={15} /> Import statement
                  </button>
                )}
            </div>
          </div>
          {loading ? (
            <div className="loading">Loading finance workspace</div>
          ) : page === "Dashboard" ? (
            <>
              <div className="stat-grid">
                {cards.map(([label, value, sub, Icon]) => (
                  <article className="stat-card" key={label}>
                    <div className="stat-label">
                      {label}
                      <span className="stat-icon">
                        <Icon size={17} />
                      </span>
                    </div>
                    <div className="stat-value">{value}</div>
                    <div className="stat-sub">{sub}</div>
                  </article>
                ))}
              </div>
              <div className="content-grid">
                <article className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Member balances</h2>
                      <p>Opening arrears and current activity remain distinct.</p>
                    </div>
                    <button className="link-button" onClick={() => setPage("Members")}>
                      View members <ChevronRight size={14} />
                    </button>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>MEMBER</th>
                          <th>STATUS</th>
                          <th>OPENING ARREARS</th>
                          <th>NEW DUE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.slice(0, 7).map((m) => (
                          <tr key={m.id}>
                            <td className="member-name">{m.name}</td>
                            <td>
                              <Status value={m.status} />
                            </td>
                            <td>
                              {kes(
                                Object.values(m.categories).reduce(
                                  (s, c) => s + c.opening_arrears,
                                  0,
                                ),
                              )}
                            </td>
                            <td className="bold">
                              {kes(
                                Object.values(m.categories).reduce((s, c) => s + c.current_due, 0),
                              )}
                            </td>
                          </tr>
                        ))}
                        {!members.length && (
                          <Empty
                            col={4}
                            text="No members yet. Add a member or import the April statement."
                          />
                        )}
                      </tbody>
                    </table>
                  </div>
                </article>
                <article className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>April 2026 statement</h2>
                      <p>Reference figures not posted as income</p>
                    </div>
                    <span className="pill neutral">REFERENCE</span>
                  </div>
                  {dash?.reference && (
                    <div className="ref-list">
                      <Ref
                        label="Monthly contributions paid"
                        value={dash?.reference.paid_monthly || 206300}
                      />
                      <Ref label="Penalties paid" value={dash?.reference.paid_penalty || 24850} />
                      <Ref
                        label={'Savings "500" paid'}
                        value={dash?.reference.paid_savings_500 || 95200}
                      />
                      <Ref label="Food payments" value={dash?.reference.paid_food || 98500} />
                      <Ref label="Total paid" value={dash?.reference.total_paid || 415650} strong />
                      <Ref
                        label="Total unpaid"
                        value={dash?.reference.total_unpaid || 216500}
                        strong
                      />
                      <Ref label="Reported cash" value={dash?.reference.cash || 79732.7} />
                    </div>
                  )}
                  {dash?.reference && (
                    <div className="notice">
                      <CircleHelp size={15} /> Cash is a separate accounting measure. Discrepancies
                      are reviewed, never silently adjusted.
                    </div>
                  )}
                </article>
              </div>
              <div className="rule-banner">
                <BadgeCheck size={18} />
                <span>
                  <b>Eligibility rules are active</b>
                  <small>
                    Only active members accrue monthly and KSh 500 meeting contributions. Food
                    obligations are never generated automatically.
                  </small>
                </span>
              </div>
              <HistoricalReport />
            </>
          ) : page === "Members" ? (
            <>
              <div className="toolbar">
                <label className="search">
                  <Search size={16} />
                  <input
                    placeholder="Search members"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <label className="filter">
                  <ListFilter size={15} />
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="">All statuses</option>
                    <option>ACTIVE</option>
                    <option>DORMANT</option>
                    <option>STATUS TO CONFIRM</option>
                  </select>
                </label>
                <span className="result-count">{filtered.length} members</span>
              </div>
              <article className="panel table-panel">
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>MEMBER</th>
                        <th>STATUS</th>
                        <th>OPENING ARREARS</th>
                        <th>NEW OBLIGATIONS</th>
                        <th>NEW PAYMENTS</th>
                        <th>ESTIMATED DUE</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((m) => {
                        const cats = Object.values(m.categories);
                        return (
                          <tr key={m.id}>
                            <td className="member-name">
                              {m.name}
                              <small>
                                {m.status_history.at(-1)?.effective_date
                                  ? dateKE(m.status_history.at(-1)?.effective_date || "")
                                  : "No status history"}
                              </small>
                            </td>
                            <td>
                              <Status value={m.status} />
                            </td>
                            <td>{kes(cats.reduce((s, c) => s + c.opening_arrears, 0))}</td>
                            <td>{kes(cats.reduce((s, c) => s + c.obligations_new, 0))}</td>
                            <td>{kes(cats.reduce((s, c) => s + c.paid_new, 0))}</td>
                            <td className="bold">
                              {kes(cats.reduce((s, c) => s + c.current_due, 0))}
                            </td>
                            <td>
                              <button className="row-link" onClick={() => open(`status:${m.id}`)}>
                                Change status
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {!filtered.length && <Empty col={7} text="No matching members." />}
                    </tbody>
                  </table>
                </div>
              </article>
              <div className="footnote">
                Changing a status requires an effective date, reason, authorized official, and
                confirmation after reviewing its financial impact.
              </div>
            </>
          ) : page === "Financial records" ? (
            <>
              <div className="notice wide">
                <CircleHelp size={15} /> Monthly obligations include active members only for each
                month. Food eligibility must be confirmed for every manually entered obligation.
              </div>
              <article className="panel table-panel">
                <div className="panel-heading">
                  <div>
                    <h2>New financial entries</h2>
                    <p>Payments and obligations recorded after migration.</p>
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>DATE</th>
                        <th>MEMBER</th>
                        <th>CATEGORY</th>
                        <th>TYPE</th>
                        <th>AMOUNT</th>
                        <th>RECORDED BY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((x) => (
                        <tr key={`${x.kind}-${x.id}`}>
                          <td>{dateKE(x.record_date)}</td>
                          <td className="member-name">{x.name}</td>
                          <td>{category(x.category)}</td>
                          <td>
                            <span className={`pill ${x.kind === "payment" ? "green" : "neutral"}`}>
                              {x.kind === "payment" ? "Payment" : "Obligation"}
                            </span>
                          </td>
                          <td className="bold">{kes(x.amount)}</td>
                          <td>{x.actor}</td>
                        </tr>
                      ))}
                      {!ledger.length && (
                        <Empty col={6} text="No new financial entries have been recorded." />
                      )}
                    </tbody>
                  </table>
                </div>
              </article>
              {imports.map((statement) => (
                <article className="panel table-panel" key={`import-${statement.id}`}>
                  <div className="panel-heading">
                    <div>
                      <h2>Imported opening records · {dateKE(statement.statement_date)}</h2>
                      <p>
                        {statement.source} · imported by {statement.imported_by} · reviewed by{" "}
                        {statement.reviewed_by} · approved by {statement.approved_by}
                      </p>
                      <p>
                        Historical summaries and opening balances; these are not newly received
                        payments or transaction-level records.
                      </p>
                    </div>
                    <span className="pill neutral">{statement.rows.length} MEMBERS</span>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>MEMBER</th>
                          <th>STATUS</th>
                          <th>MONTHLY PAID</th>
                          <th>PENALTIES PAID</th>
                          <th>SAVINGS “500” PAID</th>
                          <th>FOOD PAID</th>
                          <th>UNPAID MONTHLY</th>
                          <th>UNPAID PENALTIES</th>
                          <th>OTHER BALANCE</th>
                          <th>REVIEW</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statement.rows.map((row) => (
                          <tr key={row.id}>
                            <td className="member-name">{row.member_name}</td>
                            <td>
                              <Status value={row.existing_status} />
                            </td>
                            <td>{kes(row.amounts.paid_monthly || 0)}</td>
                            <td>{kes(row.amounts.paid_penalty || 0)}</td>
                            <td>{kes(row.amounts.paid_savings_500 || 0)}</td>
                            <td>{kes(row.amounts.paid_food || 0)}</td>
                            <td>{kes(row.amounts.unpaid_monthly || 0)}</td>
                            <td>{kes(row.amounts.unpaid_penalty || 0)}</td>
                            <td>{kes(row.amounts.other_balance || 0)}</td>
                            <td className="flag-cell">
                              {row.issues.length ? row.issues.join("; ") : "Clear"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(statement.supplemental.aggregate_rows?.length || 0) > 0 && (
                    <div className="notice">
                      Unallocated group totals:{" "}
                      {(statement.supplemental.aggregate_rows || [])
                        .map(
                          (row) => `${row.member_name} · ${kes(row.amounts.paid_food || 0)} food`,
                        )
                        .join(", ")}
                      . Not assigned to a member.
                    </div>
                  )}
                </article>
              ))}
            </>
          ) : page === "Meetings" ? (
            <>
              <div className="notice wide">
                <CircleHelp size={15} /> Meeting contributions are generated for active members on
                the meeting date. Attendance is independent. Food is not generated.
              </div>
              <div className="meeting-list">
                {meetings.map((m) => (
                  <article className="panel meeting" key={m.id}>
                    <div>
                      <span className="meeting-date">
                        <CalendarDays size={16} />
                        {dateKE(m.meeting_date)}
                      </span>
                      <h3>{m.title}</h3>
                      <p>Recorded by {m.created_by}</p>
                    </div>
                    <div className="attendance-count">
                      {m.attendance.filter((attendee) => attendee.attended).length} attended{" "}
                      <small> {m.attendance.length} on register</small>
                    </div>
                  </article>
                ))}
                {!meetings.length && (
                  <article className="panel empty-state">No meetings recorded yet.</article>
                )}
              </div>
            </>
          ) : page === "Users & Roles" ? (
            <UserManagement user={user} members={members} />
          ) : page === "Chama" ? (
            <ChamaManagement user={user} />
          ) : page === "Import & reconcile" ? (
            <>
              <div className="summary-strip">
                <div>
                  <b>April 2026</b>
                  <span>Statement reference</span>
                </div>
                <div>
                  <b>KSh 415,650</b>
                  <span>Paid</span>
                </div>
                <div>
                  <b>KSh 216,500</b>
                  <span>Unpaid</span>
                </div>
                <div>
                  <b>KSh 79,732.70</b>
                  <span>Reported cash</span>
                </div>
              </div>
              <div className="notice wide">
                <CircleHelp size={15} /> Historical paid totals and opening arrears are separate.
                Savings "500" retains its label. Statement summaries are not transaction level audit
                trails.
              </div>
              <article className="panel table-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Posted imports</h2>
                    <p>Imported, reviewed, and approved by named officials.</p>
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>STATEMENT DATE</th>
                        <th>SOURCE</th>
                        <th>MEMBER ROWS</th>
                        <th>IMPORTED BY</th>
                        <th>REVIEWED BY</th>
                        <th>APPROVED BY</th>
                        <th>RECONCILIATION</th>
                        <th>UNALLOCATED ROWS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {imports.map((record) => (
                        <tr key={record.id}>
                          <td>{record.statement_date}</td>
                          <td>{record.source}</td>
                          <td>{record.rows.length}</td>
                          <td>{record.imported_by}</td>
                          <td>{record.reviewed_by}</td>
                          <td>{record.approved_by}</td>
                          <td>
                            {record.reconciliation.filter((item) => item.status !== "MATCH").length}{" "}
                            differences flagged
                          </td>
                          <td>
                            {record.supplemental.aggregate_rows?.length
                              ? record.supplemental.aggregate_rows
                                  .map((row) => `${row.member_name} (group total)`)
                                  .join(", ")
                              : "None"}
                          </td>
                        </tr>
                      ))}
                      {!imports.length && (
                        <Empty col={8} text="No historical statements have been imported." />
                      )}
                    </tbody>
                  </table>
                </div>
              </article>
            </>
          ) : page === "Payments" || page === "Contributions" ? (
            <article className="panel table-panel">
              <div className="panel-heading">
                <div>
                  <h2>{page === "Payments" ? "Recorded payments" : "Contribution activity"}</h2>
                  <p>
                    {canViewGroupFinances
                      ? "Group records"
                      : "Only your own financial records are shown."}
                  </p>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>DATE</th>
                      <th>MEMBER</th>
                      <th>CATEGORY</th>
                      <th>TYPE</th>
                      <th>AMOUNT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger
                      .filter((entry) =>
                        page === "Payments"
                          ? entry.kind === "payment"
                          : ["monthly", "meeting"].includes(entry.category),
                      )
                      .map((entry) => (
                        <tr key={`${entry.kind}-${entry.id}`}>
                          <td>{dateKE(entry.record_date)}</td>
                          <td>{entry.name}</td>
                          <td>{category(entry.category)}</td>
                          <td>{entry.kind === "payment" ? "Paid" : "Obligation"}</td>
                          <td className="bold">{kes(entry.amount)}</td>
                        </tr>
                      ))}
                    {!ledger.some((entry) =>
                      page === "Payments"
                        ? entry.kind === "payment"
                        : ["monthly", "meeting"].includes(entry.category),
                    ) && <Empty col={5} text={`No ${page.toLowerCase()} records are available.`} />}
                  </tbody>
                </table>
              </div>
            </article>
          ) : page === "Arrears" ? (
            <article className="panel table-panel">
              <div className="panel-heading">
                <div>
                  <h2>Outstanding balances</h2>
                  <p>Opening arrears remain separate from new obligations and payments.</p>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>MEMBER</th>
                      <th>STATUS</th>
                      <th>OPENING ARREARS</th>
                      <th>NEW AMOUNT DUE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id}>
                        <td className="member-name">{m.name}</td>
                        <td>
                          <Status value={m.status} />
                        </td>
                        <td>
                          {kes(
                            Object.values(m.categories).reduce((s, c) => s + c.opening_arrears, 0),
                          )}
                        </td>
                        <td className="bold">
                          {kes(Object.values(m.categories).reduce((s, c) => s + c.current_due, 0))}
                        </td>
                      </tr>
                    ))}
                    {!members.length && <Empty col={4} text="No member balances are available." />}
                  </tbody>
                </table>
              </div>
            </article>
          ) : page === "Reports" ? (
            <ReportsView canViewGroupFinances={canViewGroupFinances} />
          ) : (
            <article className="panel">
              <h2>{page}</h2>
              <p>
                {page === "Minutes"
                  ? "Meeting minutes are not yet recorded in the system."
                  : "This module is ready for its dedicated record workflow."}
              </p>
            </article>
          )}
        </section>
      </main>
      {(modal === "member" || modal.startsWith("status:")) && (
        <MemberModal
          member={
            modal.startsWith("status:")
              ? members.find((m) => m.id === Number(modal.split(":")[1]))
              : undefined
          }
          close={() => setModal("")}
          submit={submit}
        />
      )}
      {["payment", "obligation", "batch", "meeting", "import"].includes(modal) && (
        <EntryModal
          type={modal}
          members={members}
          close={() => {
            setModal("");
            setPreview(null);
          }}
          submit={submit}
          preview={preview}
          setPreview={setPreview}
          busy={busy}
        />
      )}
      {(message || error) && (
        <div className={`toast ${error ? "danger" : ""}`}>{error || message}</div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
