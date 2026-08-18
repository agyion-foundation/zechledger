import { describe, expect, it } from "vitest";
import { csvCell } from "@/lib/csv";

describe("CSV formula injection guard", () => {
  it.each(['=WEBSERVICE("x")', "+cmd", "-2+3", " @SUM(A1)"])("forces the %s cell to text", (value) => {
    expect(csvCell(value)).toContain("'");
  });
  it("escapes quotes according to RFC 4180", () => expect(csvCell('A "B"')).toBe('"A ""B"""'));
});
