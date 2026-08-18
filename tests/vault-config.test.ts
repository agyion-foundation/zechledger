import { afterEach, describe, expect, it } from "vitest";
import { configuredVaultAccountMap } from "@/lib/vault-config";

const previous = process.env.ZALLET_VAULT_ACCOUNT_MAP;
afterEach(() => {
  if (previous === undefined) delete process.env.ZALLET_VAULT_ACCOUNT_MAP;
  else process.env.ZALLET_VAULT_ACCOUNT_MAP = previous;
});

describe("Zallet vault account map", () => {
  it("canonicalizes UUID and vault ID values", () => {
    process.env.ZALLET_VAULT_ACCOUNT_MAP = JSON.stringify({
      " 11111111-2222-4333-8444-555555555555 ": " vault-export ",
    });
    expect(configuredVaultAccountMap()).toEqual({ "11111111-2222-4333-8444-555555555555": "vault-export" });
  });

  it("rejects duplicate canonical UUID aliases", () => {
    process.env.ZALLET_VAULT_ACCOUNT_MAP = JSON.stringify({
      "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE": "vault-export",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee": "vault-rnd",
    });
    expect(() => configuredVaultAccountMap()).toThrow(/duplicate canonical account/);
  });

  it("rejects arrays and empty vault mappings", () => {
    process.env.ZALLET_VAULT_ACCOUNT_MAP = "[]";
    expect(() => configuredVaultAccountMap()).toThrow(/JSON object/);
    process.env.ZALLET_VAULT_ACCOUNT_MAP = JSON.stringify({ "11111111-2222-4333-8444-555555555555": " " });
    expect(() => configuredVaultAccountMap()).toThrow(/non-empty vault ID/);
  });
});
