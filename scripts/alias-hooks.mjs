// Node module-resolution hook used ONLY by `npm test`.
//
// The app resolves `@/…` through tsconfig paths and omits `.ts` on some relative imports;
// Node's test runner does neither. This maps `@/x` → `src/x` and adds a missing `.ts`, so the
// real source can be imported by tests unchanged (no test-only copies, no rewritten imports).

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "src");
const EXTS = [".ts", ".tsx", "/index.ts"];

function withExtension(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const hit = withExtension(join(SRC, specifier.slice(2)));
    if (hit) return nextResolve(pathToFileURL(hit).href, context);
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.endsWith(".ts")) {
    const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    const hit = withExtension(base);
    if (hit) return nextResolve(pathToFileURL(hit).href, context);
  }
  return nextResolve(specifier, context);
}
