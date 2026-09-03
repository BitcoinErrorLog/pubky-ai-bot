import pino from "pino";

export const log = pino({
  level: process.env.JEB_LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "secretKeyHex",
      "apiKey",
      "PUBKY_BOT_SECRET_KEY_HEX",
      "PUBKY_BOT_MNEMONIC",
      "JEB_MODEL_API_KEY",
      "ADMIN_TOKEN",
    ],
    remove: true,
  },
});

export function withMention(mention_key: string) {
  return log.child({ mention_key });
}
