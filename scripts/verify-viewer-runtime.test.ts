import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

import {
  BUILT_SERVER_DIR,
  COMPILED_SERVER_DIR,
  REQUIRED_SERVER_RUNTIME,
  missingRequiredModules,
  servedRuntimeModules,
  verifyViewerRuntime,
} from "./verify-viewer-runtime";

/* What this file is defending is the shape of the check rather than its
   verdict: the verdict is produced by CI, under the pinned interpreter, on a
   real build. A probe that reaches no modules also reports no failures, so
   every way of arriving at an empty target list has to be a failure here. */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-runtime-test-"));
  roots.push(root);
  for (const file of files) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "");
  }
  return root;
}

test("the probe loads every compiled server runtime and every bundle the build writes", () => {
  const root = fixtureRoot([
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
    path.join(COMPILED_SERVER_DIR, "server.runtime.prod.js"),
    path.join(COMPILED_SERVER_DIR, "app-page.runtime.dev.js"),
    path.join(COMPILED_SERVER_DIR, `${REQUIRED_SERVER_RUNTIME}.map`),
    path.join(BUILT_SERVER_DIR, "middleware.js"),
    path.join(BUILT_SERVER_DIR, "file-scanner-worker.js"),
    path.join(BUILT_SERVER_DIR, "next-font-manifest.js"),
    path.join(BUILT_SERVER_DIR, "chunks", "994.js"),
  ]);

  const modules = servedRuntimeModules(root);

  expect(modules).toContain(path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME));
  expect(modules).toContain(path.join(COMPILED_SERVER_DIR, "server.runtime.prod.js"));
  expect(modules).toContain(path.join(BUILT_SERVER_DIR, "middleware.js"));
  expect(modules).toContain(path.join(BUILT_SERVER_DIR, "file-scanner-worker.js"));
  // The development runtimes are never served, the manifests are data those
  // bundles read, the chunks are reached through the webpack runtime, and a
  // source map is not a module at all.
  expect(modules).not.toContain(path.join(COMPILED_SERVER_DIR, "app-page.runtime.dev.js"));
  expect(modules).not.toContain(path.join(COMPILED_SERVER_DIR, `${REQUIRED_SERVER_RUNTIME}.map`));
  expect(modules).not.toContain(path.join(BUILT_SERVER_DIR, "next-font-manifest.js"));
  expect(modules).not.toContain(path.join(BUILT_SERVER_DIR, "chunks", "994.js"));
});

test("a build the probe cannot find is named, not passed over", () => {
  const root = fixtureRoot([]);

  expect(missingRequiredModules(servedRuntimeModules(root))).toEqual([
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
    path.join(BUILT_SERVER_DIR, "*.js"),
  ]);
});

test("the runtime whose load failure answered 500 on every route is required by name", () => {
  /* Everything else present and that one absent: the framework moved it, or
     renamed it, and the glob quietly went on reporting no failures. */
  const root = fixtureRoot([
    path.join(COMPILED_SERVER_DIR, "server.runtime.prod.js"),
    path.join(BUILT_SERVER_DIR, "middleware.js"),
  ]);

  expect(missingRequiredModules(servedRuntimeModules(root))).toEqual([
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
  ]);
});

test("verification of a directory with no build fails, and says that is what happened", async () => {
  const root = fixtureRoot([]);

  const report = await verifyViewerRuntime(root);

  expect(report.ok).toBe(false);
  expect(report.detail).toContain("no build");
  expect(report.modules.probed).toBe(0);
  expect(report.served).toBeNull();
});

test.skipIf(process.platform !== "linux")("verification reaps its served process and detached worker before reporting success", async () => {
  const root = fixtureRoot([
    "package.json", "node_modules/next/dist/server/node-environment.js",
    path.join(COMPILED_SERVER_DIR, REQUIRED_SERVER_RUNTIME),
    path.join(BUILT_SERVER_DIR, "middleware.js"), "node_modules/.bin/next",
  ]);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.symlinkSync(import.meta.dir, path.join(root, "scripts"), "dir");
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": [path.resolve(import.meta.dir, "../src/*")] } } }));
  const server = path.join(root, "node_modules/.bin/next");
  fs.writeFileSync(server, `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    import { captureProcessIdentity } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/lib/processIdentity.ts"))};
    const port = Number(process.argv.at(-1));
    const record = ${JSON.stringify(path.join(root, "served.json"))};
    const worker = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(record, JSON.stringify({ identity: captureProcessIdentity(process.pid), worker: captureProcessIdentity(worker.pid) }));
    Bun.serve({ port, fetch: () => new Response("synthetic viewer") });
    process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
  `);
  const bystander = spawn("/bin/sh", ["-c", "exec sleep 300"], { detached: true, stdio: "ignore" });
  const other = captureProcessIdentity(bystander.pid!);
  let owned: ProcessIdentity | undefined;
  let worker: ProcessIdentity | undefined;
  try {
    const report = await verifyViewerRuntime(root);
    if (!report.ok) throw new Error(JSON.stringify(report));
    ({ identity: owned, worker } = JSON.parse(fs.readFileSync(path.join(root, "served.json"), "utf8")));
    expect(processIdentityStatus(owned!)).toBe("dead");
    expect(processIdentityStatus(worker!)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("alive");
  } finally {
    if (!owned && fs.existsSync(path.join(root, "served.json"))) ({ identity: owned, worker } = JSON.parse(fs.readFileSync(path.join(root, "served.json"), "utf8")));
    for (const identity of [owned, worker]) if (identity && processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    const deadline = Date.now() + 2_000;
    while ([owned, worker].some(identity => identity && processIdentityStatus(identity) === "alive") && Date.now() < deadline) await Bun.sleep(20);
    await stopFixtureProcess(bystander);
    if (owned) expect(processIdentityStatus(owned)).toBe("dead");
    if (worker) expect(processIdentityStatus(worker)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("dead");
  }
}, 10_000);
