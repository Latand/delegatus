import { expect } from "bun:test";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NATIVE_GROUP, runSteps, type PlanEnvironment, type PushDeadline, type Step } from "./local-gate";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";

/** Shared fixture builders retain each owned file's roots and process identities. */
export function createGateTestFixtures(roots: string[], owned: ProcessIdentity[]) {
async function recordFixtureIdentities(files: string[], timeoutMs = 2_000): Promise<ProcessIdentity[]> {
  const until = Date.now() + timeoutMs;
  const identities: ProcessIdentity[] = [];
  for (const file of files) {
    while (!existsSync(file) && Date.now() < until) await Bun.sleep(10);
    const identity = captureProcessIdentity(Number(readFileSync(file, "utf8")));
    owned.push(identity);
    identities.push(identity);
    expect(processIdentityStatus(identity), "fixture reported with live PID/start/boot identity").toBe("alive");
  }
  return identities;
}
function context(overrides: Partial<PlanEnvironment> = {}): PlanEnvironment {
  return { base: "base", existing: new Set(["src/example.ts", "src/example.test.ts", "src/example.integration.test.ts", "src/example.browser.test.tsx", "image.png", "package.json"]), tests: ["src/example.test.ts", "src/example.integration.test.ts", "src/example.browser.test.tsx"], skippedMedia: [], linux: false, runtime: false, native: false, linuxTests: ["src/platform.test.ts"], runtimeTests: ["scripts/runtime.test.ts"], codexVersions: ["0.154.0", "0.159.0"], ...overrides };
}

function stepRunner(deadline: PushDeadline | null, scripts: (dir: string) => Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-steps-")); roots.push(dir);
  const lines: string[] = [], commands = scripts(dir);
  const run = (steps: Step[]) => runSteps("pre-push", steps, { root: dir, deadline, logDir: dir, say: line => lines.push(line),
    prepare: step => ({ command: ["bash", "-c", commands[step.name]!], env: process.env }) }).then(() => null, (caught: unknown) => caught);
  return { lines, run, dir };
}
const grouped = (name: string, deferrable = false): Step => ({ name, command: [], group: NATIVE_GROUP, ...(deferrable ? { deferrable } : {}) });
const soon = (ms: number): PushDeadline => ({ at: Date.now() + ms, startedAt: Date.now() });

return { recordFixtureIdentities, context, stepRunner, grouped, soon };
}
