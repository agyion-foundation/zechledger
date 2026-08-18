import { describe, expect, it } from "vitest";
import {
  canonicalShieldedTestnetAddress,
  isShieldedTestnetAddress,
  shieldedTestnetAddressKind,
} from "@/lib/zcash-address";

describe("Zcash testnet address safety lock", () => {
  it("accepts a checksum-valid testnet Sapling address", () => {
    const address = "ztestsapling1knww2nyjc62njkard0jmx7hlsj6twxmxwprn7anvrv4dc2zxanl3nemc0qx2hvplxmd2uau8gyw";
    expect(isShieldedTestnetAddress(address)).toBe(true);
    expect(shieldedTestnetAddressKind(address)).toBe("sapling");
    expect(canonicalShieldedTestnetAddress(address.toUpperCase())).toBe(address);
  });

  it("accepts a decoded ZIP-316/F4Jumble testnet Unified address", () => {
    expect(
      isShieldedTestnetAddress(
        "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s",
      ),
    ).toBe(true);
    expect(
      shieldedTestnetAddressKind(
        "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s",
      ),
    ).toBe("unified");
  });

  it("rejects an address with a spoofed prefix and invalid checksum", () => {
    expect(isShieldedTestnetAddress(`utest1${"a".repeat(120)}`)).toBe(false);
  });

  it("rejects mainnet shielded prefixes", () => {
    expect(isShieldedTestnetAddress("u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe(false);
    expect(isShieldedTestnetAddress("zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe(false);
  });
});
