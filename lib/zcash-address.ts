import { bech32, bech32m } from "@scure/base";
import { blake2b } from "@noble/hashes/blake2.js";

export type ShieldedTestnetAddressKind = "unified" | "sapling";
const encoder = new TextEncoder();

function personalization(kind: "H" | "G", round: number, block = 0): Uint8Array {
  const out = new Uint8Array(16);
  out.set(encoder.encode(`UA_F4Jumble_${kind}`));
  out[13] = round;
  if (kind === "G") {
    out[14] = block & 0xff;
    out[15] = block >>> 8;
  }
  return out;
}

function xor(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < Math.min(target.length, source.length); i += 1) target[i] ^= source[i];
}

function f4JumbleInverse(encoded: Uint8Array): Uint8Array {
  if (encoded.length < 48 || encoded.length > 4_194_368) throw new Error("Invalid F4Jumble length");
  const message = Uint8Array.from(encoded);
  const leftLength = Math.min(64, Math.floor(message.length / 2));
  const left = message.subarray(0, leftLength);
  const right = message.subarray(leftLength);
  const h = (round: number) =>
    xor(left, blake2b(right, { dkLen: left.length, personalization: personalization("H", round) }));
  const g = (round: number) => {
    for (let offset = 0, block = 0; offset < right.length; offset += 64, block += 1) {
      xor(
        right.subarray(offset, Math.min(offset + 64, right.length)),
        blake2b(left, { dkLen: 64, personalization: personalization("G", round, block) }),
      );
    }
  };
  h(1);
  g(1);
  h(0);
  g(0);
  return message;
}

function readCompact(bytes: Uint8Array, cursor: { value: number }): number {
  const first = bytes[cursor.value++];
  if (first === undefined) throw new Error("CompactSize is missing");
  if (first < 253) return first;
  const size = first === 253 ? 2 : first === 254 ? 4 : 8;
  if (cursor.value + size > bytes.length) throw new Error("CompactSize is truncated");
  let value = 0n;
  for (let i = 0; i < size; i += 1) value |= BigInt(bytes[cursor.value++]) << BigInt(8 * i);
  const minimum = size === 2 ? 253n : size === 4 ? 65_536n : 4_294_967_296n;
  if (value < minimum || value > 0x02000000n) throw new Error("CompactSize is not canonical");
  return Number(value);
}

function validUnifiedTestnetAddress(address: string): boolean {
  const decoded = bech32m.decode(address as `utest1${string}`, false);
  if (decoded.prefix !== "utest") return false;
  const raw = f4JumbleInverse(bech32m.fromWords(decoded.words));
  if (raw.length < 16) return false;
  const body = raw.subarray(0, raw.length - 16);
  const expectedPadding = new Uint8Array(16);
  expectedPadding.set(encoder.encode("utest"));
  if (!raw.subarray(raw.length - 16).every((byte, index) => byte === expectedPadding[index])) return false;
  const cursor = { value: 0 };
  let previous = -1;
  let hasShielded = false;
  let p2pkh = false;
  let p2sh = false;
  while (cursor.value < body.length) {
    const typecode = readCompact(body, cursor);
    const length = readCompact(body, cursor);
    if (typecode <= previous || cursor.value + length > body.length) return false;
    previous = typecode;
    if ((typecode === 0 || typecode === 1) && length !== 20) return false;
    if ((typecode === 2 || typecode === 3) && length !== 43) return false;
    if (typecode === 0) p2pkh = true;
    if (typecode === 1) p2sh = true;
    if (typecode === 2 || typecode === 3) hasShielded = true;
    cursor.value += length;
  }
  return cursor.value === body.length && hasShielded && !(p2pkh && p2sh);
}

export function isTestnetUnifiedFullViewingKey(value: string): boolean {
  const key = value.trim();
  if (!key.toLowerCase().startsWith("uviewtest1")) return false;
  try {
    const decoded = bech32m.decode(key as `uviewtest1${string}`, false);
    if (decoded.prefix !== "uviewtest") return false;
    const raw = f4JumbleInverse(bech32m.fromWords(decoded.words));
    if (raw.length < 16) return false;
    const body = raw.subarray(0, raw.length - 16);
    const expectedPadding = new Uint8Array(16);
    expectedPadding.set(encoder.encode("uviewtest"));
    if (!raw.subarray(raw.length - 16).every((byte, index) => byte === expectedPadding[index])) return false;
    const cursor = { value: 0 };
    let previous = -1;
    let hasShielded = false;
    while (cursor.value < body.length) {
      const typecode = readCompact(body, cursor);
      const length = readCompact(body, cursor);
      if (typecode <= previous || cursor.value + length > body.length) return false;
      previous = typecode;
      if (typecode === 0 && length !== 65) return false;
      if (typecode === 1) return false;
      if (typecode === 2 && length !== 128) return false;
      if (typecode === 3 && length !== 96) return false;
      if (typecode === 2 || typecode === 3) hasShielded = true;
      cursor.value += length;
    }
    return cursor.value === body.length && hasShielded;
  } catch {
    return false;
  }
}

export function shieldedTestnetAddressKind(address: string): ShieldedTestnetAddressKind | null {
  const value = address.trim();
  try {
    if (value.toLowerCase().startsWith("utest1")) return validUnifiedTestnetAddress(value) ? "unified" : null;
    if (value.toLowerCase().startsWith("ztestsapling1")) {
      const decoded = bech32.decode(value as `ztestsapling1${string}`, false);
      return decoded.prefix === "ztestsapling" && bech32.fromWords(decoded.words).length === 43 ? "sapling" : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function isShieldedTestnetAddress(address: string): boolean {
  return shieldedTestnetAddressKind(address) !== null;
}

export function canonicalShieldedTestnetAddress(address: string): string {
  const value = address.trim();
  assertShieldedTestnetAddress(value);
  return value.toLowerCase();
}

export function canonicalizeObservedAddress(address: string | null | undefined): string | undefined {
  if (!address) return undefined;
  const value = address.trim();
  return /^(utest|ztestsapling)1/i.test(value) ? value.toLowerCase() : value;
}

export function assertShieldedTestnetAddress(address: string, label = "Zcash address"): void {
  if (!isShieldedTestnetAddress(address)) {
    throw new Error(
      `${label} must be a testnet Unified address (utest1…) containing a ZIP-316-validated shielded receiver or a valid Sapling address (ztestsapling1…).`,
    );
  }
}
