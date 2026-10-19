import { useState } from "react";
import { Status } from "../../components/common/Status";
import { api } from "../../services/apiClient";
import { formatKes as kes } from "../../utils/format";
import type { FinancialReport } from "../../types";

export function HistoricalReport() {
  const [asOf, setAsOf] = useState("2026-04-30"),
    [data, setData] = useState<FinancialReport | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setData(await api<FinancialReport>(`/report?as_of=${asOf}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="panel historical-report">
      <div className="panel-heading">
        <div>
          <h2>Recreate balances as of a date</h2>
          <p>
            Opening balances, obligations, payments, and status are evaluated at the selected date.
          </p>
        </div>
        <div className="report-controls">
          <input
            aria-label="Report date"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? "Loading" : "View report"}
          </button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {data && (
        <>
          <div className="notice">
            This report preserves imported opening balances separately. The source statement does
            not include transaction level history.
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>MEMBER</th>
                  <th>STATUS ON DATE</th>
                  <th>OPENING ARREARS</th>
                  <th>NEW OBLIGATIONS</th>
                  <th>PAYMENTS</th>
                  <th>ESTIMATED DUE</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => (
                  <tr key={member.member_id}>
                    <td className="member-name">{member.member_name}</td>
                    <td>
                      <Status value={member.status_as_of} />
                    </td>
                    <td>
                      {kes(
                        Object.values(member.categories).reduce(
                          (sum, category) => sum + category.opening_arrears,
                          0,
                        ),
                      )}
                    </td>
                    <td>
                      {kes(
                        Object.values(member.categories).reduce(
                          (sum, category) => sum + category.obligations,
                          0,
                        ),
                      )}
                    </td>
                    <td>
                      {kes(
                        Object.values(member.categories).reduce(
                          (sum, category) => sum + category.payments,
                          0,
                        ),
                      )}
                    </td>
                    <td className="bold">
                      {kes(
                        Object.values(member.categories).reduce(
                          (sum, category) => sum + category.due,
                          0,
                        ),
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}
