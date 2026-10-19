import { useEffect, useState } from "react";
import { Empty } from "../../components/common/TableFeedback";
import { Status } from "../../components/common/Status";
import { api } from "../../services/apiClient";
import type { FinancialReport } from "../../types";
import { formatKenyanDate as dateKE, formatKes as kes, todayInNairobi } from "../../utils/format";

export function ReportsView({ canViewGroupFinances }: { canViewGroupFinances: boolean }) {
  const today = todayInNairobi();
  const [report, setReport] = useState<FinancialReport | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [asOf, setAsOf] = useState(today);
  useEffect(() => {
    setLoading(true);
    api<FinancialReport>(`/report?as_of=${asOf}`)
      .then(setReport)
      .catch((error: Error) => setError(error.message))
      .finally(() => setLoading(false));
  }, [asOf]);
  const totalFor = (
    member: FinancialReport["members"][number],
    key: keyof FinancialReport["members"][number]["categories"][string],
  ) => Object.values(member.categories).reduce((sum, category) => sum + category[key], 0);
  return (
    <article className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Financial position</h2>
          <p>
            {canViewGroupFinances
              ? "Opening balances and later transactions are shown separately."
              : "Your own statement as of the selected date."}
          </p>
        </div>
        <label className="field">
          <span>AS OF</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>
      {loading ? (
        <div className="loading">Preparing report…</div>
      ) : error ? (
        <div className="form-error">{error}</div>
      ) : (
        <>
          <div className="notice">
            Historical opening balances are not a transaction-level audit trail. Figures reflect
            data entered through {dateKE(report?.as_of || asOf)}.
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>MEMBER</th>
                  <th>STATUS</th>
                  <th>HISTORICAL PAID</th>
                  <th>OPENING ARREARS</th>
                  <th>NEW OBLIGATIONS</th>
                  <th>NEW PAYMENTS</th>
                  <th>CURRENT DUE</th>
                </tr>
              </thead>
              <tbody>
                {report?.members.map((m) => (
                  <tr key={m.member_id}>
                    <td className="member-name">{m.member_name}</td>
                    <td>
                      <Status value={m.status_as_of} />
                    </td>
                    <td>{kes(totalFor(m, "historical_paid"))}</td>
                    <td>{kes(totalFor(m, "opening_arrears"))}</td>
                    <td>{kes(totalFor(m, "obligations"))}</td>
                    <td>{kes(totalFor(m, "payments"))}</td>
                    <td className="bold">{kes(totalFor(m, "due"))}</td>
                  </tr>
                ))}
                {!report?.members.length && (
                  <Empty col={7} text="No reportable records for this date." />
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}
