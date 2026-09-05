import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_PATH =
  /\/bot-kit\/(?:src\/)?publish\/|\/bot-kit\/(?:src\/)?tags\/|homeserver(?!-read)/;

function resolveImport(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // try next
    }
  }
  return null;
}

function walk(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      const next = resolveImport(match[1] ?? "", file);
      if (next) stack.push(next);
    }
  }
  return seen;
}

describe("import boundary: no publisher, no homeserver write, no PUT", () => {
  it("transitive graph from process/http/index reaches no publish, tags, or session homeserver", () => {
    const entries = ["process.ts", "http.ts", "index.ts"].map((name) => {
      const full = join(here, name);
      expect(existsSync(full), full).toBe(true);
      return realpathSync(full);
    });
    const reached = walk(entries);
    expect(reached.size).toBeGreaterThan(10);
    const hits = [...reached].filter((file) => FORBIDDEN_PATH.test(file.replace(/\\/g, "/")));
    expect(hits).toEqual([]);
    for (const file of reached) {
      if (file.endsWith(".test.ts") || file.endsWith("test-helpers.ts")) continue;
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/\b(SessionTransport|openTransport|signinOrSignup)\b/);
      expect(src, file).not.toMatch(/method\s*:\s*["']PUT["']|\.putJson\(|\.putBytes\(/);
    }
  });
});
