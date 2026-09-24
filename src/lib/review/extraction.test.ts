import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Follow runtime imports so a facade cannot hide a store dependency. */
function runtimeDependencies(entry: string, seen = new Set<string>()): Set<string> {
  const file = path.resolve(entry);
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const name = specifier.text;
    const base = name.startsWith("@/") ? path.resolve("src", name.slice(2))
      : name.startsWith(".") ? path.resolve(path.dirname(file), name) : null;
    if (!base) continue;
    const next = [base + ".ts", base + ".tsx", path.join(base, "index.ts")].find(fs.existsSync);
    if (next) runtimeDependencies(next, seen);
  }
  return seen;
}

test("review parsing and settled relay projection cannot load flow execution or storage", () => {
  for (const entry of ["src/lib/review/findings.ts", "src/lib/reviewHistory/relayProvenance.ts"]) {
    const dependencies = [...runtimeDependencies(entry)].map((file) => path.relative(process.cwd(), file));
    expect(dependencies.filter((file) => file.startsWith("src/lib/flows/"))).toEqual([]);
    expect(dependencies.filter((file) => /(?:store|registry|sqliteStateStore)\.ts$/i.test(file))).toEqual([]);
  }
});

test("legacy entry points share the extracted implementations", async () => {
  const oldFindings = await import("@/lib/flows/findings");
  const parsing = await import("./findings");
  const scanner = await import("@/lib/scanner/lastAssistantMessage");
  const artifacts = await import("@/lib/reviewHistory/findings");
  expect(oldFindings.parseFindings).toBe(parsing.parseFindings);
  expect(oldFindings.lastAssistantMessage).toBe(scanner.lastAssistantMessage);
  expect(oldFindings.readFindingsFile).toBe(artifacts.readFindingsFile);
  expect(oldFindings.fallbackReviewFromTranscript).toBe(artifacts.fallbackReviewFromTranscript);
  const oldExec = await import("@/lib/flows/exec");
  const executor = await import("@/lib/agent/headless");
  expect(oldExec.runHeadlessCodexOnce).toBe(executor.runHeadlessCodexOnce);
  expect(oldExec.terminateHeadlessReviewerGroupAndWait).toBe(executor.terminateHeadlessReviewerGroupAndWait);
  const oldPrompts = await import("@/lib/flows/prompts");
  const history = await import("@/lib/reviewHistory/relayPrompt");
  expect(oldPrompts.relayPrompt).toBe(history.relayPrompt);
});

test("archive GET import graphs cannot tick, refresh merge evidence or reconcile ownership", () => {
  for (const entry of ["src/app/api/review-history/route.ts", "src/app/api/review-history/[id]/route.ts", "src/app/api/review-history/[id]/export/route.ts"]) {
    const dependencies = [...runtimeDependencies(entry)].map(file => path.relative(process.cwd(), file));
    expect(dependencies.filter(file => file.startsWith("src/lib/flows/"))).toEqual([]);
    expect(dependencies.filter(file => /(?:engine|controller|registry|reaperRuntime|scanner\/index|viewerInstrumentation)\.ts$/.test(file))).toEqual([]);
    expect(dependencies.filter(file => file.startsWith("src/runtime-host/"))).toEqual([]);
  }
});

test("archive route configuration loads in Node build workers without loading Bun SQLite", async () => {
  const root = fs.mkdtempSync("/var/tmp/review-history-node-import-");
  try {
    const result = await Bun.build({
      entrypoints: ["src/app/api/review-history/route.ts", "src/app/api/review-history/[id]/route.ts", "src/app/api/review-history/[id]/export/route.ts"],
      outdir: root, root: "src/app/api/review-history", target: "node", format: "cjs", external: ["next/*", "bun:*"],
    });
    expect(result.success).toBe(true);
    const node = process.env.LLV_TEST_NODE_BIN || "/usr/bin/node";
    const probe = Bun.spawnSync({ cmd: [node, "-e", "for (const file of process.argv.slice(1)) require(file);", ...result.outputs.map(output => output.path)],
      env: { ...process.env, NODE_PATH: path.resolve("node_modules"), HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"), TMPDIR: root, NODE_ENV: "production" },
      stdout: "pipe", stderr: "pipe" });
    expect({ exit: probe.exitCode, error: probe.stderr.toString() }).toEqual({ exit: 0, error: "" });
    expect(fs.existsSync(path.join(root, "state"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
