import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Field } from "../../components/common/Field";
import { Empty } from "../../components/common/TableFeedback";
import { api } from "../../services/apiClient";
import type { AuthenticatedUser, Member, UserAccount } from "../../types";

export function UserManagement({ user, members }: { user: AuthenticatedUser; members: Member[] }) {
  const [users, setUsers] = useState<UserAccount[]>([]),
    [form, setForm] = useState({ email: "", display_name: "", role: "MEMBER", member_id: "" }),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      setUsers(await api<UserAccount[]>("/users"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (user.roles.includes("ADMIN")) refresh();
  }, [user]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/invitations", {
        method: "POST",
        body: JSON.stringify({ ...form, member_id: form.member_id || null }),
      });
      setMessage("Invitation sent.");
      setForm({ email: "", display_name: "", role: "MEMBER", member_id: "" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changeRole = async (id: number, role: string, remove: boolean) => {
    setError("");
    try {
      await api(`/users/${id}/roles`, { method: "POST", body: JSON.stringify({ role, remove }) });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const accountAction = async (id: number, action: "suspend" | "reactivate") => {
    setError("");
    try {
      await api(`/users/${id}/${action}`, { method: "POST", body: "{}" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const transfer = async (id: number, name: string) => {
    if (
      !window.confirm(
        `Transfer the single Admin role to ${name}? You will lose Admin access immediately.`,
      )
    )
      return;
    try {
      await api("/admin/transfer", {
        method: "POST",
        body: JSON.stringify({ target_profile_id: id }),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!user.roles.includes("ADMIN"))
    return (
      <article className="panel">
        <div className="notice">
          <ShieldCheck size={16} /> User and role administration is restricted to the active Admin.
        </div>
      </article>
    );
  return (
    <div className="user-admin">
      <article className="panel">
        <div className="panel-heading">
          <div>
            <h2>Invite an account</h2>
            <p>
              Invited people activate their account using a one-time email link. Passwords are never
              shared by officials.
            </p>
          </div>
        </div>
        <form className="form-grid invite-form" onSubmit={submit}>
          <Field label="DISPLAY NAME">
            <input
              required
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            />
          </Field>
          <Field label="EMAIL ADDRESS">
            <input
              required
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="ROLE">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option>MEMBER</option>
              <option>TREASURER</option>
              <option>CHAMA_COORDINATOR</option>
            </select>
          </Field>
          <Field label="LINK TO MEMBER (OPTIONAL)">
            <select
              value={form.member_id}
              onChange={(e) => setForm({ ...form, member_id: e.target.value })}
            >
              <option value="">No member linked</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.status}
                </option>
              ))}
            </select>
          </Field>
          <div className="invite-action">
            <button className="btn primary" disabled={busy}>
              {busy ? "Sending…" : "Send invitation"}
            </button>
          </div>
        </form>
        {error && <div className="form-error">{error}</div>}
        {message && <div className="notice">{message}</div>}
      </article>
      <article className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h2>Accounts and roles</h2>
            <p>Account access is independent from member status and financial history.</p>
          </div>
          <button className="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>PERSON</th>
                <th>MEMBER LINK</th>
                <th>ACCOUNT</th>
                <th>ROLES</th>
                <th>ACCESS</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="member-name">
                    {u.display_name}
                    <small>
                      {u.email} · verified {u.email_verified_at ? "yes" : "no"}
                    </small>
                  </td>
                  <td>
                    {u.member_id
                      ? members.find((m) => m.id === u.member_id)?.name || `Member #${u.member_id}`
                      : "Not linked"}
                  </td>
                  <td>{u.account_status}</td>
                  <td>{u.roles.join(", ")}</td>
                  <td>
                    <div className="user-actions">
                      {u.id !== user.id && (
                        <>
                          <select
                            aria-label={`Assign role to ${u.display_name}`}
                            defaultValue=""
                            onChange={(e) => {
                              if (e.target.value) changeRole(u.id, e.target.value, false);
                              e.target.value = "";
                            }}
                          >
                            <option value="">Add role…</option>
                            <option>TREASURER</option>
                            <option>CHAMA_COORDINATOR</option>
                            <option>MEMBER</option>
                          </select>
                          {u.roles
                            .filter((r: string) => r !== "ADMIN")
                            .map((r: string) => (
                              <button
                                className="row-link"
                                key={r}
                                onClick={() => changeRole(u.id, r, true)}
                              >
                                Remove {r}
                              </button>
                            ))}
                          <button
                            className="row-link"
                            onClick={() =>
                              accountAction(
                                u.id,
                                u.account_status === "SUSPENDED" ? "reactivate" : "suspend",
                              )
                            }
                          >
                            {u.account_status === "SUSPENDED" ? "Reactivate" : "Suspend"}
                          </button>
                          {!u.roles.includes("ADMIN") &&
                            u.account_status === "ACTIVE" &&
                            u.email_verified_at && (
                              <button
                                className="row-link"
                                onClick={() => transfer(u.id, u.display_name)}
                              >
                                Transfer Admin
                              </button>
                            )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!users.length && <Empty col={5} text="No accounts available." />}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
