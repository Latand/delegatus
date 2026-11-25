import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

test("Next Webpack compilation routes dependency installation and canonical preparation safely", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publication-invocation-webpack-"));
  const require = createRequire(import.meta.url);
  const webpack = require("next/dist/compiled/webpack/webpack").webpack;
  try {
    const source = fs.readFileSync(path.join(import.meta.dir, "publicationInvocation.ts"), "utf8");
    const transpiled = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const modulePath = path.join(root, "publicationInvocation.cjs");
    fs.writeFileSync(modulePath, transpiled);
    const entry = path.join(root, "entry.cjs");
    fs.writeFileSync(entry, `module.exports = require(${JSON.stringify(modulePath)});\n`);
    await new Promise<void>((resolve, reject) => {
      const compiler = webpack({ mode: "production", target: "node", entry,
        output: { path: root, filename: "compiled.cjs", library: { type: "commonjs2" } },
        externalsPresets: { node: true }, optimization: { minimize: false } });
      compiler.run((error: Error | null, stats: { hasErrors(): boolean; toString(): string }) => {
        compiler.close(() => {});
        if (error || stats.hasErrors()) reject(error ?? Error(stats.toString())); else resolve();
      });
    });
    const compiled = require(path.join(root, "compiled.cjs")) as typeof import("./publicationInvocation");
    const cwd = "/app";
    expect(compiled.isPublicationPreparationInvocation("bun", ["install", "--frozen-lockfile"], cwd)).toBe(false);
    expect(compiled.isPublicationPreparationInvocation("bun", ["/app/scripts/local-gate.ts", "pre-push", "--publication-prepare"], cwd)).toBe(true);
    expect(compiled.isPublicationPreparationInvocation("bun-container", ["scripts/local-gate.ts", "pre-push", "--publication-prepare"], cwd)).toBe(true);
    expect(compiled.isPublicationPreparationInvocation("bun", ["/app/scripts/local-gate.ts", "pre-push"], cwd)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
