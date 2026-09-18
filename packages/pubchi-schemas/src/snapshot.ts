import { canonicalJson, sha256Hex } from "./canonical.js";

export type SnapshotTarget =
  | { kind: "post"; uri: string; author: string }
  | { kind: "user"; uri: string; pubky: string };

export type SnapshotPost = {
  details: {
    author: string;
    content: string;
    kind: string;
  };
};

export type SnapshotUser = {
  name: string;
  bio?: string | null;
};

export function snapshotProjection(
  target: SnapshotTarget,
  post: SnapshotPost | null,
  user: SnapshotUser | null,
): Record<string, string | null> {
  return target.kind === "post"
    ? {
        kind: "post",
        uri: target.uri,
        author: post?.details.author ?? target.author,
        content: post?.details.content ?? "",
        post_kind: post?.details.kind ?? "",
      }
    : {
        kind: "user",
        uri: target.uri,
        pubky: target.pubky,
        name: user?.name ?? "",
        bio: user?.bio ?? null,
      };
}

export function snapshotSha256(projection: unknown): string {
  return sha256Hex(canonicalJson(projection));
}
