import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";

for (const form of ["array", "array-options", "object", "empty-env"] as const) test(`Bun ${form} spawn records ownership and supplies its runner binding before readiness`, async () => {
  const command = [process.execPath, "-e", "console.log(process.env.LLV_FIXTURE_PARENT_IDENTITY)"];
  const child = form === "array" ? Bun.spawn(command)
    : form === "array-options" ? Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    : Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe", ...(form === "empty-env" ? { env: {} } : {}) });
  const identity = captureProcessIdentity(child.pid);
  try {
    // This read precedes every await, so late report-time registration fails.
    const ledger = fs.readFileSync(path.join(os.tmpdir(), "owned-test-children.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as ProcessIdentity);
    expect(ledger).toContainEqual(identity);
    const binding = JSON.parse(await new Response(child.stdout).text());
    expect(binding).toEqual(captureProcessIdentity(process.pid));
    expect(await child.exited).toBe(0);
  } finally {
    if (processIdentityStatus(identity) === "alive") child.kill("SIGKILL");
    await child.exited;
    expect(processIdentityStatus(identity)).toBe("dead");
  }
}, 5_000);
