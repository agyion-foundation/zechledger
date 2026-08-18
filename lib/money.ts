export const ZATOSHI_PER_ZEC = 100_000_000n;
export const MAX_MONEY_ZATOSHI = 21_000_000n * ZATOSHI_PER_ZEC;

export function parseZec(input: string | number): bigint {
  const raw = String(input).trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(raw)) {
    throw new Error("The ZEC amount must be positive and have no more than 8 decimal places.");
  }
  const [whole, fraction = ""] = raw.split(".");
  const amount = BigInt(whole) * ZATOSHI_PER_ZEC + BigInt(fraction.padEnd(8, "0"));
  if (amount > MAX_MONEY_ZATOSHI) throw new Error("The amount exceeds the Zcash MAX_MONEY limit.");
  return amount;
}

export function zatoshiToZec(value: string | bigint, maxFraction = 8): string {
  const amount = typeof value === "bigint" ? value : BigInt(value || "0");
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / ZATOSHI_PER_ZEC;
  const fraction = (absolute % ZATOSHI_PER_ZEC).toString().padStart(8, "0");
  const trimmed = fraction.slice(0, maxFraction).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

export function zatoshiToNumber(value: string | bigint): number {
  return Number(typeof value === "bigint" ? value : BigInt(value || "0")) / Number(ZATOSHI_PER_ZEC);
}

export function formatZec(value: string | bigint, fractionDigits = 4): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: Math.max(fractionDigits, 8),
  }).format(zatoshiToNumber(value));
}

export function formatTry(kurus: number, compact = false): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: compact ? 0 : 2,
    notation: compact ? "compact" : "standard",
  }).format(kurus / 100);
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  const match = value
    .toString()
    .toLowerCase()
    .match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) throw new Error("The valuation rate is not in canonical decimal format.");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  const digits = BigInt(`${match[1]}${fraction}`);
  const scale = fraction.length - exponent;
  return scale >= 0
    ? { numerator: digits, denominator: 10n ** BigInt(scale) }
    : { numerator: digits * 10n ** BigInt(-scale), denominator: 1n };
}

export function tryFromZatoshi(zatoshi: string | bigint, rateTry: number): number {
  const amount = typeof zatoshi === "bigint" ? zatoshi : BigInt(zatoshi);
  if (amount < 0n || amount > MAX_MONEY_ZATOSHI) throw new Error("The zatoshi amount is outside the valid range.");
  if (!Number.isFinite(rateTry) || rateTry <= 0) throw new Error("The valuation rate must be positive and finite.");
  const rate = decimalFraction(rateTry);
  const numerator = amount * rate.numerator;
  const denominator = 1_000_000n * rate.denominator;
  const kurus = (2n * numerator + denominator) / (2n * denominator);
  if (kurus > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The TRY-cent value exceeds the safe integer range.");
  return Number(kurus);
}

export function percentEncodeMemo(memo: string): string {
  const bytes = new TextEncoder().encode(memo);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildZip321Uri(address: string, zatoshi: string, memo: string): string {
  const amount = zatoshiToZec(zatoshi);
  const encodedMemo = percentEncodeMemo(memo);
  return `zcash:${address}?amount=${amount}&memo=${encodedMemo}`;
}

export function maskAddress(address?: string | null, start = 12, end = 8): string {
  if (!address) return "Address not set";
  if (address.length <= start + end + 3) return address;
  return `${address.slice(0, start)}…${address.slice(-end)}`;
}

export function safeKurusSum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total))
      throw new Error("The accounting total exceeds the safe integer range for TRY cents.");
  }
  return total;
}

export function receiverCapabilityLabel(pool: string): string {
  if (pool === "Shielded") return "Unified receiver set";
  if (pool === "Sapling") return "Sapling address";
  return `${pool} (demo metadata)`;
}

export function netOfVatInclusiveKurus(totalKurus: number, vatRate: number): number {
  if (!Number.isSafeInteger(totalKurus) || totalKurus < 0)
    throw new Error("The VAT-inclusive total must be a safe integer number of TRY cents.");
  if (!Number.isSafeInteger(vatRate) || vatRate < 0 || vatRate > 100)
    throw new Error("The VAT rate must be an integer from 0 to 100.");
  const numerator = BigInt(totalKurus) * 100n;
  const denominator = BigInt(100 + vatRate);
  return Number((2n * numerator + denominator) / (2n * denominator));
}
