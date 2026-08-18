import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDataDirectory } from "@/lib/data-directory";
import { canonicalJson } from "@/lib/canonical";
import type { AuditCapsule } from "@/lib/types";

interface AuditKeypair {
  privatePem: string;
  publicPem: string;
  fingerprint: string;
}
let keypairPromise: Promise<AuditKeypair> | null = null;

async function readPemIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(/* turbopackIgnore: true */ file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadOrCreateKeypair(): Promise<AuditKeypair> {
  const encodedPrivate = process.env.ZECHLEDGER_AUDIT_PRIVATE_KEY_B64?.trim();
  if (encodedPrivate) {
    const privatePem = Buffer.from(encodedPrivate, "base64").toString("utf8");
    if (!privatePem.includes("BEGIN PRIVATE KEY"))
      throw new Error("The audit private key is not a base64-encoded PEM value.");
    const derivedPublic = createPublicKey(createPrivateKey(privatePem))
      .export({ type: "spki", format: "pem" })
      .toString();
    const encodedPublic = process.env.ZECHLEDGER_AUDIT_PUBLIC_KEY_B64?.trim();
    const publicPem = encodedPublic ? Buffer.from(encodedPublic, "base64").toString("utf8") : derivedPublic;
    if (derivedPublic.trim() !== publicPem.trim())
      throw new Error(
        "The audit public/private key pair from the environment does not match; signing has been disabled.",
      );
    const fingerprint = createHash("sha256").update(publicPem.trim()).digest("hex");
    return { privatePem, publicPem, fingerprint };
  }
  if (process.env.ZECHLEDGER_AUDIT_PUBLIC_KEY_B64)
    throw new Error("The audit public key from the environment cannot be used by itself; the private key is missing.");
  const directory = getDataDirectory();
  const privatePath = process.env.ZECHLEDGER_AUDIT_PRIVATE_KEY_PATH || path.join(directory, "audit-private.pem");
  const publicPath = process.env.ZECHLEDGER_AUDIT_PUBLIC_KEY_PATH || path.join(directory, "audit-public.pem");
  await mkdir(path.dirname(privatePath), { recursive: true });
  await mkdir(path.dirname(publicPath), { recursive: true });

  let privatePem = await readPemIfPresent(privatePath);
  let publicPem = await readPemIfPresent(publicPath);
  if (!privatePem && publicPem)
    throw new Error("The audit private key is missing; the existing public identity was not rotated automatically.");
  if (!privatePem) {
    const pair = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    try {
      await writeFile(privatePath, pair.privateKey, { mode: 0o600, flag: "wx" });
      privatePem = pair.privateKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      privatePem = await readFile(/* turbopackIgnore: true */ privatePath, "utf8");
    }
  }

  const derivedPublic = createPublicKey(createPrivateKey(privatePem))
    .export({ type: "spki", format: "pem" })
    .toString();
  if (!publicPem) {
    try {
      await writeFile(publicPath, derivedPublic, { mode: 0o644, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    publicPem = await readFile(/* turbopackIgnore: true */ publicPath, "utf8");
  }
  if (derivedPublic.trim() !== publicPem.trim()) {
    throw new Error("The audit public/private key pair does not match; signing has been disabled.");
  }
  const fingerprint = createHash("sha256").update(publicPem.trim()).digest("hex");
  return { privatePem, publicPem, fingerprint };
}

function keypair(): Promise<AuditKeypair> {
  keypairPromise ??= loadOrCreateKeypair();
  return keypairPromise;
}

export async function signAuditManifestHash(hash: string): Promise<{ signature: string; keyFingerprint: string }> {
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("The manifest hash to be signed is invalid.");
  const keys = await keypair();
  const signature = sign(null, Buffer.from(hash, "hex"), createPrivateKey(keys.privatePem)).toString("base64");
  return { signature, keyFingerprint: keys.fingerprint };
}

export async function signAuditReceipt(payload: object): Promise<{ signature: string; keyFingerprint: string }> {
  const keys = await keypair();
  const digest = createHash("sha256").update(canonicalJson(payload)).digest();
  const signature = sign(null, digest, createPrivateKey(keys.privatePem)).toString("base64");
  return { signature, keyFingerprint: keys.fingerprint };
}

export async function getAuditPublicKey(): Promise<{ pem: string; fingerprint: string }> {
  const keys = await keypair();
  return { pem: keys.publicPem, fingerprint: keys.fingerprint };
}
export async function verifyAuditCapsuleSignatures(capsules: AuditCapsule[]): Promise<void> {
  if (!capsules.length) return;
  const keys = await keypair();
  const publicKey = createPublicKey(keys.publicPem);
  for (const capsule of capsules) {
    if (
      capsule.signingKeyFingerprint !== keys.fingerprint ||
      !verify(null, Buffer.from(capsule.manifestHash, "hex"), publicKey, Buffer.from(capsule.signature, "base64"))
    ) {
      throw new Error(`The audit capsule signature is invalid (${capsule.id}).`);
    }
    if (capsule.anchorReceipt) {
      const receipt = capsule.anchorReceipt;
      const core = {
        manifestHash: receipt.manifestHash,
        txid: receipt.txid,
        blockHeight: receipt.blockHeight,
        confirmations: receipt.confirmations,
        observedAt: receipt.observedAt,
        destinationObserved: receipt.destinationObserved,
        accountFingerprint: receipt.accountFingerprint,
        memo: receipt.memo,
        zatoshi: receipt.zatoshi,
        internalProvenance: receipt.internalProvenance,
      };
      const digest = createHash("sha256").update(canonicalJson(core)).digest();
      if (
        receipt.signingKeyFingerprint !== keys.fingerprint ||
        !verify(null, digest, publicKey, Buffer.from(receipt.signature, "base64"))
      ) {
        throw new Error(`The audit anchor receipt signature is invalid (${capsule.id}).`);
      }
    }
  }
}
