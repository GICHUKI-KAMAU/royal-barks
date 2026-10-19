const categoryLabels: Record<string, string> = {
  paid_monthly: "Monthly contributions paid",
  paid_penalty: "Penalties paid",
  paid_savings_500: "Savings 500 paid",
  paid_food: "Food paid",
  total_paid: "Total paid",
  unpaid_monthly: "Unpaid monthly contributions",
  unpaid_penalty: "Unpaid penalties",
  total_unpaid: "Total unpaid",
  monthly: "Monthly contribution",
  meeting: "Meeting contribution",
  penalty: "Penalty",
  savings_500: 'Savings "500"',
  food: "Food payment",
  other: "Other",
};

export function getCategoryLabel(category: string): string {
  return categoryLabels[category] || category;
}
