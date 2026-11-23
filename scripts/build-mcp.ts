import path from "node:path";
import fs from "node:fs";

// Lifecycle fixtures can build the production bundle inside their own sandbox.
const result = await Bun.build({
  entrypoints: [path.join(process.cwd(), "src/lib/mcp/entry.ts")],
  outdir: process.argv[2] ?? path.join(process.cwd(), "dist"),
  naming: "mcp-server.mjs",
  target: "node",
  format: "esm",
  external: [
    "@modelcontextprotocol/sdk/*",
    "zod",
    "react",
    "react/*",
    "lucide-react",
    "highlight.js",
    "qrcode",
    "qrcode-terminal",
  ],
  plugins: [{
    name: "node-esm-next-entrypoints",
    setup(build) {
      build.onResolve({ filter: /^next(?:\/.*)?$/ }, (args) => ({
        path: args.path === "next/server" ? "next/server.js" : args.path,
        external: true,
      }));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  const output = result.outputs[0];
  const source = await Bun.file(output.path).text();
  const nodeEsmSource = source.replaceAll('"next/server"', '"next/server.js"');
  await Bun.write(output.path, nodeEsmSource);
  // Managed MCP releases copy dist in full. Retain the exact pinned data next
  // to the bundle so admission also works without a source checkout.
  const protocols = path.join(process.cwd(), "src/lib/accounts/protocol");
  for (const version of fs.readdirSync(protocols)) {
    const destination = path.join(path.dirname(output.path), "codex-protocol", version);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ["manifest", "stable", "experimental"]) {
      fs.copyFileSync(path.join(protocols, version, `${name}.json`), path.join(destination, `${name}.json`));
    }
  }
  console.log(`Built ${path.relative(process.cwd(), output.path)} (${Buffer.byteLength(nodeEsmSource)} bytes)`);
}
