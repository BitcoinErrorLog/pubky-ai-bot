import { mnemonicToSeedSync, validateMnemonic } from "bip39";

export function secretFromEnv(): string {
  const hex = process.env.PUBKY_BOT_SECRET_KEY_HEX?.trim();
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PUBKY_BOT_SECRET_KEY_HEX must be 32-byte hex");
    return hex.toLowerCase();
  }
  const mnemonic = process.env.PUBKY_BOT_MNEMONIC?.trim();
  if (mnemonic) {
    if (!validateMnemonic(mnemonic)) throw new Error("PUBKY_BOT_MNEMONIC is not a valid BIP39 phrase");
    const seed = mnemonicToSeedSync(mnemonic);
    return Buffer.from(seed.subarray(0, 32)).toString("hex");
  }
  throw new Error("PUBKY_BOT_SECRET_KEY_HEX or PUBKY_BOT_MNEMONIC is required");
}

export function assertNoKeyMaterial(): void {
  if (process.env.PUBKY_BOT_SECRET_KEY_HEX || process.env.PUBKY_BOT_MNEMONIC) {
    throw new Error("key material must not be present in this process");
  }
}
