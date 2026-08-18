export const EXPENSE_ACCOUNT_POLICY = "all-expenses-740/v1" as const;

export function expenseAccountCode(category: string): "740" {
  void category;
  return "740";
}
