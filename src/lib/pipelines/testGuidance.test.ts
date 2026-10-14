import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStageTestGuidance } from "./testGuidance";

test("standalone assembly finds the install and quotes its wrapper for another checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-gate-guidance-"));
  const install = path.join(root, "tool's installed copy");
  const standalone = path.join(install, "dist", "standalone");
  const checkout = path.join(root, "project");
  const wrapper = path.join(install, "scripts", "gate-slot.sh");
  try {
    for (const directory of [standalone, checkout, path.dirname(wrapper), path.join(install, "bin")]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(standalone, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(install, "bin", "cli.mjs"), "");
    fs.writeFileSync(wrapper, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
    for (const file of ["owned-runner.ts", "cpu-admission.ts"]) fs.writeFileSync(path.join(install, "scripts", file), "");
    const guidance = resolveStageTestGuidance(standalone);
    const command = guidance.match(/: (bash .+?) <project-test-command>/)?.[1];
    expect(command).toBeDefined();
    const result = spawnSync("bash", ["-c", `${command} npm test -- src/example.test.ts`], { cwd: checkout, encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("npm\ntest\n--\nsrc/example.test.ts\n");
    fs.unlinkSync(path.join(install, "scripts", "owned-runner.ts"));
    expect(resolveStageTestGuidance(standalone)).toContain("Gate wrapper unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
