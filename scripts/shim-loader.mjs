import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pino") {
    return { shortCircuit: true, url: new URL("./esm-shims/pino.mjs", import.meta.url).href };
  }
  if (specifier === "yaml") {
    return { shortCircuit: true, url: new URL("./esm-shims/yaml.mjs", import.meta.url).href };
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
    const asTs = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(asTs))) {
      return { shortCircuit: true, url: asTs.href };
    }
  }
  return nextResolve(specifier, context);
}
