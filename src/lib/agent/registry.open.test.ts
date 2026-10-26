import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertStateChildSuccess } from "@/lib/state/stateChildResult.fixture";

async function openAt(site: string, outcome: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-open-"));
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "registry.open.fixture.ts"), site, outcome], {
    env: { ...process.env, LLV_STATE_DIR: root, LLV_AGENT_REGISTRY_SQLITE: "sqlite" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    assertStateChildSuccess(code, stderr);
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const site of ["runAtomically", "importFirstBoot"]) {
  test(`startup retries the entire registry open at ${site} and retains the peer commit`, async () => {
    const result = await openAt(site, "success");
    expect(result.busy).toBe(true);
    expect(result.busyErrno).toBe(5);
    expect(result.error).toBeNull();
    expect(result.yielded).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.sameSingleton).toBe(true);
    expect(result.preserved).toBe("preserved");
    expect(result.waits.refused).toBe(0);
    expect(result.waits.active).toEqual([]);
    expect(result.recovered).toBe(true);
  });

  for (const outcome of ["cancel", "deadline", "timeout", "error"]) {
    test(`startup ${outcome} at ${site} leaves no singleton and permits a fresh open`, async () => {
      const result = await openAt(site, outcome);
      expect(result.error).toContain(outcome === "cancel" ? "registry open withdrawn"
        : outcome === "deadline" ? "state admission is busy"
        : outcome === "timeout" ? "state admission timed out" : "registry open fixture failure");
      expect(result.attempts).toBe(1);
      expect(result.busy).toBe(outcome !== "error");
      expect(result.publishedAfterFailure).toBe(false);
      expect(result.recovered).toBe(true);
      expect(result.waits.active).toEqual([]);
      if (outcome !== "error") expect(result.preserved).toBe("preserved");
    });
  }
}
