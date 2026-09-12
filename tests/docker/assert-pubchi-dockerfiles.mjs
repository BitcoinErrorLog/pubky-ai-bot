#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_DIGEST =
  "node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0";

const REQUIRED_COPY_SOURCES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "packages/bot-kit",
  "packages/pubchi",
  "packages/pubchi-schemas",
  "src",
];

const FORBIDDEN_COPY_SOURCES = [
  "sources.yaml",
  "packages/jeb",
  "scripts/warm-embeddings.ts",
  "scripts/killswitch-drill.ts",
  ".cache/jeb-models",
  ".env",
];

function parseDockerfile(text) {
  const lines = [];
  let buf = "";
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.replace(/^\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    buf = buf ? `${buf} ${trimmed.replace(/\\$/, "").trim()}` : trimmed.replace(/\\$/, "").trim();
    if (raw.trimEnd().endsWith("\\")) continue;
    lines.push(buf);
    buf = "";
  }
  if (buf) lines.push(buf);

  const instructions = [];
  for (const line of lines) {
    const m = line.match(/^(FROM|COPY|RUN|USER|ENTRYPOINT|CMD|ENV|WORKDIR|EXPOSE|ARG|LABEL)\s+([\s\S]*)$/i);
    if (!m) continue;
    const op = m[1].toUpperCase();
    const rest = m[2].trim();
    instructions.push({ op, rest, json: parseExecJson(rest) });
  }
  return instructions;
}

function parseExecJson(rest) {
  if (!rest.startsWith("[")) return null;
  try {
    const v = JSON.parse(rest);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

function copySources(inst) {
  const parts = inst.rest.split(/\s+/).filter(Boolean).filter((p) => !p.startsWith("--"));
  if (parts.length < 2) return [];
  return parts.slice(0, -1);
}

function lastOf(instructions, op) {
  return [...instructions].reverse().find((i) => i.op === op);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertDedicatedDockerfile(text, expectedRole, label) {
  const instructions = parseDockerfile(text);
  const froms = instructions.filter((i) => i.op === "FROM");
  assert(froms.length >= 2, `${label}: expected build + final FROM`);
  for (const f of froms) {
    const image = f.rest.replace(/\s+AS\s+\S+$/i, "");
    assert(image === NODE_DIGEST, `${label}: FROM must be pinned digest, got ${image}`);
  }
  const finalFromIdx = instructions.findLastIndex((i) => i.op === "FROM");
  const final = instructions.slice(finalFromIdx + 1);
  const user = lastOf(final, "USER");
  assert(user && user.rest !== "root" && user.rest !== "0", `${label}: final USER must be nonroot`);
  const entry = lastOf(final, "ENTRYPOINT");
  assert(entry?.json?.join(" ") === "node dist/main.js", `${label}: ENTRYPOINT must be exec-form node dist/main.js`);
  const cmd = lastOf(final, "CMD");
  assert(
    cmd?.json?.length === 2 && cmd.json[0] === "--role" && cmd.json[1] === expectedRole,
    `${label}: CMD must be ["--role", "${expectedRole}"], got ${JSON.stringify(cmd?.json ?? cmd?.rest)}`,
  );
  const copies = instructions.filter((i) => i.op === "COPY");
  const sources = copies.flatMap(copySources);
  for (const need of REQUIRED_COPY_SOURCES) {
    assert(
      sources.some((s) => s === need || s.split(" ").includes(need)),
      `${label}: missing COPY ${need} (parsed COPY sources: ${sources.join(", ")})`,
    );
  }
  for (const bad of FORBIDDEN_COPY_SOURCES) {
    assert(
      !sources.some((s) => s === bad || s.endsWith(`/${bad}`) || s.includes(bad)),
      `${label}: must not COPY ${bad}`,
    );
  }
  const materialize = instructions.some(
    (i) =>
      i.op === "RUN" &&
      i.rest.includes("cp -a packages/bot-kit/src src/bot-kit") &&
      i.rest.includes("cp -a packages/pubchi/src src/pubchi") &&
      i.rest.includes("cp -a packages/pubchi-schemas/src src/pubchi-schemas"),
  );
  assert(materialize, `${label}: must materialize package sources into src/ (no build-time symlink reliance)`);
  const envs = instructions.filter((i) => i.op === "ENV");
  for (const e of envs) {
    assert(!/(SECRET|TOKEN|PASSWORD|MNEMONIC|API_KEY|CREDENTIAL)/i.test(e.rest), `${label}: ENV must not set credentials`);
  }
  assert(!text.includes("warm-embeddings"), `${label}: must not warm Jeb embeddings`);
  assert(!text.includes("sources.yaml"), `${label}: must not include sources.yaml`);
  assert(!text.includes("JEB_MODEL_CACHE"), `${label}: must not bake Jeb model cache env`);
}

function assertRootDockerfile(text) {
  const instructions = parseDockerfile(text);
  const sources = instructions.filter((i) => i.op === "COPY").flatMap(copySources);
  assert(
    sources.some((s) => s === "scripts/write-build-stamp.mjs"),
    "Dockerfile: missing COPY scripts/write-build-stamp.mjs",
  );
}

function negativeMissingBuildStampCopyFails() {
  const bad = `
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY src ./src
RUN npm run build
`;
  let failed = false;
  try {
    assertRootDockerfile(bad);
  } catch {
    failed = true;
  }
  assert(failed, "negative test: Dockerfile missing build-stamp COPY must be rejected");
}

function negativeMissingCopyFails() {
  const bad = `
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
USER jeb
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--role", "pubchi"]
`;
  let failed = false;
  try {
    assertDedicatedDockerfile(bad, "pubchi", "negative-missing-packages");
  } catch {
    failed = true;
  }
  assert(failed, "negative test: Dockerfile missing packages COPY must be rejected");
}

function negativeWrongRoleFails() {
  const bad = `
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY packages/bot-kit ./packages/bot-kit
COPY packages/pubchi ./packages/pubchi
COPY packages/pubchi-schemas ./packages/pubchi-schemas
COPY src ./src
RUN cp -a packages/bot-kit/src src/bot-kit && cp -a packages/pubchi/src src/pubchi && cp -a packages/pubchi-schemas/src src/pubchi-schemas
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
USER jeb
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--role", "all"]
`;
  let failed = false;
  try {
    assertDedicatedDockerfile(bad, "pubchi", "negative-wrong-role");
  } catch {
    failed = true;
  }
  assert(failed, "negative test: CMD --role all must be rejected for runtime image");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const rootDockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const runtime = readFileSync(join(root, "Dockerfile.pubchi"), "utf8");
const migrator = readFileSync(join(root, "Dockerfile.pubchi-migrate"), "utf8");
assertRootDockerfile(rootDockerfile);
assertDedicatedDockerfile(runtime, "pubchi", "Dockerfile.pubchi");
assertDedicatedDockerfile(migrator, "pubchi-migrate", "Dockerfile.pubchi-migrate");
negativeMissingBuildStampCopyFails();
negativeMissingCopyFails();
negativeWrongRoleFails();
console.log("ok: Dockerfile.pubchi CMD --role pubchi; Dockerfile.pubchi-migrate CMD --role pubchi-migrate");
