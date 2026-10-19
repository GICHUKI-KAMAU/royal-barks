import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { CircleHelp, FileUp, X } from "lucide-react";
import { Field } from "../../components/common/Field";
import { Status } from "../../components/common/Status";
import { api } from "../../services/apiClient";
import type { FinancialImportPreview, FinancialImportReview, Member } from "../../types";
import { getCategoryLabel as category } from "../../utils/categories";
import { formatKes as kes, todayInNairobi } from "../../utils/format";
import { parseFinancialCsv } from "../../utils/csvImport";

interface EntryFormState {
  source_key: string;
  member_id: string;
  category: string;
  amount: string;
  transaction_date: string;
  obligation_date: string;
  month: string;
  meeting_date: string;
  title: string;
  official: string;
  contribution: number;
  statement_date: string;
  source: string;
  imported_by: string;
  reviewed_by: string;
  approved_by: string;
  csvtext: string;
  food_rule_confirmed: boolean;
  confirmed: boolean;
  note?: string;
  attendance?: Record<number, boolean>;
}

export function EntryModal({
  type,
  members,
  close,
  submit,
  preview,
  setPreview,
  busy,
}: {
  type: string;
  members: Member[];
  close: () => void;
  submit: (path: string, body: unknown, success: string) => Promise<void>;
  preview: FinancialImportReview | null;
  setPreview: (review: FinancialImportReview | null) => void;
  busy: boolean;
}) {
  const today = todayInNairobi();
  const [form, setForm] = useState<EntryFormState>({
      source_key: crypto.randomUUID(),
      member_id: "",
      category: type === "payment" ? "monthly" : "food",
      amount: "",
      transaction_date: today,
      obligation_date: today,
      month: today.slice(0, 7),
      meeting_date: today,
      title: "Member meeting",
      official: "",
      contribution: 500,
      statement_date: "2026-04-30",
      source: "April 2026 financial statement",
      imported_by: "",
      reviewed_by: "",
      approved_by: "",
      csvtext: "",
      food_rule_confirmed: false,
      confirmed: false,
    }),
    [err, setErr] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const change = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value =
      "checked" in e.target && e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm({
      ...form,
      [e.target.name]: value,
    });
  };
  const field = (label: string, name: string, placeholder = "", type = "text", required = true) => {
    const currentValue = form[name as keyof EntryFormState];
    const inputValue =
      typeof currentValue === "boolean" || typeof currentValue === "object"
        ? ""
        : (currentValue ?? "");

    return (
      <Field label={label}>
        <input
          name={name}
          type={type}
          placeholder={placeholder}
          value={inputValue}
          onChange={change}
          required={required}
        />
      </Field>
    );
  };
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErr("");
    try {
      if (type === "payment")
        return await submit(
          "/payments",
          { ...form, member_id: +form.member_id, amount: +form.amount },
          "Payment recorded.",
        );
      if (type === "obligation")
        return await submit(
          "/obligations",
          { ...form, member_id: +form.member_id, amount: +form.amount },
          "Obligation recorded.",
        );
      if (type === "batch")
        return await submit(
          "/obligations/monthly",
          { ...form, amount: +form.amount },
          "Monthly obligations generated for eligible members.",
        );
      if (type === "meeting")
        return await submit("/meetings", { ...form, official: form.official }, "Meeting recorded.");
      const parsed = parseFinancialCsv(form.csvtext);
      if (!parsed.rows.length) throw Error("Add or upload a CSV with member rows.");
      const data = {
        statement_date: form.statement_date,
        source: form.source,
        imported_by: form.imported_by,
        reviewed_by: form.reviewed_by,
        approved_by: form.approved_by,
        rows: parsed.rows,
        statement_totals: parsed.statement_totals,
        aggregate_rows: parsed.aggregate_rows,
        confirmed: form.confirmed,
      };
      if (!reviewed) {
        const p = await api<FinancialImportPreview>("/imports/preview", {
          method: "POST",
          body: JSON.stringify(data),
        });
        setPreview({ ...p, payload: data });
        setReviewed(true);
        return;
      }
      if (!form.confirmed) throw Error("Confirm the reviewed rows before posting.");
      return await submit("/imports", data, "Historical import posted as opening records.");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const title = (
    {
      payment: "Record payment",
      obligation: "Record obligation",
      batch: "Generate monthly obligations",
      meeting: "Record a meeting",
      import: "Import historical statement",
    } as Record<string, string>
  )[type];
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="dialog wide-dialog" onSubmit={save}>
        <button type="button" className="close" onClick={close}>
          <X size={19} />
        </button>
        <h2>{title}</h2>
        <p className="dialog-sub">
          {type === "import"
            ? "Review flagged records before creating opening balances."
            : type === "meeting"
              ? "Attendance is separate from the KSh 500 contribution obligation."
              : type === "obligation"
                ? "Food eligibility must be confirmed for each manually recorded food obligation."
                : "Financial records are dated and attributed to an official."}
        </p>
        {["payment", "obligation"].includes(type) && (
          <>
            <div className="form-grid">
              <Field label="MEMBER">
                <select name="member_id" required value={form.member_id} onChange={change}>
                  <option value="">Choose member</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.status}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="CATEGORY">
                <select name="category" value={form.category} onChange={change}>
                  {(type === "payment"
                    ? ["monthly", "meeting", "penalty", "savings_500", "food", "other"]
                    : ["monthly", "meeting", "penalty", "food", "other"]
                  ).map((c) => (
                    <option key={c} value={c}>
                      {category(c)}
                    </option>
                  ))}
                </select>
              </Field>
              {field("AMOUNT (KSH)", "amount", "0.00", "number")}
              {field(
                "DATE",
                type === "payment" ? "transaction_date" : "obligation_date",
                "",
                "date",
              )}
              {field("AUTHORIZED OFFICIAL", "official")}
              {field("NOTE", "note", "Optional", "text", false)}
            </div>
            {type === "obligation" && form.category === "food" && (
              <label className="confirm-line">
                <input
                  type="checkbox"
                  name="food_rule_confirmed"
                  checked={form.food_rule_confirmed}
                  onChange={change}
                />
                <span>I confirmed the approved food eligibility rule.</span>
              </label>
            )}
          </>
        )}
        {type === "batch" && (
          <div className="form-grid">
            {field("MONTH", "month", "", "month")}
            {field("MONTHLY CONTRIBUTION (KSH)", "amount", "1000", "number")}
            {field("AUTHORIZED OFFICIAL", "official")}
          </div>
        )}
        {type === "meeting" && (
          <>
            <div className="form-grid">
              {field("MEETING DATE", "meeting_date", "", "date")}
              {field("TITLE", "title")}
              {field("KSH 500 CONTRIBUTION", "contribution", "500", "number")}
              {field("AUTHORIZED OFFICIAL", "official")}
            </div>
            <div className="attendance-editor">
              <b>Attendance</b>
              <small>
                Attendance is stored separately and does not determine contribution eligibility.
              </small>
              {members.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    checked={Boolean(form.attendance?.[m.id])}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        attendance: { ...form.attendance, [m.id]: e.target.checked },
                      })
                    }
                  />
                  <span>{m.name}</span>
                  <Status value={m.status} />
                </label>
              ))}
            </div>
          </>
        )}
        {type === "import" && (
          <>
            <div className="form-grid">
              {field("STATEMENT DATE", "statement_date", "", "date")}
              {field("IMPORT SOURCE", "source")}
              {field("IMPORTED BY", "imported_by")}
              {field("REVIEWED BY", "reviewed_by")}
              {field("APPROVED BY", "approved_by")}
            </div>
            <Field label="MEMBER ROWS  CSV">
              <textarea
                name="csvtext"
                placeholder='Member Name,Status,Monthly Contributions Paid,Penalties Paid,"Savings ""500"" Paid",Food Paid,Total Paid,Unpaid Monthly Contributions,Unpaid Penalties,Total Unpaid Amount Payable'
                value={form.csvtext}
                onChange={change}
              />
            </Field>
            <label className="file-pick">
              <FileUp size={15} /> Choose CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setForm({ ...form, csvtext: await f.text() });
                }}
              />
            </label>
            {reviewed && preview && (
              <>
                <div className="import-review">
                  <b>
                    {preview.rows.length} member rows{" "}
                    {preview.duplicate ? "Already imported" : "ready for review"}
                  </b>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>MEMBER</th>
                          <th>STATUS</th>
                          <th>PAID</th>
                          <th>UNPAID</th>
                          <th>REVIEW FLAGS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, index) => (
                          <tr key={index}>
                            <td>{row.member_name}</td>
                            <td>{row.existing_status}</td>
                            <td>{kes(row.total_paid || 0)}</td>
                            <td>{kes(row.total_unpaid || 0)}</td>
                            <td className="flag-cell">{row.issues.join("; ") || "Clear"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="import-review">
                  <b>April statement reconciliation</b>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>CATEGORY</th>
                          <th>IMPORTED</th>
                          <th>STATEMENT</th>
                          <th>DIFFERENCE</th>
                          <th>REVIEW</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.reconciliation.map((row) => (
                          <tr key={row.category}>
                            <td>{category(row.category)}</td>
                            <td>{kes(row.imported)}</td>
                            <td>{kes(row.reference)}</td>
                            <td>{kes(row.difference)}</td>
                            <td className={row.status === "MATCH" ? "match-cell" : "flag-cell"}>
                              {row.status}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <small>
                    Reported cash: {kes(preview.reference.cash)}. Cash is reviewed separately and is
                    not reconciled to member balances.
                  </small>
                </div>
                {preview.supplemental.aggregate_rows.length > 0 && (
                  <div className="notice">
                    <CircleHelp size={15} /> The “Others” line is preserved as an unallocated group
                    total, not added as a member:{" "}
                    {preview.supplemental.aggregate_rows.map((row) => (
                      <span key={row.member_name}>
                        {" "}
                        {row.member_name} · {kes(Number(row.paid_food || 0))} food paid
                      </span>
                    ))}
                    . Review before approval.
                  </div>
                )}
                <label className="confirm-line">
                  <input
                    type="checkbox"
                    name="confirmed"
                    checked={form.confirmed}
                    onChange={change}
                  />
                  <span>
                    I reviewed the flagged rows. Savings "500" retains its source label; statement
                    references are not income.
                  </span>
                </label>
              </>
            )}
          </>
        )}
        {err && <div className="form-error">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button disabled={busy || Boolean(preview?.duplicate)} className="btn primary">
            {busy
              ? "Saving"
              : type === "import" && !reviewed
                ? "Review import"
                : type === "import"
                  ? "Approve & post"
                  : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
