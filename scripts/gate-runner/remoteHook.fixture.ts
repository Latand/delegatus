// Pre-push's local admission is explicit even when a legacy runner is configured.
// Shared by remoteHook.test.ts and remoteHookUnreachable.test.ts: six full
// pre-push runs outlast one file's gate budget on a loaded host.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { git, makeHarness, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
const E2E_TIMEOUT = 240_000;
const RUNNING = /^gate-runner: running on the gate runner \(run [0-9a-f]{12}, tree [0-9a-f]{12}\)$/m;
const ENTRIES = [
  ["bun", "scripts/local-gate.ts", "pre-push"],
  ["bash", ".githooks/pre-push"],
  ["./.githooks/pre-push"],
];

export function privacyParentCases(reachable: boolean) {
  const harnesses: Harness[] = [];
  afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
  const remoteRuns = (h: Harness) => h.calls().filter(call => call.command.includes("serve.ts run"));
  for (const argv of ENTRIES) test.if(linux)(`a wrapped privacy parent keeps local checks with a ${reachable ? "reachable" : "unreachable"} legacy runner: ${argv.join(" ")}`, () => {
    const h = makeHarness(); harnesses.push(h);
    if (!reachable) h.settings({ failProbe: true });
    const file = testFile(h, "parent.test.ts", `test("one", () => expect(1).toBe(1));`);
    fs.writeFileSync(path.join(h.fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", paths: { "@/*": ["./src/*"] }, skipLibCheck: true, types: ["bun"], noEmit: true },
      include: [file],
    }));
    git(h.fixture, "add", "-A");
    git(h.fixture, "commit", "--quiet", "--no-verify", "-m", "privacy parent fixture");
    const base = git(h.fixture, "rev-parse", "HEAD");
    git(h.fixture, "update-ref", "refs/remotes/origin/main", base);
    git(h.root, "--git-dir", h.mirror, "update-ref", "refs/heads/main", base);
    git(h.fixture, "remote", "set-url", "origin", h.mirror);
    fs.appendFileSync(path.join(h.fixture, file), "\n// Changed input.\n");
    const result = h.run(argv);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(RUNNING);
    expect(result.stdout + result.stderr).toContain("PRIVACY GATE: PASS");
    expect(result.stderr).toContain("pre-push: types: passed");
    expect(result.stderr).toContain("pre-push: touched tests: passed");
    expect(remoteRuns(h)).toHaveLength(0);
    expect(h.calls()).toHaveLength(0);
  }, E2E_TIMEOUT);
}
