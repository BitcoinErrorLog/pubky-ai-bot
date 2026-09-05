/**
 * Markdown → HTML for the drafts review page. HTML in the draft is escaped
 * first so a hostile body cannot inject tags, handlers, or javascript: links.
 */

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (ch) => ESC[ch] ?? ch);
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href) || /^pubky:\/\//i.test(href)) return href;
  return null;
}

function inlineMarkdown(escaped: string): string {
  let s = escaped;
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
    const safe = safeHref(href.replace(/&amp;/g, "&"));
    if (!safe) return text;
    return `<a href="${escapeHtml(safe)}" rel="noreferrer noopener">${text}</a>`;
  });
  return s;
}

function flushList(out: string[], items: string[], ordered: boolean): void {
  if (items.length === 0) return;
  const tag = ordered ? "ol" : "ul";
  out.push(`<${tag}>`);
  for (const item of items) out.push(`<li>${inlineMarkdown(item)}</li>`);
  out.push(`</${tag}>`);
  items.length = 0;
}

/** Escape-then-markdown. Raw HTML from the draft never reaches the output. */
export function renderDraftHtml(body: string): string {
  const escaped = escapeHtml(body.replace(/\r\n/g, "\n"));
  const lines = escaped.split("\n");
  const out: string[] = [];
  const ul: string[] = [];
  const ol: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
    para = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    const ulItem = /^[-*] (.+)$/.exec(line);
    const olItem = /^\d+\. (.+)$/.exec(line);
    if (heading) {
      flushPara();
      flushList(out, ul, false);
      flushList(out, ol, true);
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      continue;
    }
    if (ulItem) {
      flushPara();
      flushList(out, ol, true);
      ul.push(ulItem[1]!);
      continue;
    }
    if (olItem) {
      flushPara();
      flushList(out, ul, false);
      ol.push(olItem[1]!);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList(out, ul, false);
      flushList(out, ol, true);
      continue;
    }
    flushList(out, ul, false);
    flushList(out, ol, true);
    para.push(line);
  }
  flushPara();
  flushList(out, ul, false);
  flushList(out, ol, true);
  return out.join("\n") || "<p></p>";
}
