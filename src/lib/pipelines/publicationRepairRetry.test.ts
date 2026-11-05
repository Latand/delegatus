import { expect, test, fs, os, path, tickPipelines, savePipelines, rawPatchPipeline } from "./engine.fixture";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";
import { realExec } from "@/lib/workflows/provision";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { once } from "node:events";
import { defaultPipelinePorts } from "./engine";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

isolatePublicationGit();

async function parkedRepair(f: Awaited<ReturnType<typeof fixture>>) {
  let clock = Date.parse(f.h.ports.now());
  f.h.ports.now = () => new Date(clock).toISOString();
  f.h.ports.resumeSeveredTurn = async () => false;
  const accepted = await f.commit("accepted implementation");
  f.refuse(); await f.finish();
  clock += 21 * 60_000;
  await tickPipelines([], f.h.ports);
  expect(current().state).toBe("needs_decision");
  expect(current().runs[0]!.attempts[0]!.publicationRepair).toBeDefined();
  return accepted;
}

async function repairRuntime(root: string, conversationId: string) {
  const journal = new RuntimeJournal(path.join(root, "retry-runtime.sqlite"));
  const host = new RuntimeHost(journal);
  const directory = process.platform === "linux" ? fs.openSync(root, "r") : null;
  const priorSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  const socket = directory !== null ? `/proc/${process.pid}/fd/${directory}/retry.sock`
    : process.platform === "win32" ? `\\\\.\\pipe\\repair-retry-${process.pid}` : path.join(root, "retry.sock");
  process.env.LLV_RUNTIME_HOST_SOCKET = socket;
  const server = serveRuntimeHost(socket, { handle: request => host.handle(request) });
  await once(server, "listening");
  return {
    publish(state: "dead" | "running" | "attention" | "conflict") {
      journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status",
        payload: { conversationId, sessionKey: { engine: "codex", sessionId: "repair-owner" },
          hostKind: "codex-app-server", host: state === "running" || state === "attention" ? "hosted" : state,
          turn: state === "running" ? "running" : "idle", activeTurnId: state === "running" ? "repair-turn" : null,
          attentionIds: state === "attention" ? ["permission"] : [] } });
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (priorSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
      else process.env.LLV_RUNTIME_HOST_SOCKET = priorSocket;
      if (directory !== null) fs.closeSync(directory);
      journal.close();
    },
  };
}

test.each([{ adopted: true }, { adopted: false }])("retry honors activity after the gone read (adopted: $adopted)", async ({ adopted }) => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof repairRuntime>> | undefined;
  try {
    const accepted = await parkedRepair(f);
    const original = structuredClone(current().runs[0]!.attempts[0]!);
    const receipts = path.join(stageGitReceiptDirectory(original.launchId!), "commits");
    const recorded = fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")]);
    runtime = await repairRuntime(f.root, original.conversationId!);
    runtime.publish("dead");
    const production = defaultPipelinePorts();
    const gone: Array<boolean | null> = [], active: Array<boolean | null> = [];
    f.h.ports.conversationTurnInterrupted = production.conversationTurnInterrupted;
    f.h.ports.publicationRepairProducerGone = async id => {
      const result = await production.publicationRepairProducerGone!(id);
      gone.push(result);
      if (adopted) runtime!.publish("running");
      return result;
    };
    f.h.ports.conversationAgentActive = async id => {
      const result = await production.conversationAgentActive(id);
      active.push(result); return result;
    };
    const answer = await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    expect(gone).toEqual([true]);
    expect(active).toEqual([adopted]);
    expect(answer.status ?? 200).toBe(adopted ? 409 : 200);
    expect(current().runs[0]!.attempts).toHaveLength(adopted ? 1 : 2);
    expect(current().runs[0]!.attempts[0]!.report).toEqual(original.report);
    expect(current().runs[0]!.attempts[0]!.verdict).toEqual(original.verdict);
    expect(current().lastPassedCommit).toBe(accepted);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
    expect(fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")])).toEqual(recorded);
    if (adopted) expect(current().runs[0]!.attempts[0]!.publicationRepairAbandonment).toBeUndefined();
  } finally { await runtime?.close(); f.close(); }
});

test.each([
  { host: "dead", age: 21 * 60_000, retries: true },
  { host: "dead", age: 365 * 24 * 60 * 60_000, retries: true },
  { host: "running", age: 21 * 60_000, retries: false },
  { host: "attention", age: 21 * 60_000, retries: false },
  { host: "conflict", age: 21 * 60_000, retries: false },
] as const)("operationless legacy repair after restart ($host, $age ms)", async ({ host, age, retries }) => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof repairRuntime>> | undefined;
  let registry: AgentRegistry | undefined;
  try {
    const accepted = await parkedRepair(f);
    const file = path.join(f.root, "legacy-registry.json");
    registry = new AgentRegistry(file, undefined, undefined, { sqliteMode: "off" });
    const conversation = registry.ensureForkedConversation("codex", path.join(f.root, "producer.jsonl"),
      "fixture-account", emptyLaunchProfile({ cwd: f.lane() }));
    registry.requestConversationReseat(conversation.id, "successor-account");
    const held = registry.holdDelivery(conversation.id, "preserve unrelated message", "unrelated-message", "text", [], null,
      { operationId: "unrelated-operation", kind: "send", policy: "queue" });
    expect(held.state).toBe("held");
    registry.close(); registry = undefined;
    // Replay the writer's real output with the pre-evidence-tracking schema.
    const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
    delete legacy.conversations[conversation.id].deliveryEvidenceTracked;
    fs.writeFileSync(file, JSON.stringify(legacy));
    const lane = current();
    lane.runs[0]!.attempts[0]!.conversationId = conversation.id;
    savePipelines([lane]);
    const prompt = "Use the current stage instruction to repair the refusal.";
    expect((await rawPatchPipeline(lane.id, { action: "override-stage", stageId: "build", prompt }, f.h.ports)).error).toBeUndefined();
    const original = structuredClone(current().runs[0]!.attempts[0]!);
    const receipts = path.join(stageGitReceiptDirectory(original.launchId!), "commits");
    const recorded = fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")]);
    runtime = await repairRuntime(f.root, conversation.id);
    runtime.publish(host);
    const now = new Date(Date.parse(original.publicationRepair!.refusedAt) + age).toISOString();
    const result = await realExec(process.execPath, ["-e", `
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry");
      const registry = new AgentRegistry(${JSON.stringify(file)}, undefined, undefined, { sqliteMode: "off" });
      setAgentRegistryForTests(registry);
      const { defaultPipelinePorts, patchPipeline } = await import("./src/lib/pipelines/engine");
      const { findPipelineRecord } = await import("./src/lib/pipelines/store");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal");
      registerPipelineTick(async () => {});
      const { stageRepairDelivery } = await import("./src/lib/pipelines/repairDelivery");
      const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(now)}, durableTurnEvidence: async () => null,
        stageRepairDelivery: (c, k, d) => stageRepairDelivery(registry, c, k, d,
          { client: null, progress: null, now: () => Date.parse(${JSON.stringify(now)}) }) };
      const before = findPipelineRecord(${JSON.stringify(lane.id)}).runs[0].attempts[0].publicationRepair;
      const delivery = await ports.stageRepairDelivery(${JSON.stringify(conversation.id)}, before.clientMessageId,
        Date.parse(before.refusedAt) + 20 * 60_000);
      const heldBefore = registry.pendingDeliveries(${JSON.stringify(conversation.id)});
      const answer = await patchPipeline(${JSON.stringify(lane.id)}, { action: "retry-stage" }, ports);
      console.log(JSON.stringify({ status: answer.status ?? 200, error: answer.error, delivery, heldBefore,
        heldAfter: registry.pendingDeliveries(${JSON.stringify(conversation.id)}) }));
      registry.close();
    `], process.cwd(), { ...process.env }, { timeoutMs: 30_000 });
    expect(result.code, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout);
    expect(answer.delivery).toEqual({ operationId: null, state: "failed", safeToReplace: false });
    expect(answer.status).toBe(retries ? 200 : 409);
    expect(answer.heldAfter).toEqual(answer.heldBefore);
    expect(answer.heldAfter).toContainEqual(expect.objectContaining({ clientMessageId: "unrelated-message", state: "held", text: "preserve unrelated message" }));
    const updated = current();
    expect(updated.runs[0]!.attempts).toHaveLength(retries ? 2 : 1);
    expect(updated.stages[0]!.prompt).toBe(prompt);
    expect(updated.lastPassedCommit).toBe(accepted);
    expect(updated.runs[0]!.attempts[0]!.report).toEqual(original.report);
    expect(updated.runs[0]!.attempts[0]!.verdict).toEqual(original.verdict);
    expect(fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")])).toEqual(recorded);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
    if (retries) {
      expect(updated.cursor).toMatchObject({ stageId: "build", state: "pending" });
      expect(updated.cursor?.input).toContain("pre-push: touched tests");
      expect(updated.cursor?.input).toContain("accepted head");
      expect(updated.runs[0]!.attempts[0]!.publicationRepair?.delivery).toEqual(answer.delivery);
    }
  } finally { await runtime?.close(); registry?.close(); f.close(); }
});
