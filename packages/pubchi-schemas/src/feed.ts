import { PubkyAppFeed } from "pubky-app-specs";
import { z } from "zod";
import { err, ok, type ParseResult } from "./codes.js";
import { fromZod, zPubky, zUnix, zVersion1 } from "./zod.js";

/** Reach values the App mapper accepts (Followers has no home equivalent). */
export const APP_SUPPORTED_REACH = ["following", "friends", "all", "wot", "me"] as const;
export const APP_SUPPORTED_SORT = ["recent", "popularity"] as const;
export const APP_SUPPORTED_LAYOUT = ["columns", "wide", "visual", "list"] as const;
export const APP_SUPPORTED_CONTENT = ["short", "long", "image", "video", "link", "file", "collection"] as const;

const FeedConfigSchema = z
  .object({
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    domain_tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    reach: z.string(),
    layout: z.enum(APP_SUPPORTED_LAYOUT),
    sort: z.string(),
    content: z.string().optional(),
  })
  .strict();

const PubkyAppFeedJsonSchema = z
  .object({
    feed: FeedConfigSchema,
    name: z.string().min(1).max(100),
    created_at: zUnix,
    icon: z.string().max(300).optional(),
  })
  .strict();

export const FeedProposalV1Schema = z
  .object({
    schema: z.literal("pubchi-feed-proposal"),
    version: zVersion1,
    bot: zPubky,
    owner: zPubky,
    generated_at: zUnix,
    feed: PubkyAppFeedJsonSchema,
    warnings: z.array(z.enum(["truncated-tags", "name-trimmed"])).max(8),
    installed_user_feed_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
  })
  .strict();

export type FeedProposalV1 = z.infer<typeof FeedProposalV1Schema>;

function mentionsLikes(feed: z.infer<typeof PubkyAppFeedJsonSchema>): boolean {
  const values = [feed.feed.reach, feed.feed.sort, feed.feed.content, feed.feed.layout];
  return values.some((v) => typeof v === "string" && v.toLowerCase() === "likes");
}

export function parseFeedProposalV1(input: unknown): ParseResult<FeedProposalV1> {
  const shaped = fromZod(FeedProposalV1Schema, input);
  if (!shaped.ok) return shaped;
  const proposal = shaped.value;
  if (mentionsLikes(proposal.feed)) return err("FEED_UNSUPPORTED_LIKES");
  if (!(APP_SUPPORTED_REACH as readonly string[]).includes(proposal.feed.feed.reach)) {
    return err("FEED_UNSUPPORTED_REACH");
  }
  if (!(APP_SUPPORTED_SORT as readonly string[]).includes(proposal.feed.feed.sort)) {
    return err("FEED_SPECS_INVALID");
  }
  if (proposal.feed.feed.content && !(APP_SUPPORTED_CONTENT as readonly string[]).includes(proposal.feed.feed.content)) {
    return err("FEED_SPECS_INVALID");
  }
  try {
    PubkyAppFeed.fromJson(proposal.feed);
  } catch {
    return err("FEED_SPECS_INVALID");
  }
  return ok(proposal);
}
