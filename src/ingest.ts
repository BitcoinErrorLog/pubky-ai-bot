import type { Config } from "./config.js";
import { Store } from "./db.js";
import { listenHealth, closeServer } from "./health.js";
import { metrics } from "./metrics.js";
import { Nexus } from "./nexus.js";
import { assertNoKeyMaterial } from "./keys.js";
import { envSwitchOn } from "./switches.js";
import {
  ingestOne as kitIngestOne,
  maxProcessedTs,
  runIngest as kitRunIngest,
  type IngestStore,
} from "./bot-kit/ingest.js";
import type { Notification } from "./types.js";
import { loadRuntimePersona } from "./personas/runtime.js";

export { maxProcessedTs };
export type { IngestStore };

export async function ingestOne(
  store: Store,
  botPk: string,
  n: Notification,
  workStaleMs?: number,
  personaSnapshot?: {
    id: string;
    version: string;
    hash: string;
    targetBotPk: string;
  },
): Promise<boolean> {
  return kitIngestOne(
    store,
    botPk,
    n,
    workStaleMs,
    (status) => metrics.incrementMentions(status),
    personaSnapshot,
  );
}

export async function runIngest(cfg: Config): Promise<() => Promise<void>> {
  const persona = loadRuntimePersona(cfg);
  return kitRunIngest(
    {
      ...cfg,
      personaSnapshot: {
        id: persona.snapshot.manifest.id,
        version: persona.snapshot.manifest.version,
        hash: persona.snapshot.snapshotHash,
        targetBotPk: cfg.botPk!,
      },
    },
    {
    createStore: (url) => new Store(url),
    createNexus: (url, timeoutMs) => new Nexus(url, timeoutMs),
    listenHealth,
    closeServer,
    envSwitchOn,
    assertNoKeyMaterial,
    incrementMentions: (status) => metrics.incrementMentions(status),
    },
  );
}
