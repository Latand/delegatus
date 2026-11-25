import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Next traces route imports. Launcher bundles and public URLs also need their
// complete runtime inputs, independently of the files its tracer discovers.
export async function assembleStandaloneRuntime(root, standalone) {
  for (const directory of ["bin", "public", "vendor"]) {
    await cp(join(root, directory), join(standalone, directory), { recursive: true });
  }
  const bundles = join(standalone, "dist");
  await mkdir(bundles, { recursive: true });
  for (const bundle of ["mcp-server.mjs", "runtime-host.mjs", "gate"]) {
    await cp(join(root, "dist", bundle), join(bundles, bundle), { recursive: true });
  }
  // A broad Next trace can copy the checkout's .gitignore here. npm applies
  // that nested file even though package.json includes the outer dist tree,
  // dropping .next and dist (including MCP's bundle) from the tarball. This
  // deployment needs those generated trees and traced dependencies. Preserve
  // the checkout's other exclusions, including local configuration files.
  // Broad traces can also collect the compiler cache; keep it out of npm.
  const ignored = await readFile(join(root, ".gitignore"), "utf8");
  await writeFile(join(standalone, ".npmignore"), `${ignored}\n# Ship the assembled standalone runtime.\n!/dist/\n!/.next/\n!/node_modules/\n/.next/cache/\n`);
}
