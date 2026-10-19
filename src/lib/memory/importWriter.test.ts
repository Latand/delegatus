import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importWriterResolver } from "./importWriter";
import type { RegistryConversation } from "@/lib/agent/registry";

const roots: string[] = [];
const priorState = process.env.LLV_STATE_DIR;
afterEach(async () => { if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState; for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
test("writer attribution requires a real transcript, distinguishes designated seats from orchestrator stages and retains unknown writers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-writers-")); roots.push(root);
  const conversations: Pick<RegistryConversation, "id" | "engine" | "generations" | "agentRole">[] = [];
  for (const [session, role] of [["seat", "orchestrator"], ["stage", "orchestrator"], ["builder", "builder"], ["operator", null], ["gone", "builder"]] as const) {
    const transcript = path.join(root, `${session}.jsonl`);
    if (session !== "gone") await fs.writeFile(transcript, "{}\n");
    conversations.push({ id: `conversation_${session}`, engine: "claude", agentRole: role, generations: [{ id: session, path: transcript } as RegistryConversation["generations"][number]] });
  }
  const resolve = importWriterResolver(conversations, new Set(["conversation_seat"]), new Set(["conversation_stage", "conversation_builder", "conversation_gone"]));
  expect(await resolve("seat")).toEqual({ kind: "seat", roleId: "orchestrator" });
  expect(await resolve("stage")).toEqual({ kind: "stage", roleId: "orchestrator" });
  expect(await resolve("builder")).toEqual({ kind: "stage", roleId: "builder" });
  expect(await resolve("operator")).toEqual({ kind: "operator", roleId: null });
  expect(await resolve("gone")).toEqual({ kind: "unknown", roleId: null });
  expect(await resolve("absent")).toEqual({ kind: "unknown", roleId: null });
  conversations.push({ ...conversations[0], id: "conversation_conflict" });
  expect(await resolve("seat")).toEqual({ kind: "unknown", roleId: null });
});

test("production writer resolution reads registry membership and retained seat lineage from fixture state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-registry-")); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state"); await fs.mkdir(process.env.LLV_STATE_DIR!);
  const script = `
  import fs from "node:fs/promises";
  import path from "node:path";
  import { productionImportWriter } from ${JSON.stringify(path.join(import.meta.dir, "importWriter.ts"))};
  const root = path.dirname(process.env.LLV_STATE_DIR!);
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const prefix = ["00000000", "0000", "4000", "8000"].join("-");
  const sessions = [1, 2, 3].map(index => prefix + "-" + String(index).padStart(12, "0"));
  let seatId = "";
  for (let index = 0; index < 3; index++) {
    const sessionId = sessions[index], transcript = path.join(root, sessionId + ".jsonl");
    await fs.writeFile(transcript, JSON.stringify({ sessionId }) + String.fromCharCode(10));
    const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: root, role: index === 0 ? "orchestrator" : index === 1 ? "builder" : undefined, explicitProject: "fixture-project", clientAttemptId: "writer-" + index,
      ...(index === 1 ? { memberships: [{ kind: "pipeline", containerId: "fixture-pipeline", role: "builder", slot: "build:1", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null }] } : {}) });
    if (begun.kind !== "created") throw Error("writer fixture admission failed");
    registry.completeSpawn(begun.receipt.launchId, { key: { engine: "claude", sessionId }, artifactPath: transcript, cwd: root, accountId: null, status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    if (index === 0) seatId = begun.receipt.conversationId;
  }
  await fs.writeFile(path.join(process.env.LLV_STATE_DIR!, "orchestrator-seats.json"), JSON.stringify({ schemaVersion: 1, seats: {}, pending: {}, revocations: [], seatLineage: [{ project: "fixture-project", conversationId: seatId, seatEpoch: 1 }] }));
  const resolve = await productionImportWriter();
  process.stdout.write(JSON.stringify(await Promise.all(sessions.map(resolve))));
  registry.close();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, LLV_STATE_DIR: process.env.LLV_STATE_DIR }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
  try {
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    expect(JSON.parse(output)).toEqual([{ kind: "seat", roleId: "orchestrator" }, { kind: "stage", roleId: "builder" }, { kind: "operator", roleId: null }]);
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
});
