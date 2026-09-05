import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./db.js";
import { generateFormat } from "./drafts/generate.js";
import { approveDraftToPublishRequest } from "./drafts/publish-request.js";
import { DraftRejectedError } from "./drafts/finish.js";
import { escapeHtml, renderDraftHtml, safeHref } from "./drafts/render-html.js";
import type { Config } from "./config.js";
import type { DraftRow } from "./drafts/types.js";

export const DRAFTS_ADMIN_HANDLE = "dashboard";
export const CSRF_COOKIE = "jeb_csrf";
export const ADMIN_COOKIE = "jeb_admin";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function sessionCsrf(existing?: string): string {
  if (existing && /^[0-9a-f]{64}$/i.test(existing)) return existing;
  return newCsrfToken();
}

export function adminCookieFlags(secure: boolean): string {
  return `Path=/admin; SameSite=Strict; HttpOnly${secure ? "; Secure" : ""}`;
}

export function csrfOk(got: string | undefined, expected: string | undefined): boolean {
  if (!got || !expected) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function setAdminCookies(res: ServerResponse, adminToken: string, csrf: string, secure = false): void {
  const base = adminCookieFlags(secure);
  res.setHeader("set-cookie", [
    `${ADMIN_COOKIE}=${encodeURIComponent(adminToken)}; ${base}`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrf)}; ${base}`,
  ]);
}

function evidenceLinks(row: DraftRow): string {
  const uris = row.evidence.uris ?? [];
  if (uris.length === 0) return "<p class=\"muted\">No evidence URIs.</p>";
  return `<ul>${uris
    .map((u) => {
      const safe = safeHref(u);
      if (!safe) return `<li>${escapeHtml(u)}</li>`;
      return `<li><a href="${escapeHtml(safe)}" rel="noreferrer noopener">${escapeHtml(u)}</a></li>`;
    })
    .join("")}</ul>`;
}

function actionForm(id: number, action: string, csrf: string, extra = ""): string {
  return `<form method="post" action="/admin/drafts/${id}/${action}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
${extra}
<button type="submit">${escapeHtml(action)}</button>
</form>`;
}

export function renderDraftsPage(rows: DraftRow[], csrf: string): string {
  const cards = rows
    .map((row) => {
      const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
      return `<article class="draft" data-draft-id="${row.id}">
<h2>Draft ${row.id} · ${escapeHtml(row.format)}</h2>
<p class="meta">${escapeHtml(created)}${row.title ? ` · ${escapeHtml(row.title)}` : ""}</p>
<div class="preview">${renderDraftHtml(row.body)}</div>
<h3>Evidence</h3>
${evidenceLinks(row)}
<div class="actions">
${actionForm(row.id, "approve", csrf)}
${actionForm(row.id, "reject", csrf, `<label>Reason <input name="reason" required /></label>`)}
${actionForm(row.id, "regenerate", csrf)}
</div>
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Jeb drafts</title>
<style>
body{font-family:system-ui,sans-serif;max-width:52rem;margin:1.5rem auto;padding:0 1rem;color:#111}
.muted{color:#555}
.draft{border:1px solid #ccc;padding:1rem;margin:1rem 0}
.preview{background:#f7f7f5;padding:.75rem}
.actions{display:flex;gap:1rem;flex-wrap:wrap;align-items:end}
button{padding:.4rem .8rem}
</style></head>
<body>
<h1>Pending drafts</h1>
<p class="muted">${rows.length} draft${rows.length === 1 ? "" : "s"} waiting for review. Approve, reject, or regenerate. Nothing publishes without Approve.</p>
${rows.length === 0 ? "<p>No pending drafts.</p>" : cards}
</body></html>`;
}

export async function handleDraftsGet(
  store: Store,
  res: ServerResponse,
  csrf: string,
  adminToken: string,
  secure = false,
): Promise<void> {
  const rows = await store.listDrafts("draft");
  setAdminCookies(res, adminToken, csrf, secure);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderDraftsPage(rows, csrf));
}

export async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

export function parseForm(body: string, contentType: string | undefined): Record<string, string> {
  if ((contentType ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const part of body.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
    const v = decodeURIComponent((i < 0 ? "" : part.slice(i + 1)).replace(/\+/g, " "));
    out[k] = v;
  }
  return out;
}

export async function handleDraftsPost(opts: {
  store: Store;
  cfg: Config;
  action: "approve" | "reject" | "regenerate";
  id: number;
  fields: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  const { store, cfg, action, id, fields } = opts;
  if (!Number.isInteger(id) || id < 1) return { status: 400, body: "invalid draft id" };
  try {
    if (action === "approve") {
      const result = await approveDraftToPublishRequest(store, { draftId: id, decidedBy: DRAFTS_ADMIN_HANDLE });
      return { status: 200, body: `approved id=${result.draft.id} publish_request_id=${result.publishRequestId}` };
    }
    if (action === "reject") {
      const reason = (fields.reason ?? "").trim();
      if (!reason) return { status: 400, body: "reject requires reason" };
      const row = await store.rejectDraft(id, DRAFTS_ADMIN_HANDLE, reason);
      return { status: 200, body: `rejected id=${row.id}` };
    }
    const existing = await store.getDraft(id);
    if (!existing || existing.status !== "draft") return { status: 400, body: `draft ${id} not found or not in draft status` };
    const draft = await generateFormat({ format: existing.format, cfg, store });
    const row = await store.updateDraftContent(id, draft);
    return { status: 200, body: `regenerated id=${row.id} format=${row.format}` };
  } catch (e) {
    if (
      action === "regenerate" &&
      e instanceof DraftRejectedError &&
      /: none: evidence source unavailable/.test(e.message)
    ) {
      await store.rejectDraft(id, DRAFTS_ADMIN_HANDLE, "evidence source unavailable");
    }
    return { status: 400, body: e instanceof Error ? e.message : String(e) };
  }
}
