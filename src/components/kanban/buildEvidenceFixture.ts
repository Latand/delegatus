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

const [entry, outdir] = process.argv.slice(2);
if (!entry || !outdir) throw new Error("usage: buildEvidenceFixture.ts <entry> <outdir>");

const SERVER_DIRECTIVE = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use server["']/;

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
        if (!SERVER_DIRECTIVE.test(source)) return { contents: source, loader };
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
