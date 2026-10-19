import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Field } from "../../components/common/Field";
import { api, apiUrl } from "../../services/apiClient";
import type { AuthenticatedUser } from "../../types";
import type { ChamaBoard, ChamaCycle, ChamaCycleSummary, ChamaPayout } from "./types";
import { formatKenyanDate as dateKE, formatKes as kes, todayInNairobi } from "../../utils/format";

interface CycleFormState {
  name: string;
  description: string;
  notes: string;
  expected_start_date: string;
  expected_end_date: string;
  first_payout_date: string;
  opt_in_deadline: string;
  min_seats: number;
  max_seats: number;
  duration_months: number;
}

interface PayoutFormState {
  actual_date: string;
  amount_paid: string;
  reference_number: string;
  reason: string;
}

export function ChamaManagement({ user }: { user: AuthenticatedUser }) {
  const today = todayInNairobi();
  const [cycles, setCycles] = useState<ChamaCycleSummary[]>([]),
    [selected, setSelected] = useState(""),
    [cycle, setCycle] = useState<ChamaCycle | null>(null),
    [board, setBoard] = useState<ChamaBoard | null>(null),
    [payouts, setPayouts] = useState<ChamaPayout[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [rate, setRate] = useState(""),
    [seats, setSeats] = useState("1"),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState(""),
    [payoutTarget, setPayoutTarget] = useState<ChamaPayout | null>(null),
    [payoutForm, setPayoutForm] = useState<PayoutFormState>({
      actual_date: today,
      amount_paid: "",
      reference_number: "",
      reason: "",
    }),
    [form, setForm] = useState<CycleFormState>({
      name: "",
      description: "",
      notes: "",
      expected_start_date: "",
      expected_end_date: "",
      first_payout_date: "",
      opt_in_deadline: "",
      min_seats: 1,
      max_seats: 10,
      duration_months: 10,
    });
  const coordinator = user.roles.some((role) => ["CHAMA_COORDINATOR", "ADMIN"].includes(role)),
    activeMember = user.member?.status === "ACTIVE";
  const [correctionFor, setCorrectionFor] = useState<ChamaBoard["cards"][number] | null>(null);
  const refresh = useCallback(
    async (id = selected) => {
      setLoading(true);
      setError("");
      try {
        const all = await api<ChamaCycleSummary[]>("/chama/cycles");
        setCycles(all);
        const cycleId = id || all[0]?.id || "";
        setSelected(cycleId);
        if (cycleId) {
          const info = await api<ChamaCycle>(`/chama/cycles/${cycleId}`);
          setCycle(info);
          if (
            [
              "CARD_PICKING_OPEN",
              "CARD_PICKING_CLOSED",
              "RESULTS_REVEALED",
              "PAYOUTS_IN_PROGRESS",
              "COMPLETED",
            ].includes(info.state)
          ) {
            try {
              setBoard(await api<ChamaBoard>(`/chama/cycles/${cycleId}/board`));
            } catch {
              setBoard(null);
            }
          } else setBoard(null);
          if (["RESULTS_REVEALED", "PAYOUTS_IN_PROGRESS", "COMPLETED"].includes(info.state)) {
            try {
              setPayouts(await api<ChamaPayout[]>(`/chama/cycles/${cycleId}/payouts`));
            } catch {
              setPayouts([]);
            }
          } else setPayouts([]);
        } else {
          setCycle(null);
          setBoard(null);
          setPayouts([]);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [selected],
  );
  useEffect(() => {
    refresh("");
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    const es = new EventSource(apiUrl(`/chama/cycles/${selected}/events`), {
      withCredentials: true,
    });
    const update = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setBoard(data);
        api<ChamaCycle>(`/chama/cycles/${selected}`).then(setCycle);
      } catch {
        // Ignore malformed or stale server-sent events; the next event refreshes the board.
      }
    };
    es.addEventListener("ready", update as EventListener);
    es.addEventListener("update", update as EventListener);
    return () => es.close();
  }, [selected, cycle?.state]);
  const act = async (path: string, body: unknown, success: string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setMessage(success);
      await refresh(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await act(
      "/chama/cycles",
      {
        ...form,
        min_seats: +form.min_seats,
        max_seats: +form.max_seats,
        duration_months: +form.duration_months,
      },
      "Cycle created.",
    );
  };
  const transition = async (to_state: string) => {
    if (!cycle) return;
    if (
      to_state === "CANCELLED" &&
      !window.confirm("Cancel this cycle? Participants and picks will remain in the audit history.")
    )
      return;
    await act(
      `/chama/cycles/${cycle.id}/transition`,
      {
        to_state,
        reason: reason || `Coordinator moved cycle to ${to_state}.`,
        ...(to_state === "OPT_IN_OPEN" ? { monthly_amount_per_seat: Number(rate) } : {}),
      },
      `Cycle moved to ${to_state.replaceAll("_", " ")}.`,
    );
    setReason("");
  };
  const optIn = async () => {
    if (!cycle) return;
    await act(
      `/chama/cycles/${cycle.id}/opt-in`,
      { seats: Number(seats), confirmed },
      "Your Chama seat commitment is saved.",
    );
    setConfirmed(false);
  };
  const pick = async (card_id: string) => {
    if (!cycle) return;
    await act(
      `/chama/cycles/${cycle.id}/pick`,
      { card_id, idempotency_key: crypto.randomUUID() },
      "Card selection confirmed.",
    );
  };
  const correct = async (new_card_id: string) => {
    if (!cycle || !correctionFor) return;
    const correctionReason = window.prompt("Explain this exceptional card correction:");
    if (!correctionReason?.trim()) return;
    await act(
      `/chama/cycles/${cycle.id}/selections/${correctionFor.selection_id}/correct`,
      { new_card_id, reason: correctionReason },
      "Card correction recorded and visible to participants.",
    );
    setCorrectionFor(null);
  };
  const payout = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!payoutTarget) return;
    await act(
      `/chama/payouts/${payoutTarget.id}`,
      { status: "PAID", ...payoutForm, amount_paid: Number(payoutForm.amount_paid) },
      "Payout recorded.",
    );
    setPayoutTarget(null);
  };
  const field = (label: string, key: keyof CycleFormState, type = "text") => (
    <Field label={label}>
      <input
        type={type}
        value={form[key]}
        required
        onChange={(event) =>
          setForm({
            ...form,
            [key]: type === "number" ? Number(event.target.value) : event.target.value,
          })
        }
      />
    </Field>
  );
  const stageActions: Record<string, Array<[string, string]>> = {
    DRAFT: [["OPT_IN_OPEN", "Open opt-in"]],
    OPT_IN_OPEN: [["OPT_IN_CLOSED", "Close opt-in"]],
    OPT_IN_CLOSED: [
      ["OPT_IN_OPEN", "Reopen opt-in"],
      ["CARD_PICKING_OPEN", "Open card picking"],
    ],
    CARD_PICKING_OPEN: [["CARD_PICKING_CLOSED", "Close card picking"]],
    CARD_PICKING_CLOSED: [["RESULTS_REVEALED", "Reveal results"]],
    RESULTS_REVEALED: [["PAYOUTS_IN_PROGRESS", "Begin payouts"]],
    PAYOUTS_IN_PROGRESS: [["COMPLETED", "Complete cycle"]],
  };
  if (loading && !cycles.length) return <div className="loading">Loading Chama cycles…</div>;
  return (
    <div className="chama-workspace">
      {error && <div className="form-error">{error}</div>}
      {message && <div className="notice">{message}</div>}
      <div className="chama-top">
        <label className="field">
          <span>CHAMA CYCLE</span>
          <select value={selected} onChange={(e) => refresh(e.target.value)}>
            <option value="">Choose cycle</option>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.state.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        {coordinator && (
          <button className="btn" onClick={() => setCycle(null)}>
            Create cycle
          </button>
        )}
      </div>
      {!cycle && coordinator && (
        <article className="panel">
          <div className="panel-heading">
            <div>
              <h2>Set up a Chama cycle</h2>
              <p>
                Chama contributions and payouts are tracked separately from Royal Barks finances.
              </p>
            </div>
          </div>
          <form className="form-grid invite-form" onSubmit={create}>
            {field("CYCLE NAME", "name")}
            {field("DESCRIPTION", "description")}
            {field("EXPECTED START", "expected_start_date", "date")}
            {field("EXPECTED END", "expected_end_date", "date")}
            {field("FIRST PAYOUT DATE", "first_payout_date", "date")}
            {field("OPT-IN DEADLINE", "opt_in_deadline", "date")}
            {field("MINIMUM SEATS", "min_seats", "number")}
            {field("MAXIMUM SEATS", "max_seats", "number")}
            {field("DURATION · MONTHS", "duration_months", "number")}
            {field("NOTES", "notes")}
            <div className="invite-action">
              <button className="btn primary" disabled={busy}>
                Create draft
              </button>
            </div>
          </form>
        </article>
      )}
      {cycle && (
        <>
          <article className="panel chama-cycle">
            <div className="panel-heading">
              <div>
                <span className="pill neutral">{cycle.state.replaceAll("_", " ")}</span>
                <h2>{cycle.name}</h2>
                <p>{cycle.description}</p>
              </div>
              {coordinator && (
                <button className="btn" onClick={() => refresh(cycle.id)}>
                  Refresh
                </button>
              )}
            </div>
            <div className="chama-stats">
              <div>
                <span>Per seat · per month</span>
                <b>
                  {cycle.monthly_amount_per_seat
                    ? kes(cycle.monthly_amount_per_seat)
                    : "Set when opening opt-in"}
                </b>
              </div>
              <div>
                <span>Cycle</span>
                <b>
                  {dateKE(cycle.expected_start_date)} — {dateKE(cycle.expected_end_date)}
                </b>
              </div>
              <div>
                <span>First payout</span>
                <b>{dateKE(cycle.first_payout_date)}</b>
              </div>
              <div>
                <span>Seat range</span>
                <b>
                  {cycle.min_seats}–{cycle.max_seats}
                </b>
              </div>
            </div>
            {cycle.state === "OPT_IN_OPEN" && cycle.own_registration && (
              <div className="notice">
                Your current registration: {cycle.own_registration.requested_seats} seat(s).
              </div>
            )}
            {coordinator && cycle.state === "OPT_IN_OPEN" && (
              <div className="notice">
                Coordinator view: {cycle.participant_count || 0} registered members. Participant
                names and seat counts are restricted to coordinators until opt-in closes.
              </div>
            )}
          </article>
          {coordinator && cycle.state === "DRAFT" && (
            <article className="panel chama-control">
              <Field label="MONTHLY CONTRIBUTION PER SEAT (KSH)">
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="Enter approved amount"
                />
              </Field>
              <Field label="REASON">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Approved amount and opt-in schedule"
                />
              </Field>
              <button
                className="btn primary"
                disabled={busy || !Number(rate)}
                onClick={() => transition("OPT_IN_OPEN")}
              >
                Open opt-in
              </button>
            </article>
          )}
          {cycle.state === "OPT_IN_OPEN" && activeMember && (
            <article className="panel chama-control">
              <h3>Choose your seats</h3>
              <p>
                Monthly contribution per seat:{" "}
                <b>{kes(Number(cycle.monthly_amount_per_seat || 0))}</b>
              </p>
              <label className="field">
                <span>NUMBER OF SEATS</span>
                <input
                  type="number"
                  min={cycle.min_seats}
                  max={cycle.max_seats}
                  step="1"
                  value={seats}
                  onChange={(e) => setSeats(e.target.value)}
                />
              </label>
              <div className="commitment">
                Your monthly commitment{" "}
                <b>{kes(Number(cycle.monthly_amount_per_seat) * Number(seats || 0))}</b>
              </div>
              <label className="confirm-line">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>I confirm this monthly commitment and seat count.</span>
              </label>
              <button className="btn primary" disabled={busy || !confirmed} onClick={optIn}>
                Confirm seats
              </button>
            </article>
          )}
          {(cycle.participants?.length || 0) > 0 && (
            <article className="panel table-panel">
              <div className="panel-heading">
                <div>
                  <h2>Confirmed participants</h2>
                  <p>Seat counts frozen when opt-in closed.</p>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>MEMBER</th>
                      <th>SEATS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(cycle.participants || []).map((participant) => (
                      <tr key={participant.id}>
                        <td>{participant.member_name}</td>
                        <td>{participant.seats}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}
          {coordinator && (
            <div className="chama-controls">
              {(stageActions[cycle.state] || []).map(([to, label]) => (
                <div className="chama-control" key={to}>
                  {to === "OPT_IN_OPEN" && cycle.state === "OPT_IN_CLOSED" && (
                    <p>
                      No participants registered. Reopen the opt-in period with an optional new
                      deadline.
                    </p>
                  )}
                  {to === "CARD_PICKING_OPEN" && (
                    <p>Opt-in is closed and participant seat counts are frozen.</p>
                  )}
                  {to === "CARD_PICKING_CLOSED" && (
                    <p>Close only after every frozen seat has selected a distinct card.</p>
                  )}
                  {to === "RESULTS_REVEALED" && (
                    <p>Publish payout order by official card number from 1 to N.</p>
                  )}
                  {to === "PAYOUTS_IN_PROGRESS" && (
                    <p>Start tracking payouts in the published order.</p>
                  )}
                  {to === "COMPLETED" && (
                    <p>Complete after every scheduled payout is recorded as paid.</p>
                  )}
                  <Field label="REASON">
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Required audit reason"
                    />
                  </Field>
                  {to === "OPT_IN_OPEN" && cycle.state === "OPT_IN_CLOSED" && (
                    <label className="field">
                      <span>NEW OPT-IN DEADLINE</span>
                      <input
                        type="date"
                        value={form.opt_in_deadline}
                        onChange={(e) => setForm({ ...form, opt_in_deadline: e.target.value })}
                      />
                    </label>
                  )}
                  <button
                    className="btn primary"
                    disabled={
                      busy ||
                      !reason.trim() ||
                      (to === "OPT_IN_OPEN" &&
                        cycle.state === "OPT_IN_CLOSED" &&
                        Boolean(cycle.participant_count))
                    }
                    onClick={() => transition(to)}
                  >
                    {label}
                  </button>
                </div>
              ))}
              {!["COMPLETED", "CANCELLED"].includes(cycle.state) && (
                <div className="chama-control">
                  <Field label="CANCELLATION REASON">
                    <input value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  <button
                    className="btn danger-button"
                    disabled={busy || !reason.trim()}
                    onClick={() => transition("CANCELLED")}
                  >
                    Cancel cycle
                  </button>
                </div>
              )}
            </div>
          )}
          {board && (
            <article className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Live card board</h2>
                  <p>
                    {board.remaining_cards} face-down · {board.selected_count} revealed ·{" "}
                    {board.total_cards} total
                  </p>
                </div>
                <span className="pill neutral">
                  {board.own.picked}/{board.own.seats} of your picks
                </span>
              </div>
              {correctionFor && (
                <div className="notice">
                  Choose a replacement card for {correctionFor.selected_by} · card{" "}
                  {correctionFor.official_number}.{" "}
                  <button className="link-button" onClick={() => setCorrectionFor(null)}>
                    Cancel correction
                  </button>
                </div>
              )}
              <div className="card-board">
                {board.cards.map((card) => (
                  <div className="card-wrap" key={card.card_id}>
                    <button
                      className={`draw-card ${card.selected ? "revealed" : ""}`}
                      disabled={
                        busy ||
                        (correctionFor
                          ? card.card_id === correctionFor.card_id
                          : card.selected ||
                            !board.own.remaining ||
                            cycle.state !== "CARD_PICKING_OPEN")
                      }
                      onClick={() => (correctionFor ? correct(card.card_id) : pick(card.card_id))}
                    >
                      {card.selected ? (
                        <>
                          <b>{card.official_number}</b>
                          <span>{card.selected_by}</span>
                        </>
                      ) : (
                        <>
                          <b>?</b>
                          <span>
                            {correctionFor
                              ? "Use as replacement"
                              : board.own.remaining && cycle.state === "CARD_PICKING_OPEN"
                                ? "Pick card"
                                : "Face down"}
                          </span>
                        </>
                      )}
                    </button>
                    {user.roles.includes("ADMIN") && card.selected && (
                      <button
                        className="row-link correction-link"
                        onClick={() => setCorrectionFor(card)}
                      >
                        Correct selection
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {(board.corrections?.length || 0) > 0 && (
                <div className="notice">
                  Audited card corrections:{" "}
                  {(board.corrections || [])
                    .map(
                      (correction) =>
                        `card ${correction.previous_card_number} → ${correction.replacement_card_number} (${correction.reason})`,
                    )
                    .join(" · ")}
                </div>
              )}
            </article>
          )}
          {payouts.length > 0 && (
            <article className="panel table-panel">
              <div className="panel-heading">
                <div>
                  <h2>Payout schedule</h2>
                  <p>
                    Ordered by official card number. Chama payouts stay separate from ordinary group
                    finances.
                  </p>
                </div>
                <span className="pill neutral">
                  {payouts.filter((payout) => payout.status === "PAID").length} / {payouts.length}{" "}
                  paid
                </span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>POSITION</th>
                      <th>RECIPIENT</th>
                      <th>EXPECTED</th>
                      <th>STATUS</th>
                      <th>ACTUAL DATE</th>
                      <th>REFERENCE</th>
                      {coordinator && <th>ACTION</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((payout) => (
                      <tr key={payout.id}>
                        <td>{payout.official_card_number}</td>
                        <td>{payout.member_name}</td>
                        <td>{dateKE(payout.expected_date)}</td>
                        <td>{payout.status}</td>
                        <td>{payout.actual_date ? dateKE(payout.actual_date) : "—"}</td>
                        <td>{payout.reference_number || "—"}</td>
                        {coordinator && (
                          <td>
                            <button
                              className="row-link"
                              onClick={() => {
                                setPayoutTarget(payout);
                                setPayoutForm({
                                  actual_date: today,
                                  amount_paid: "",
                                  reference_number: "",
                                  reason: "",
                                });
                              }}
                            >
                              Record / update
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}
        </>
      )}
      {payoutTarget && (
        <div className="overlay">
          <form className="dialog" onSubmit={payout}>
            <button type="button" className="close" onClick={() => setPayoutTarget(null)}>
              ×
            </button>
            <h2>Record payout · position {payoutTarget.official_card_number}</h2>
            <p className="dialog-sub">
              {payoutTarget.member_name} · {dateKE(payoutTarget.expected_date)}
            </p>
            <div className="form-grid">
              <Field label="ACTUAL PAYOUT DATE">
                <input
                  type="date"
                  required
                  value={payoutForm.actual_date}
                  onChange={(e) => setPayoutForm({ ...payoutForm, actual_date: e.target.value })}
                />
              </Field>
              <Field label="AMOUNT PAID (KSH)">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={payoutForm.amount_paid}
                  onChange={(e) => setPayoutForm({ ...payoutForm, amount_paid: e.target.value })}
                />
              </Field>
              <Field label="TRANSACTION REFERENCE">
                <input
                  required
                  value={payoutForm.reference_number}
                  onChange={(e) =>
                    setPayoutForm({ ...payoutForm, reference_number: e.target.value })
                  }
                />
              </Field>
              <Field label="NOTE / REASON">
                <input
                  value={payoutForm.reason}
                  onChange={(e) => setPayoutForm({ ...payoutForm, reason: e.target.value })}
                />
              </Field>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setPayoutTarget(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy}>
                Confirm payout
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
