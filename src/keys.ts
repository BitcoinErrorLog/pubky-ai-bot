import { readFileSync, statSync } from "node:fs";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";

export function secretFromFile(path: string): string {
  const st = statSync(path);
  if ((st.mode & 0o177) !== 0) throw new Error("PUBKY_BOT_SECRET_KEY_FILE must be mode 0600");
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PUBKY_BOT_SECRET_KEY_FILE must contain 32-byte hex");
  return hex.toLowerCase();
}

export function secretFromEnv(): string {
  const hex = process.env.PUBKY_BOT_SECRET_KEY_HEX?.trim();
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PUBKY_BOT_SECRET_KEY_HEX must be 32-byte hex");
    return hex.toLowerCase();
  }
  const file = process.env.PUBKY_BOT_SECRET_KEY_FILE?.trim();
  if (file) return secretFromFile(file);
  const mnemonic = process.env.PUBKY_BOT_MNEMONIC?.trim();
  if (mnemonic) {
    if (!validateMnemonic(mnemonic)) throw new Error("PUBKY_BOT_MNEMONIC is not a valid BIP39 phrase");
    const seed = mnemonicToSeedSync(mnemonic);
    return Buffer.from(seed.subarray(0, 32)).toString("hex");
  }
  throw new Error("PUBKY_BOT_SECRET_KEY_HEX, PUBKY_BOT_SECRET_KEY_FILE, or PUBKY_BOT_MNEMONIC is required");
}

export function assertNoKeyMaterial(): void {
  if (
    process.env.PUBKY_BOT_SECRET_KEY_HEX ||
    process.env.PUBKY_BOT_MNEMONIC ||
    process.env.PUBKY_BOT_SECRET_KEY_FILE
  ) {
    throw new Error("key material must not be present in this process");
  }
}

/**
 * Env for ingest/reason child processes: strips all PUBKY_BOT_* key material
 * and the homeserver signup capability (JEB_SIGNUP_TOKEN), neither of which
 * has any purpose outside the publish process.
 */
export function stripKeyMaterialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const k of Object.keys(next)) {
    if (k.startsWith("PUBKY_BOT_")) delete next[k];
  }
  delete next.JEB_SIGNUP_TOKEN;
  return next;
}
