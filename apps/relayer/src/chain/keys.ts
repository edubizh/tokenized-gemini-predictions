import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";

const KEYPAIR_BYTES = 64;
const KEY_BYTES = 32;

/**
 * Loads a keypair file as `solana-keygen` writes it: a JSON array of 64 bytes (secret key, then
 * public key). Errors name the file and never its content.
 */
export async function loadKeypairSigner(path: string): Promise<KeyPairSigner> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const isByte = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
  if (!Array.isArray(parsed) || parsed.length !== KEYPAIR_BYTES || !parsed.every(isByte)) {
    throw new Error(`${path} is not a 64-byte keypair file`);
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed as number[]));
}

/**
 * Creates a new keypair file (mode 600) unless one exists. Returns whether it was created; an
 * existing file is never touched.
 */
export async function ensureKeypairFile(path: string): Promise<boolean> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // The raw keys are the last 32 bytes of the DER encodings.
  const secret = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-KEY_BYTES);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-KEY_BYTES);
  try {
    await writeFile(path, JSON.stringify([...secret, ...pub]), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
