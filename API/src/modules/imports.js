import { createHash } from "node:crypto";
import { MEMBERSHIP_STATUSES } from "../../../shared/contracts.js";

export const REFERENCE = {
  paid_monthly: 206300,
  paid_penalty: 24850,
  paid_savings_500: 95200,
  paid_food: 98500,
  total_paid: 415650,
  unpaid_monthly: 171100,
  unpaid_penalty: 45400,
  total_unpaid: 216500,
  cash: 79732.7,
};
const IMPORT_FIELDS = [
  "paid_monthly",
  "paid_penalty",
  "paid_savings_500",
  "paid_food",
  "unpaid_monthly",
  "unpaid_penalty",
  "other_balance",
  "total_historical",
  "total_paid",
  "total_unpaid",
];

export function createImportService({ db, now, required, validDate, money, log, fail }) {
  function importPreview(p) {
    const statementDate = validDate(p.statement_date, "Statement date"),
      source = required(p.source, "Import source"),
      importedBy = required(p.imported_by, "Importing official"),
      reviewedBy = required(p.reviewed_by, "Reviewer"),
      approvedBy = required(p.approved_by, "Approver");
    if (reviewedBy === approvedBy) fail(400, "Reviewer and approver must be different officials.");
    if (!Array.isArray(p.rows) || !p.rows.length) fail(400, "Import must contain member rows.");
    const statementTotals = Object.fromEntries(
      IMPORT_FIELDS.filter((field) =>
        [
          "paid_monthly",
          "paid_penalty",
          "paid_savings_500",
          "paid_food",
          "total_paid",
          "unpaid_monthly",
          "unpaid_penalty",
          "total_unpaid",
        ].includes(field),
      ).map((field) => {
        const value = p.statement_totals?.[field];
        return [
          field,
          value === undefined ||
          value === null ||
          String(value).trim() === "" ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0
            ? null
            : money(value),
        ];
      }),
    );
    const aggregateRows = Array.isArray(p.aggregate_rows)
      ? p.aggregate_rows.map((row) => ({
          member_name: String(row.member_name || "Others"),
          amounts: Object.fromEntries(
            IMPORT_FIELDS.map((field) => [
              field,
              row[field] === undefined ||
              row[field] === null ||
              String(row[field]).trim() === "" ||
              !Number.isFinite(Number(row[field])) ||
              Number(row[field]) < 0
                ? null
                : money(row[field]),
            ]),
          ),
        }))
      : [];
    const fields = [
      "paid_monthly",
      "paid_penalty",
      "paid_savings_500",
      "paid_food",
      "unpaid_monthly",
      "unpaid_penalty",
      "other_balance",
      "total_historical",
      "total_paid",
      "total_unpaid",
    ];
    const existing = new Set(
      db
        .prepare("SELECT name FROM members")
        .all()
        .map((x) => x.name.toLocaleLowerCase()),
    );
    const names = new Set();
    const rows = [];
    for (const raw of p.rows) {
      const name = String(raw.member_name || raw.name || "").trim();
      if (!name) continue;
      if (names.has(name.toLocaleLowerCase()))
        fail(400, `Duplicate member row in import: ${name}.`);
      names.add(name.toLocaleLowerCase());
      let status = String(raw.existing_status || raw.status || "STATUS TO CONFIRM")
        .trim()
        .toUpperCase();
      if (!MEMBERSHIP_STATUSES.includes(status)) {
        status = "STATUS TO CONFIRM";
      }
      const row = { member_name: name, existing_status: status },
        issues = [];
      if (status === "STATUS TO CONFIRM") issues.push("Missing or unclear membership status");
      for (const key of fields) {
        const value = raw[key];
        row[key] =
          value === undefined ||
          value === null ||
          String(value).trim() === "" ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0
            ? null
            : money(value);
        if (row[key] === null && !["other_balance", "total_historical"].includes(key))
          issues.push(`Missing amount: ${key}`);
      }
      if (row.total_historical === null && row.total_paid !== null && row.total_unpaid !== null) {
        row.total_historical = money(row.total_paid + row.total_unpaid);
        issues.push("Total historical calculated from reported paid and unpaid totals");
      } else if (row.total_historical === null) issues.push("Missing amount: total_historical");
      if (row.paid_savings_500 !== null)
        issues.push('Confirm accounting treatment of original Savings "500" label');
      if (row.other_balance === null) issues.push("Other balance not specified; confirm if none");
      if (existing.has(name.toLocaleLowerCase()))
        issues.push("Member already exists; verify identity before posting");
      const all = (keys) => keys.every((k) => row[k] !== null);
      if (
        all(["paid_monthly", "paid_penalty", "paid_savings_500", "paid_food", "total_paid"]) &&
        Math.abs(
          row.paid_monthly +
            row.paid_penalty +
            row.paid_savings_500 +
            row.paid_food -
            row.total_paid,
        ) > 0.01
      )
        issues.push("Total paid does not match category paid amounts");
      if (
        all(["unpaid_monthly", "unpaid_penalty", "total_unpaid"]) &&
        Math.abs(
          row.unpaid_monthly + row.unpaid_penalty + (row.other_balance || 0) - row.total_unpaid,
        ) > 0.01
      )
        issues.push("Total unpaid does not match category balances");
      if (
        all(["total_paid", "total_unpaid", "total_historical"]) &&
        Math.abs(row.total_paid + row.total_unpaid - row.total_historical) > 0.01
      )
        issues.push("Historical total does not equal paid plus unpaid");
      row.issues = issues;
      rows.push(row);
    }
    if (!rows.length) fail(400, "No named member rows found.");
    const fieldsToMatch = [
      "paid_monthly",
      "paid_penalty",
      "paid_savings_500",
      "paid_food",
      "total_paid",
      "unpaid_monthly",
      "unpaid_penalty",
      "total_unpaid",
    ];
    const reconciliation = fieldsToMatch.map((field) => {
      const imported = money(
          rows.reduce((s, r) => s + (r[field] || 0), 0) +
            aggregateRows.reduce((s, r) => s + (r.amounts[field] || 0), 0),
        ),
        reference = statementTotals[field] ?? REFERENCE[field];
      return {
        category: field,
        imported,
        reference,
        difference: money(imported - reference),
        status: Math.abs(imported - reference) <= 0.01 ? "MATCH" : "REVIEW",
      };
    });
    const fingerprintRows = rows.map((row) => {
      const fingerprintRow = { ...row };
      delete fingerprintRow.issues;
      return fingerprintRow;
    });
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          date: statementDate,
          rows: fingerprintRows,
          statementTotals,
          aggregateRows,
        }),
      )
      .digest("hex");
    const supplemental = {
      statement_totals: statementTotals,
      aggregate_rows: aggregateRows,
      reported_cash: REFERENCE.cash,
    };
    return {
      statementDate,
      source,
      importedBy,
      reviewedBy,
      approvedBy,
      rows,
      reconciliation,
      supplemental,
      fingerprint,
      duplicate: Boolean(db.prepare("SELECT 1 FROM imports WHERE fingerprint=?").get(fingerprint)),
    };
  }

  function postImport(p) {
    if (p.confirmed !== true)
      fail(400, "Confirm that the import review is complete before posting.");
    const preview = importPreview(p);
    if (preview.duplicate) fail(409, "This statement import has already been posted.");
    const insertImport = db.prepare(
      "INSERT INTO imports(fingerprint,statement_date,source,imported_by,reviewed_by,approved_by,status,reference_json,reconciliation_json,supplemental_json,created_at) VALUES(?,?,?,?,?,?,'APPROVED',?,?,?,?)",
    );
    const insertMember = db.prepare("INSERT INTO members(name,status,created_at) VALUES(?,?,?)");
    const insertStatus = db.prepare(
      "INSERT INTO status_history(member_id,previous_status,new_status,effective_date,reason,official,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const insertRow = db.prepare(
      "INSERT INTO import_rows(import_id,member_name,existing_status,amounts_json,verification_status,issues_json) VALUES(?,?,?,?,?,?)",
    );
    const insertBalance = db.prepare(
      "INSERT INTO opening_balances(import_row_id,member_id,category,amount,balance_type,statement_date,source) VALUES(?,?,?,?,?,?,?)",
    );
    const categories = {
      paid_monthly: "monthly",
      paid_penalty: "penalty",
      paid_savings_500: 'Savings "500"',
      paid_food: "food",
      unpaid_monthly: "monthly",
      unpaid_penalty: "penalty",
      other_balance: "other",
    };
    const action = db.transaction(() => {
      const result = insertImport.run(
        preview.fingerprint,
        preview.statementDate,
        preview.source,
        preview.importedBy,
        preview.reviewedBy,
        preview.approvedBy,
        JSON.stringify(REFERENCE),
        JSON.stringify(preview.reconciliation),
        JSON.stringify(preview.supplemental),
        now(),
      );
      const importId = Number(result.lastInsertRowid);
      db.prepare(
        "INSERT INTO import_approvals(import_id,imported_by_profile_id,reviewed_by_profile_id,approved_by_profile_id) VALUES(?,?,?,?)",
      ).run(importId, p.imported_by_profile_id, p.reviewed_by_profile_id, p.approved_by_profile_id);
      for (const row of preview.rows) {
        let member = db
            .prepare("SELECT id FROM members WHERE name=? COLLATE NOCASE")
            .get(row.member_name),
          memberId;
        if (member) memberId = member.id;
        else {
          memberId = Number(
            insertMember.run(row.member_name, row.existing_status, now()).lastInsertRowid,
          );
          insertStatus.run(
            memberId,
            "NONE",
            row.existing_status,
            preview.statementDate,
            "Imported historical status",
            preview.approvedBy,
            now(),
          );
        }
        const amounts = Object.fromEntries(IMPORT_FIELDS.map((k) => [k, row[k]]));
        const importRowId = Number(
          insertRow.run(
            importId,
            row.member_name,
            row.existing_status,
            JSON.stringify(amounts),
            row.issues.length ? "REVIEWED" : "VERIFIED",
            JSON.stringify(row.issues),
          ).lastInsertRowid,
        );
        for (const [key, category] of Object.entries(categories)) {
          const amount = row[key];
          if (amount === null || amount === 0) continue;
          insertBalance.run(
            importRowId,
            memberId,
            category,
            amount,
            key.startsWith("paid_") ? "paid_historical" : "opening_arrears",
            preview.statementDate,
            preview.source,
          );
        }
      }
      log("historical_import_approved", preview.approvedBy, "import", importId, {
        source: preview.source,
        statement_date: preview.statementDate,
        imported_by: preview.importedBy,
        reviewed_by: preview.reviewedBy,
        approved_by: preview.approvedBy,
        rows: preview.rows.length,
      });
      return {
        id: importId,
        status: "APPROVED",
        rows: preview.rows.length,
        reference_is_income: false,
      };
    });
    return action();
  }

  return { preview: importPreview, post: postImport };
}
