import { describe, expect, it } from "vitest";
import { buildZip321Uri, parseZec, tryFromZatoshi, zatoshiToZec } from "@/lib/money";

describe("integer money model", () => {
  it("converts eight decimal places to zatoshi without loss", () => {
    expect(parseZec("12.34567891")).toBe(1_234_567_891n);
    expect(zatoshiToZec(1n)).toBe("0.00000001");
    expect(zatoshiToZec(100_000_000n)).toBe("1");
  });

  it("rejects floats, scientific notation, and values with more than eight decimal places", () => {
    expect(() => parseZec("0.000000001")).toThrow();
    expect(() => parseZec("1e-8")).toThrow();
    expect(() => parseZec("-1")).toThrow();
    expect(() => parseZec("21000000.00000001")).toThrow(/MAX_MONEY/);
  });

  it("rounds TRY valuations half-up to integer TRY cents", () => {
    expect(tryFromZatoshi("25000000", 2950)).toBe(73_750);
    expect(tryFromZatoshi("30000", 2950)).toBe(89);
    expect(tryFromZatoshi("6500", 3000)).toBe(20);
  });

  it("places the exact amount and memo in a ZIP-321 URI", () => {
    const uri = buildZip321Uri("utest1example", "123456789", "ZECHLEDGER|ZL-2026-0001|abc");
    expect(uri).toContain("zcash:utest1example?amount=1.23456789&memo=");
    expect(uri).not.toContain("ZECHLEDGER|");
  });
});
