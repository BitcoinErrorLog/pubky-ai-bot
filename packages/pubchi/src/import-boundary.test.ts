import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function productFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("._")) continue;
    const full = join(dir, name);
    if (name.endsWith(".test.ts") || name === "test-helpers.ts") continue;
    if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const FORBIDDEN_IMPORT = /from\s+["'][^"']*(publish\/(homeserver|publisher|publish-store|post)|\/publish["'])/;
const FORBIDDEN_SYMBOL = /\b(SessionTransport|openTransport|signinOrSignup)\b/;
const PUT_METHOD = /method\s*:\s*["']PUT["']|\.putJson\(|\.putBytes\(|fetch\([^)]*PUT/;

describe("import boundary: no publisher, no homeserver write, no PUT", () => {
  const files = productFiles(here);

  it("product files do not import the publisher or session transport", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(FORBIDDEN_IMPORT);
      expect(src, file).not.toMatch(FORBIDDEN_SYMBOL);
      expect(src, file).not.toMatch(PUT_METHOD);
    }
  });

  it("built module graph has no PUT or publisher symbols when dist exists", () => {
    const dist = join(here, "../../../dist/pubchi");
    if (!existsSync(dist)) return;
    const names = readdirSync(dist).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const src = readFileSync(join(dist, name), "utf8");
      expect(src, name).not.toMatch(/\bputJson\b|\bSessionTransport\b|\bopenTransport\b/);
      expect(src, name).not.toMatch(/method:\s*["']PUT["']/);
    }
  });
});
