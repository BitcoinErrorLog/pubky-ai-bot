import pino from "pino";

export const log = pino({
  level: process.env.JEB_LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "PUBKY_BOT_SECRET_KEY_HEX",
      "PUBKY_BOT_MNEMONIC",
      "PUBKY_BOT_SECRET_KEY_FILE",
      "JEB_MODEL_API_KEY",
      "DATABASE_URL",
      "ADMIN_TOKEN",
      "JEB_NLQ_TOKEN",
      "*.JEB_NLQ_TOKEN",
      "env.JEB_NLQ_TOKEN",
      "signupToken",
      "secretKeyHex",
      "modelApiKey",
      "databaseUrl",
      "adminToken",
      "*.authorization",
      "*.cookie",
      "*.secretKeyHex",
      "*.signupToken",
      "*.databaseUrl",
      "*.modelApiKey",
      "*.ADMIN_TOKEN",
      "*.PUBKY_BOT_SECRET_KEY_HEX",
      "*.PUBKY_BOT_MNEMONIC",
      "*.JEB_MODEL_API_KEY",
      "*.DATABASE_URL",
      "cfg.secretKeyHex",
      "cfg.signupToken",
      "cfg.databaseUrl",
      "cfg.modelApiKey",
      "cfg.adminToken",
      "env.secretKeyHex",
      "env.signupToken",
      "env.PUBKY_BOT_SECRET_KEY_HEX",
      "env.PUBKY_BOT_MNEMONIC",
      "env.JEB_MODEL_API_KEY",
      "env.DATABASE_URL",
      "env.ADMIN_TOKEN",
      "env.PUBKY_BOT_SECRET_KEY_FILE",
      "*.PUBKY_BOT_SECRET_KEY_FILE",
    ],
    remove: true,
  },
});

export function withMention(mention_key: string) {
  return log.child({ mention_key });
}
