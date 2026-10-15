/*
 * Bundles a rendered-evidence fixture for the browser, the way the Viewer's own
 * client bundle sees it (#2009). Run as its own process by
 * `serveEvidenceFixture`:
 *
 *   bun src/components/kanban/buildEvidenceFixture.ts <entry> <outdir>
 *
 * A `"use server"` module is a server action: Next replaces it with an RPC
 * stub in the client bundle, and its body — which reads the state directory
 * through Node built-ins — never reaches the browser. A plain browser build
 * bundles that body instead and fails on the first Node import, so this build
 * stands in for Next's replacement: each exported function becomes an async
 * one answering an empty record, which is what a server with nothing recorded
 * answers.
 */
import fs from "node:fs";
import ts from "typescript";

const [entry, outdir] = process.argv.slice(2);
if (!entry || !outdir) throw new Error("usage: buildEvidenceFixture.ts <entry> <outdir>");

const SERVER_DIRECTIVE = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use server["']/;

// Diagnostic twin of the ordinary production bundle. Wrap the existing
// factories at build time so no measurement code ships in the application.
function timeDerivation(source: string, file: string): string {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits: Array<[number, number, string]> = [];
  const short = file.split("/").at(-1)!;
  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(ast) === "useMemo") {
      const [factory, deps] = node.initializer.arguments;
      if (factory && deps && ts.isArrayLiteralExpression(deps)) {
        const name = `${short}:${node.name.getText(ast)}`;
        edits.push([factory.getStart(ast), factory.end,
          `__pdFactory(${JSON.stringify(name)},${factory.getText(ast)},${deps.getText(ast)},${JSON.stringify(deps.elements.map(e => e.getText(ast)))})`]);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.body && ["ProjectDashboardView", "KanbanBoard", "useBands"].includes(node.name?.text ?? "")) {
      const commit = node.name?.text === "ProjectDashboardView"
        ? "useEffect(() => { if (globalThis.__pdRecording) globalThis.__pdCatalogHead = { size: files[0]?.size, mtime: files[0]?.mtime }; }, [files]);" : "";
      edits.push([node.body.getStart(ast) + 1, node.body.getStart(ast) + 1, `const __pdRenderStart = performance.now(); try { ${commit}`]);
      edits.push([node.body.end - 1, node.body.end - 1, `} finally { if (globalThis.__pdRecording) globalThis.__pdRows.push({ name: ${JSON.stringify(`${short}:render`)}, start: __pdRenderStart, end: performance.now(), changed: [] }); }`]);
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + text + source.slice(end);
  return source + `
const __pdPrevious = new Map();
function __pdFactory(name, factory, deps, labels) {
  return () => {
    const w = globalThis;
    const previous = __pdPrevious.get(name);
    __pdPrevious.set(name, deps);
    const start = performance.now();
    try {
      const result = factory();
      if (w.__pdCapture) (w.__pdOutputs ??= {})[name] = result;
      return result;
    } finally {
      if (w.__pdRecording) {
        const end = performance.now();
        (w.__pdRows ??= []).push({ name, start, end, changed: labels.filter((_, i) => !previous || !Object.is(previous[i], deps[i])) });
      }
    }
  };
}
`;
}

// Historical scheduling control for the native send-paint experiment. Only
// fixture bundles can select it; a changed source shape refuses the control.
const serialComposer = process.argv.includes("--serial-composer-prerequisites");
function serialPrerequisites(source: string): string {
  for (const [manager, bridge] of [
    ["        const managerRead = withComposerAdmissionDeadline(", "        const bridge = await drainBridgeTurnStart();"],
    ["    const managerRead = durable || replayGeneration ? Promise.resolve(false) : withComposerAdmissionDeadline(", "    const bridgeTurn = durable || replayGeneration ? null : await drainBridgeTurnStart();"],
  ]) {
    if (source.split(manager).length !== 2 || source.split(bridge).length !== 2 || source.indexOf(manager) > source.indexOf(bridge)) {
      throw new Error("serial composer control no longer matches the prerequisite sites");
    }
    source = source.replace(bridge + "\n", "").replace(manager, bridge + "\n" + manager);
  }
  return source;
}

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [{
    name: "server-action-stubs",
    setup(build) {
      build.onLoad({ filter: /\/src\/.*\.tsx?$/ }, (args) => {
        let source = fs.readFileSync(args.path, "utf8");
        if (serialComposer && args.path.replaceAll("\\", "/").endsWith("/src/components/TmuxComposer.tsx")) source = serialPrerequisites(source);
        const loader = args.path.endsWith(".tsx") ? "tsx" : "ts";
        if (!SERVER_DIRECTIVE.test(source)) return {
          contents: process.env.LLV_DERIVATION_TIMING === "1" && /\/(ProjectDashboard|KanbanBoard|useBands)\.tsx?$/.test(args.path)
            ? timeDerivation(source, args.path) : source,
          loader,
        };
        const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const|let)\s+(\w+)/gm)].map((match) => match[1]);
        return { contents: names.map((name) => `export async function ${name}() { return {}; }`).join("\n"), loader: "ts" };
      });
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
