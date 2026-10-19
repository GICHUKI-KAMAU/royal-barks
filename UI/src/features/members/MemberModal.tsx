import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { X } from "lucide-react";
import { Field } from "../../components/common/Field";
import { api } from "../../services/apiClient";
import type { Member, MemberStatusImpact } from "../../types";
import { formatKes as kes, todayInNairobi } from "../../utils/format";

interface MemberFormState {
  name: string;
  status: "ACTIVE" | "DORMANT" | "STATUS TO CONFIRM";
  new_status: "ACTIVE" | "DORMANT" | "STATUS TO CONFIRM";
  effective_date: string;
  reason: string;
  official: string;
  confirmed: boolean;
}

export function MemberModal({
  member,
  close,
  submit,
}: {
  member?: Member;
  close: () => void;
  submit: (path: string, body: unknown, success: string) => Promise<void>;
}) {
  const today = todayInNairobi();
  const [form, setForm] = useState<MemberFormState>({
      name: member?.name || "",
      status: "STATUS TO CONFIRM",
      new_status: "ACTIVE",
      effective_date: today,
      reason: "",
      official: "",
      confirmed: false,
    }),
    [impact, setImpact] = useState<MemberStatusImpact | null>(null),
    [err, setErr] = useState(""),
    [busy, setBusy] = useState(false);
  const change = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value =
      "checked" in e.target && e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm({
      ...form,
      [e.target.name]: value,
    });
  };
  useEffect(() => {
    if (!member) return;
    api<MemberStatusImpact>(
      `/members/${member.id}/status-preview?new_status=${form.new_status}&effective_date=${form.effective_date}`,
    )
      .then(setImpact)
      .catch((error: Error) => setErr(error.message));
  }, [member, form.new_status, form.effective_date]);
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      if (member)
        await submit(
          `/members/${member.id}/status`,
          form,
          "Member status updated. Existing balances and payments remain.",
        );
      else await submit("/members", form, "Member added.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="dialog" onSubmit={save}>
        <button type="button" className="close" onClick={close}>
          <X size={19} />
        </button>
        <h2>{member ? "Change member status" : "Add a member"}</h2>
        <p className="dialog-sub">
          {member
            ? `Update ${member.name}'s status. Financial history is preserved.`
            : "Unclear membership statuses stay marked for confirmation."}
        </p>
        {!member && (
          <Field label="MEMBER NAME">
            <input name="name" required value={form.name} onChange={change} />
          </Field>
        )}
        <div className="form-grid">
          <Field label="STATUS">
            <select
              name={member ? "new_status" : "status"}
              value={member ? form.new_status : form.status}
              onChange={change}
            >
              <option>ACTIVE</option>
              <option>DORMANT</option>
              <option>STATUS TO CONFIRM</option>
            </select>
          </Field>
          <Field label="EFFECTIVE DATE">
            <input
              name="effective_date"
              type="date"
              required
              value={form.effective_date}
              onChange={change}
            />
          </Field>
          <Field label="AUTHORIZED OFFICIAL">
            <input name="official" required value={form.official} onChange={change} />
          </Field>
          <Field label="REASON">
            <input name="reason" required value={form.reason} onChange={change} />
          </Field>
        </div>
        {member && (
          <div className="impact-box">
            <b>Financial impact preview</b>
            {impact ? (
              <>
                <p>
                  Existing opening arrears: <strong>{kes(impact.opening_arrears)}</strong>
                </p>
                <p>
                  Recorded future monthly / meeting obligations:{" "}
                  <strong>{kes(impact.existing_future_obligation_amount)}</strong>
                </p>
                <small>
                  Historical balances and payments remain unchanged. Dormant period charges are not
                  generated.
                </small>
              </>
            ) : (
              <small>Loading impact preview</small>
            )}
          </div>
        )}
        <label className="confirm-line">
          <input type="checkbox" name="confirmed" checked={form.confirmed} onChange={change} />
          <span>
            I confirm this {member ? "status change and its financial impact" : "initial status"}.
          </span>
        </label>
        {err && <div className="form-error">{err}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button disabled={busy} className="btn primary">
            {busy ? "Saving" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
