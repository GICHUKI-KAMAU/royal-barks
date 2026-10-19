const roundMoney = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

export function createFinanceQueries(database, { statuses, reference, statusOn }) {
  function memberSummary(member) {
    const rows = database
      .prepare(
        `SELECT category,'paid_new' kind,SUM(amount) amount
         FROM transactions WHERE member_id=? GROUP BY category
         UNION ALL
         SELECT category,'obligations_new',SUM(amount)
         FROM obligations WHERE member_id=? GROUP BY category
         UNION ALL
         SELECT category,balance_type,SUM(amount)
         FROM opening_balances WHERE member_id=? GROUP BY category,balance_type`,
      )
      .all(member.id, member.id, member.id);
    const categories = {};

    for (const row of rows) {
      const category = (categories[row.category] ||= {
        paid_new: 0,
        obligations_new: 0,
        historical_paid: 0,
        opening_arrears: 0,
        current_due: 0,
      });

      if (row.kind === "paid_new") category.paid_new = roundMoney(row.amount);
      else if (row.kind === "obligations_new") {
        category.obligations_new = roundMoney(row.amount);
      } else if (row.kind === "paid_historical") {
        category.historical_paid = roundMoney(row.amount);
      } else {
        category.opening_arrears = roundMoney(row.amount);
      }
    }

    for (const category of Object.values(categories)) {
      category.current_due = roundMoney(
        category.opening_arrears + category.obligations_new - category.paid_new,
      );
    }

    const statusHistory = database
      .prepare(
        `SELECT previous_status,new_status,effective_date,reason,official,created_at
         FROM status_history WHERE member_id=? ORDER BY effective_date,id`,
      )
      .all(member.id);

    return { ...member, categories, status_history: statusHistory };
  }

  function dashboard() {
    const memberCounts = Object.fromEntries(
      statuses.map((status) => [
        status,
        database.prepare("SELECT COUNT(*) n FROM members WHERE status=?").get(status).n,
      ]),
    );
    const sum = (query) => database.prepare(query).get().n;

    return {
      members: {
        active: memberCounts.ACTIVE,
        dormant: memberCounts.DORMANT,
        confirm: memberCounts["STATUS TO CONFIRM"],
        total: Object.values(memberCounts).reduce((total, count) => total + count, 0),
      },
      new_paid: roundMoney(sum("SELECT COALESCE(SUM(amount),0) n FROM transactions")),
      new_obligations: roundMoney(sum("SELECT COALESCE(SUM(amount),0) n FROM obligations")),
      opening_arrears: roundMoney(
        sum(
          "SELECT COALESCE(SUM(amount),0) n FROM opening_balances WHERE balance_type='opening_arrears'",
        ),
      ),
      reference,
    };
  }

  function report(asOf, memberId = null, memberOnly = false) {
    const allMembers = database.prepare("SELECT * FROM members ORDER BY name COLLATE NOCASE").all();
    const reportMembers = memberOnly
      ? allMembers.filter((member) => member.id === memberId)
      : allMembers;
    const members = reportMembers.map((member) => reportMember(member, asOf));

    return {
      as_of: asOf,
      members,
      opening_balances_are_separate: true,
      transaction_level_history_complete: false,
    };
  }

  function reportMember(member, asOf) {
    const categories = database
      .prepare(
        `SELECT category FROM opening_balances WHERE member_id=? AND statement_date<=?
         UNION
         SELECT category FROM obligations WHERE member_id=? AND obligation_date<=?
         UNION
         SELECT category FROM transactions WHERE member_id=? AND transaction_date<=?`,
      )
      .all(member.id, asOf, member.id, asOf, member.id, asOf)
      .map((row) => row.category);
    const balances = {};

    for (const category of categories) {
      balances[category] = reportCategory(member.id, category, asOf);
    }

    return {
      member_id: member.id,
      member_name: member.name,
      status_as_of: statusOn(member.id, asOf),
      categories: balances,
    };
  }

  function reportCategory(memberId, category, asOf) {
    const opening = database
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN balance_type='paid_historical' THEN amount ELSE 0 END),0)
             historical_paid,
           COALESCE(SUM(CASE WHEN balance_type='opening_arrears' THEN amount ELSE 0 END),0)
             opening_arrears
         FROM opening_balances
         WHERE member_id=? AND category=? AND statement_date<=?`,
      )
      .get(memberId, category, asOf);
    const obligations = database
      .prepare(
        "SELECT COALESCE(SUM(amount),0) n FROM obligations WHERE member_id=? AND category=? AND obligation_date<=?",
      )
      .get(memberId, category, asOf).n;
    const payments = database
      .prepare(
        "SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE member_id=? AND category=? AND transaction_date<=?",
      )
      .get(memberId, category, asOf).n;

    return {
      ...opening,
      obligations,
      payments,
      due: roundMoney(opening.opening_arrears + obligations - payments),
    };
  }

  return { memberSummary, dashboard, report };
}
