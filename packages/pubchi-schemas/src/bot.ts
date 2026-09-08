import { z } from "zod";
import { err, ok, type ParseResult } from "./codes.js";
import { scanForbiddenPublicState } from "./forbidden.js";
import { fromZod, zPubky, zUnix, zVersion1 } from "./zod.js";

export const PubchiBotV1Schema = z
  .object({
    schema: z.literal("pubchi-bot"),
    version: zVersion1,
    bot: zPubky,
    owner: zPubky,
    display_name: z.string().min(1).max(40),
    created_at: zUnix,
    backup_confirmed_at: zUnix.nullable(),
    homeserver_account: z.string().min(1).nullable(),
    key_generation: z.number().int().min(1),
  })
  .strict();

export type PubchiBotV1 = z.infer<typeof PubchiBotV1Schema>;

export function parsePubchiBotV1(input: unknown): ParseResult<PubchiBotV1> {
  const forbidden = scanForbiddenPublicState(input);
  if (!forbidden.ok) return err(forbidden.code);
  const parsed = fromZod(PubchiBotV1Schema, input);
  return parsed.ok ? ok(parsed.value) : parsed;
}
