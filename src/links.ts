/** App-facing citation URLs. Never emit raw `pubky://` URIs in replies. */

const DEFAULT_APP_URL = "https://pubky.app";
const PK = "([a-z0-9]{52})";
const POST_URI = new RegExp(`pubky://${PK}/pub/pubky\\.app/posts/([A-Z0-9]{13})`, "gi");
const PROFILE_URI = new RegExp(`pubky://${PK}(?![a-z0-9])`, "gi");
const BARE_PK = new RegExp(`(?<![A-Za-z0-9/])${PK}(?![A-Za-z0-9])`, "g");

export function appBaseUrl(raw = process.env.JEB_APP_URL): string {
  const v = (raw ?? DEFAULT_APP_URL).trim().replace(/\/$/, "");
  return v || DEFAULT_APP_URL;
}

export function postAppUrl(pk: string, postId: string, appUrl = appBaseUrl()): string {
  return `${appUrl}/post/${pk}/${postId}`;
}

export function profileAppUrl(pk: string, appUrl = appBaseUrl()): string {
  return `${appUrl}/profile/${pk}`;
}

/**
 * Rewrite post URIs, profile URIs, and bare 52-char pubky ids to app links.
 * Existing http(s) URLs are left unchanged (ids already inside them are skipped).
 */
export function rewritePubkyCitations(text: string, appUrl = appBaseUrl()): string {
  const parts = text.split(/(https?:\/\/[^\s)]+)/gi);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part.replace(POST_URI, (_m, pk: string, id: string) => postAppUrl(pk, id, appUrl));
      out = out.replace(PROFILE_URI, (_m, pk: string) => profileAppUrl(pk, appUrl));
      out = out.replace(BARE_PK, (m, pk: string, offset: number, whole: string) => {
        const before = whole.slice(Math.max(0, offset - 8), offset);
        if (/post\/$/.test(before) || /profile\/$/.test(before)) return m;
        return profileAppUrl(pk, appUrl);
      });
      return out;
    })
    .join("");
}
