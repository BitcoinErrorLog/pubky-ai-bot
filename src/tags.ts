import { Store } from "./db.js";
import type { Config } from "./config.js";
import { openTransport } from "./homeserver.js";
import { log } from "./log.js";
import { revokePostTag } from "./publish.js";
import { applyTags } from "./reply-tags.js";
import { envSwitchOn } from "./switches.js";
import { parsePostUri } from "./types.js";

export { ARTIFACT_TAG_VOCAB, ARTIFACT_TAG_MEANINGS, REPLY_TAG_VOCABULARY, REPLY_TAG_MEANINGS } from "./reply-tags.js";

function argValue(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  return undefined;
}

function argvAfterRole(argv: string[]): string[] {
  const roleIdx = argv.indexOf("--role");
  return roleIdx >= 0 ? argv.slice(roleIdx + 2) : argv.slice(2);
}

export async function runTagsCli(cfg: Config, argv = process.argv): Promise<{ ok: boolean; lines: string[] }> {
  const afterRole = argvAfterRole(argv);
  const action = afterRole[0];
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  const lines: string[] = [];
  try {
    if (action === "list") {
      const rows = await store.listArtifactTags();
      for (const row of rows) {
        lines.push(`${row.status}\t${row.post_uri}\t${row.label}`);
        log.info({ uri: row.post_uri, label: row.label }, "artifact tag");
      }
      lines.push(`count=${rows.length}`);
      return { ok: true, lines };
    }
    if (action === "apply") {
      const postUri = afterRole[1];
      const label = afterRole[2];
      const by = argValue("--by", argv);
      if (!postUri || !label || !by) {
        return { ok: false, lines: ["usage: --role tags apply <postUri> <label> --by <handle>"] };
      }
      parsePostUri(postUri);
      const { inserted } = await applyTags(
        { targetUri: postUri, labels: [label], mode: "artifact", approvedBy: by },
        { store, cfg, envSwitchOn },
      );
      log.info({ uri: postUri, label }, "artifact tag queued");
      lines.push(inserted ? "queued" : "already queued or published");
      return { ok: true, lines };
    }
    if (action === "revoke") {
      const postUri = afterRole[1];
      const label = afterRole[2];
      const by = argValue("--by", argv);
      if (!postUri || !label || !by) {
        return {
          ok: false,
          lines: ["usage: --role tags revoke <postUri> <label> --by <handle> (apply first if no approval row)"],
        };
      }
      parsePostUri(postUri);
      const transport = await openTransport({
        secretKeyHex: cfg.secretKeyHex,
        homeserverPk: cfg.homeserverPk,
        signupToken: cfg.signupToken,
        testnet: cfg.testnet,
      });
      await revokePostTag(store, transport, { postUri, label, approvedBy: by });
      lines.push("revoked");
      return { ok: true, lines };
    }
    return { ok: false, lines: ["usage: --role tags apply|list|revoke"] };
  } finally {
    await store.close();
  }
}
