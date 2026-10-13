import { expect, test } from "bun:test";
import { ROLE_DEFAULTS } from "./defaults";
import { resolveRole, roleSpawnPrompt } from "./registry";
import { ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateForDelivery } from "@/lib/orchestrator/prompt";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setMachineWorkerLimit, setProjectWorkerLimit } from "@/lib/operator/workerLimit";

const old = "- Keep no more workers running at once than your role parameters allow (3 when they name none), in every mode: each running lane and each live spawned agent counts as one.";
test("retired maxWorkers is ignored and no shipped scaffold names a worker number", () => {
  const role = resolveRole("orchestrator", { maxWorkers: 20 });
  expect(role.ok).toBe(true);
  if (!role.ok) throw new Error(role.error);
  expect(role.value.params).not.toHaveProperty("maxWorkers");
  expect(ROLE_DEFAULTS.find(row => row.id === "orchestrator")!.promptScaffold).not.toContain("maxWorkers");
  expect(roleSpawnPrompt({ role: "orchestrator", scaffold: role.value.prompt }, "Run the project")).toContain("worker limit each wake and get_orchestrator state");
});
test("the mandate names the live limit and delivery repairs an older mandate", () => {
  expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("worker limit each wake and get_orchestrator state");
  expect(orchestratorMandateForDelivery(old)).not.toContain("3 when they name none");
});

test("a stored scaffold with the retired placeholder renders the project's effective limit", () => {
  const previous = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-scaffold-"));
  process.env.LLV_STATE_DIR = root;
  try {
    const actor = { kind: "operator", via: "settings" } as const;
    setMachineWorkerLimit(8, actor, null); setProjectWorkerLimit("one", 10, actor, null);
    const definitions = ROLE_DEFAULTS.map(row => row.id === "orchestrator" ? { ...row, promptScaffold: "limit {{maxWorkers}}" } : row);
    const resolved = resolveRole("orchestrator", { maxWorkers: 1 }, {}, definitions, "one");
    expect(resolved.ok && resolved.value.prompt).toStartWith("limit 10");
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
