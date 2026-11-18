import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";

test("runtime sandbox imports from the Docker runtime stage's shipped source layout", () => {
  const root = path.resolve(import.meta.dir, "..");
  const image = fs.mkdtempSync(path.join(os.tmpdir(), "gate-runtime-image-"));
  try {
    for (const name of ["src", "bin"]) fs.cpSync(path.join(root, name), path.join(image, name), { recursive: true });
    for (const name of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(root, name), path.join(image, name));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(image, "node_modules"), "dir");
    fs.mkdirSync(path.join(image, "scripts"));
    // Exercise the files the image actually ships, without making an unshipped
    // scripts import resolve through the source checkout.
    for (const line of fs.readFileSync(path.join(root, "Dockerfile"), "utf8").split("\n")) {
      if (!line.startsWith("COPY --from=build ")) continue;
      for (const match of line.matchAll(/\/app\/(scripts\/[^\s]+)/g)) {
        fs.copyFileSync(path.join(root, match[1]!), path.join(image, match[1]!));
      }
    }
    const env = withoutInheritedGate({ ...process.env });
    env.LLV_STATE_DIR = path.join(image, "state");
    const imported = spawnSync(process.execPath, ["-e", 'await import("./src/lib/runtime/agentSignalSandbox.ts"); console.log("runtime sandbox loaded");'],
      { cwd: image, env, encoding: "utf8", timeout: 15_000 });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toBe("runtime sandbox loaded\n");
  } finally { fs.rmSync(image, { recursive: true, force: true }); }
}, 30_000);
