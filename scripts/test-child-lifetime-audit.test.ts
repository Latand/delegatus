import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const audit = read("docs/verification/test-child-lifetime.md").split("## Process-launch audit\n")[1];

/** Discover primitive references independently of the hand-written tables.
 * Include JavaScript and helper paths named by tests, even when a caller
 * launches a helper through a string rather than a module import.
 */
function launchReferences(file: string, source: string, sites?: number[]): boolean {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const primitives = new Set(["spawn", "fork", "exec", "execFile", "spawnSync", "execSync", "execFileSync"]);
  const aliases = new Set<string>();
  const namespaces = new Set<string>();
  let found = false;
  const record = (node: ts.Node) => {
    found = true;
    sites?.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
  };
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && /^(?:node:)?child_process$/.test(node.moduleSpecifier.text) && !node.importClause?.isTypeOnly) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        if (!binding.isTypeOnly && primitives.has((binding.propertyName ?? binding.name).text)) aliases.add(binding.name.text);
      }
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (node.importClause?.name) namespaces.add(node.importClause.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
      && /(?:import|require)\(["'](?:node:)?child_process["']\)/.test(node.initializer.getText(tree))) {
      for (const binding of node.name.elements) if (ts.isIdentifier(binding.name)
        && primitives.has((binding.propertyName ?? binding.name).getText(tree))) aliases.add(binding.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && /(?:import|require)\(["'](?:node:)?child_process["']\)/.test(node.initializer.getText(tree))) namespaces.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && aliases.has(node.text)
      && !ts.isImportSpecifier(node.parent) && !ts.isBindingElement(node.parent)) record(node);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && ((node.expression.text === "Bun" && ["spawn", "spawnSync"].includes(node.name.text))
        || (namespaces.has(node.expression.text) && primitives.has(node.name.text)))) record(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

test("launch discovery includes JavaScript aliases, CommonJS namespaces and forwarded primitives", () => {
  const sites: number[] = [];
  expect(launchReferences("helper.ts", 'import { spawnSync } from "node:child_process";\nspawnSync("tool");', sites)).toBe(true);
  expect(sites).toEqual([2]);
  expect(launchReferences("helper.js", 'import { spawn as launch } from "node:child_process"; launch("tool");')).toBe(true);
  expect(launchReferences("helper.cjs", 'const cp = require("child_process"); cp.spawn("tool");')).toBe(true);
  expect(launchReferences("helper.mjs", 'const cp = await import("node:child_process"); promisify(cp.execFile)("tool");')).toBe(true);
  expect(launchReferences("helper.ts", 'import type { ChildProcess } from "node:child_process"; const spawn = () => {}; spawn();')).toBe(false);
});

function discoveredHelpers(): string[] {
  const root = path.resolve(import.meta.dir, "..");
  const sources = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (["node_modules", ".git", ".next", "dist", ".claude"].includes(entry.name)) continue;
      const file = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/.test(file)) sources.set(file, read(file));
    }
  };
  walk("");
  const tests = [...sources].filter(([file]) => /\.test\.[cm]?[jt]sx?$/.test(file)).map(([, source]) => source).join("\n");
  const referenced = new Set([...tests.matchAll(/["'`]([^"'`\n]+?\.[cm]?[jt]sx?)["'`]/g)].map(match => path.posix.basename(match[1])));
  return [...sources].filter(([file, source]) => {
    const candidate = /\.test\.[cm]?[jt]sx?$/.test(file)
      || /(?:fixture|probe|harness|verify-|test-preload|test-child|owned-runner|local-gate-tests|integrationTestHome)/i.test(file)
      || /^scripts\/.*\.[cm]?jsx?$/.test(file)
      || referenced.has(path.basename(file));
    return candidate && /child_process|Bun\s*\.\s*spawn/.test(source) && launchReferences(file, source);
  }).map(([file]) => file).sort();
}

/** Observe-only probes and deliberate self-death do not authorize teardown.
 * The two injected product signal ports are exercised behind their product
 * ownership checks. Every other direct destructive PID call needs a visible
 * original-identity fence; teardown uses the shared helpers or child handles.
 */
function unfencedSignals(file: string, source: string): string[] {
  // Most tests contain no signal call. Avoid parsing their full syntax trees
  // so the repository-wide guard stays cheap under the gate's CPU cap.
  if (!source.includes("kill")) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const unsafe: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process"
      && node.expression.name.text === "kill") {
      const [target, signal] = node.arguments;
      const pid = target?.getText(tree);
      const kind = signal?.getText(tree);
      if (kind === "0" || pid === "process.pid" || node.arguments.length === 0) return;
      if (kind === "signal" && ["src/lib/resources.test.ts", "src/lib/runtime/structuredHostControl.test.ts"].includes(file)) return;
      let fenced = false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (!ts.isIfStatement(parent) || node.pos < parent.thenStatement.pos || node.end > parent.thenStatement.end) continue;
        const condition = parent.expression.getText(tree);
        if (!condition.includes("||") && !condition.trim().startsWith("!") && pid?.endsWith(".pid") && (condition.includes(`processIdentityStatus(${pid.slice(0, -4)}) === "alive"`)
          || condition.includes(`procBackend.processIdentity(${pid}) === ${pid.slice(0, -4)}.startIdentity`))) fenced = true;
      }
      if (!fenced) unsafe.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: destructive PID signal requires the recorded PID/start identity fence or an owned fixture cleanup helper`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return unsafe;
}

test("teardown signal audit rejects historical PIDs independently of the launch census", () => {
  expect(unfencedSignals("helper.test.ts", 'const ordinary = () => 1; ordinary();')).toEqual([]);
  expect(unfencedSignals("helper.test.ts", 'try { process.kill(oldPid, "SIGKILL"); } catch {}')).toEqual([
    "helper.test.ts:1: destructive PID signal requires the recorded PID/start identity fence or an owned fixture cleanup helper",
  ]);
  expect(unfencedSignals("helper.test.ts", 'process /* spacing */ . kill(oldPid, "SIGKILL");')).toHaveLength(1);
  expect(unfencedSignals("helper.test.ts", 'if (processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGTERM");')).toEqual([]);
  expect(unfencedSignals("helper.test.ts", 'if (processIdentityStatus(identity) === "alive") {} else process.kill(identity.pid, "SIGKILL");')).toHaveLength(1);
  expect(unfencedSignals("helper.test.ts", 'if (processIdentityStatus(identity) === "alive" || stale) process.kill(identity.pid, "SIGKILL");')).toHaveLength(1);
  const root = path.resolve(import.meta.dir, "..");
  const unsafe: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.test\.[cm]?[jt]sx?$/.test(file)) unsafe.push(...unfencedSignals(file, read(file)));
    }
  };
  walk("src"); walk("scripts");
  expect(unsafe).toEqual([]);
}, 30_000);

function missingCensusRow(file: string, source: string): string {
  const sites: number[] = [];
  launchReferences(file, source, sites);
  return `${file}:${sites[0]}: process launch requires a census row with its ownership or synchronous containment disposition in docs/verification/test-child-lifetime.md`;
}

test("the launch audit discovers JavaScript helpers rather than relying on existing row totals", () => {
  const helpers = discoveredHelpers();
  expect(helpers).toContain("scripts/npm-package-smoke.mjs");
  expect(helpers).toContain("scripts/verify-native-codex-delivery.mjs");
  expect(helpers).toContain("scripts/verify-native-codex-injection-races.mjs");
  const missing = (body: string) => helpers.filter(file => !body.includes(`| \`${file}\` |`));
  const missingRows = missing(audit).map(file => missingCensusRow(file, read(file)));
  expect(missingRows).toEqual([]);
  const removed = audit.split("\n").filter(line => !line.startsWith("| `scripts/npm-package-smoke.mjs` |")).join("\n");
  expect(missing(removed)).toContain("scripts/npm-package-smoke.mjs");
  expect(missingCensusRow("scripts/npm-package-smoke.mjs", read("scripts/npm-package-smoke.mjs")))
    .toMatch(/^scripts\/npm-package-smoke\.mjs:\d+: process launch requires a census row/);
}, 10_000);

test("the child audit includes dynamically imported synchronous Git launches", () => {
  const source = read("src/lib/boardMaintenance/run.test.ts");
  expect(source).toContain('const { execFileSync } = await import("node:child_process")');
  expect(source).toContain('=> execFileSync("git", args,');
  const row = audit.split("\n").find(line => line.startsWith("| `src/lib/boardMaintenance/run.test.ts` |"));
  expect(row).toContain("synchronous");
  expect(row).toContain("runner contains");
});

test("the child audit includes higher-order curl launches and their existing bounds", () => {
  const source = read("src/runtime-host/deploymentProxy.test.ts");
  expect(source.match(/promisify\(execFile\)\("curl"/g)).toHaveLength(3);
  expect(source.match(/"--max-time", "[35]"/g)).toHaveLength(3);
  const row = audit.split("\n").find(line => line.startsWith("| `src/runtime-host/deploymentProxy.test.ts` |"));
  expect(row).toContain("owned");
  expect(row).toContain("3/5-second");
  expect(row).toContain("awaited");
});

test("the child census counts unique files with complete disposition columns", () => {
  const tables = audit.split("Additional launch wiring")[0];
  const [asyncTable, syncTable] = tables.split("| File | Async launch sites | Disposition |")[1]
    .split("| File | Synchronous launch sites | Disposition |");
  const rows = (table: string) => table.split("\n").filter(line => line.startsWith("| `"));
  const asynchronous = rows(asyncTable);
  const synchronous = rows(syncTable);
  const all = [...asynchronous, ...synchronous];
  for (const row of all) expect(row).toMatch(/^\| `[^`]+` \| [^|]+ \| [^|]+ \|$/);
  expect(new Set(all.map(row => row.split("`")[1])).size).toBe(all.length);
  const counts = /census contains (\d+) files: (\d+) with asynchronous primitives and\n(\d+) with only synchronous primitives/.exec(tables);
  expect(counts?.slice(1).map(Number)).toEqual([all.length, asynchronous.length, synchronous.length]);
  expect(asyncTable).toContain("`scripts/verify-viewer-runtime.ts`");
  expect(syncTable).toContain("`scripts/verify-bun-runtime-controls.ts`");
});
