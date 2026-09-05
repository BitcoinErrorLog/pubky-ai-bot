import { z } from "zod";
import { Z32 } from "./types.js";

export const z32Schema = z.string().regex(Z32);

export const notificationSchema = z.object({
  timestamp: z.number(),
  body: z.record(z.unknown()),
});

export const postViewSchema = z.object({
  details: z.object({
    content: z.string(),
    id: z.string(),
    indexed_at: z.number(),
    author: z32Schema,
    kind: z.string(),
    uri: z.string(),
  }),
  relationships: z
    .object({
      replied: z.string().nullable().optional(),
      reposted: z.string().nullable().optional(),
      mentioned: z.array(z.string()).optional(),
    })
    .optional(),
  counts: z
    .object({
      tags: z.number().optional(),
      unique_tags: z.number().optional(),
      replies: z.number().optional(),
      reposts: z.number().optional(),
    })
    .optional(),
  tags: z
    .array(
      z.object({
        label: z.string(),
        taggers_count: z.number().optional(),
        taggers: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export const tagSearchHitSchema = z.object({
  post_key: z.string(),
  score: z.number().optional(),
});

export const userDetailsSchema = z.object({
  name: z.string(),
  bio: z.string().nullable().optional(),
  id: z.string(),
});

export function assertAuthorId(id: string): string {
  if (!Z32.test(id)) throw new Error("invalid author id");
  return id;
}
