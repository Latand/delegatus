import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStageTestGuidance } from "./testGuidance";
import { resolveSignalTooling } from "@/lib/runtime/agentSignalSandbox";

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
    fs.writeFileSync(wrapper, '#!/bin/bash\n# LLV_SIGNAL_SANDBOX\nprintf "%s\\n" "$@"\n');
    for (const file of ["owned-runner.ts", "cpu-admission.ts", "gate-wait.ts"]) fs.writeFileSync(path.join(install, "scripts", file), "runSandboxGate");
    fs.writeFileSync(path.join(install, "bin", "agent-signal-sandbox.py"), "");
    const guidance = resolveStageTestGuidance(standalone);
    const command = guidance.match(/: (bash .+?) <project-test-command>/)?.[1];
    expect(command).toBeDefined();
    const result = spawnSync("bash", ["-c", `${command} npm test -- src/example.test.ts`], { cwd: checkout, encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("npm\ntest\n--\nsrc/example.test.ts\n");
    fs.unlinkSync(path.join(install, "scripts", "owned-runner.ts"));
    expect(() => resolveSignalTooling(standalone)).toThrow("Gate wrapper unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packed tooling resolves without source files and the container bridge publishes host-visible bundles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packed-signal-tooling-"));
  const scripts = path.join(root, "dist/gate");
  const previous = process.env.LLV_DOCKER_NSENTER_SHIMS;
  try {
    fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(root, "bin/cli.mjs"), "");
    fs.writeFileSync(path.join(root, "bin/agent-signal-sandbox.py"), "# packed launcher");
    fs.writeFileSync(path.join(scripts, "gate-slot.sh"), "# LLV_SIGNAL_SANDBOX");
    for (const name of ["owned-runner.ts", "cpu-admission.ts", "test-child-guardian.ts", "gate-wait.ts"]) fs.writeFileSync(path.join(scripts, name), "// runSandboxGate");
    delete process.env.LLV_DOCKER_NSENTER_SHIMS;
    expect(resolveSignalTooling(root).gate).toBe(fs.realpathSync(path.join(scripts, "gate-slot.sh")));
    process.env.LLV_DOCKER_NSENTER_SHIMS = "1";
    const tooling = resolveSignalTooling(root);
    expect(tooling.gate).toStartWith(path.join(os.homedir(), ".cache/delegatus/signal-tooling/"));
    expect(fs.readFileSync(tooling.launcher, "utf8")).toBe("# packed launcher");
    expect(fs.readFileSync(path.join(path.dirname(tooling.gate), "gate-wait.ts"), "utf8")).toBe("// runSandboxGate");
    expect(resolveSignalTooling(root)).toEqual(tooling);
    fs.unlinkSync(path.join(scripts, "test-child-guardian.ts"));
    expect(() => resolveSignalTooling(root)).toThrow("Gate wrapper unavailable");
  } finally {
    if (previous === undefined) delete process.env.LLV_DOCKER_NSENTER_SHIMS; else process.env.LLV_DOCKER_NSENTER_SHIMS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
