export * from "./bot-kit/types.js";

/** Duplicated from jeb-contract until extraction §4 imports the package. */
export interface ContractEnv {
  nexusUrl: string;
  homeserverPk: string;
  signupToken: string;
  secretKeyHex: string;
  pgUrl?: string;
  cannedReply: string;
  modelDelayMs: number;
  maxRepliesPerThread: number;
  testnet: boolean;
}
