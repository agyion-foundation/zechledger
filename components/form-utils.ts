export function localDateInputValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function localMonthInputValue(date = new Date()): string {
  return localDateInputValue(date).slice(0, 7);
}

export function addLocalDays(date: Date, days: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return localDateInputValue(next);
}

export function normalizeDecimalInput(value: string): string {
  return value
    .replace(",", ".")
    .replace(/[^0-9.]/g, "")
    .replace(/(\..*)\./g, "$1");
}

export type FieldErrors = Record<string, string[] | undefined>;

export function firstFieldError(errors: FieldErrors): string | null {
  return Object.keys(errors).find((key) => errors[key]?.length) ?? null;
}
