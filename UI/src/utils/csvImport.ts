export type CsvRecord = Record<string, string>;

export interface FinancialCsvImport {
  rows: CsvRecord[];
  statement_totals: CsvRecord | null;
  aggregate_rows: CsvRecord[];
}

export function parseFinancialCsv(input: string): FinancialCsvImport {
  const lines = input.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { rows: [], statement_totals: null, aggregate_rows: [] };
  }

  const parseLine = (line: string): string[] => {
    const values: string[] = [];
    let value = "";
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '"' && line[index + 1] === '"' && quoted) {
        value += '"';
        index += 1;
      } else if (line[index] === '"') {
        quoted = !quoted;
      } else if (line[index] === "," && !quoted) {
        values.push(value.trim());
        value = "";
      } else {
        value += line[index];
      }
    }

    values.push(value.trim());
    return values;
  };

  const aliases: Record<string, string> = {
    membername: "member_name",
    name: "member_name",
    status: "existing_status",
    existingstatus: "existing_status",
    monthlycontributionspaid: "paid_monthly",
    paidmonthly: "paid_monthly",
    penaltiespaid: "paid_penalty",
    paidpenalty: "paid_penalty",
    savings500paid: "paid_savings_500",
    paidsavings500: "paid_savings_500",
    foodpaid: "paid_food",
    paidfood: "paid_food",
    totalpaid: "total_paid",
    unpaidmonthlycontributions: "unpaid_monthly",
    unpaidmonthly: "unpaid_monthly",
    unpaidpenalties: "unpaid_penalty",
    unpaidpenalty: "unpaid_penalty",
    totalunpaidamountpayable: "total_unpaid",
    totalunpaid: "total_unpaid",
    totalhistorical: "total_historical",
    otherbalance: "other_balance",
  };

  const normalizeHeader = (header: string): string => {
    const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, "");
    return aliases[normalized] || header.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  };

  const headers = parseLine(lines[0]);
  const normalizedHeaders = headers.map(normalizeHeader);
  const rows: CsvRecord[] = [];
  const aggregateRows: CsvRecord[] = [];
  let statementTotals: CsvRecord | null = null;

  for (const line of lines.slice(1).filter(Boolean)) {
    const values = parseLine(line);
    const row = Object.fromEntries(
      normalizedHeaders.map((header, index) => [header, values[index] || ""]),
    ) as CsvRecord;
    const name = (row.member_name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

    if (name === "total_as_reported") {
      statementTotals = row;
    } else if (name === "others") {
      aggregateRows.push(row);
    } else if (name) {
      rows.push(row);
    }
  }

  return {
    rows,
    statement_totals: statementTotals,
    aggregate_rows: aggregateRows,
  };
}
