import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { retainProviderRedactionSecrets } from "@/lib/accounts/providerSecretRedaction";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import { loadTasks, loadTasksFile, mutateTasksFile } from "@/lib/tasks/store";
import { productionDomainDependencies, viewerMcpBindings } from "./bindings";

const now = "2026-10-26T22:30:00.000Z";
const retryAt = "2026-10-26T22:31:00.000Z";
const failure = "native protocol verification failed";
const admissionWait = "runtime host admission is unavailable";
const directories: string[] = [];
let registry: AgentRegistry | undefined;
let restoreTasks: (() => void) | undefined;

afterEach(() => {
  registry?.close();
  setAgentRegistryForTests(null);
  restoreTasks?.();
  restoreTasks = undefined;
  setSystemTime();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(mode: "off" | "sqlite") {
  setSystemTime(new Date(now));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-conversation-"));
  directories.push(directory);
  const priorTasks = loadTasksFile();
  restoreTasks = () => mutateTasksFile(() => ({ state: priorTasks, result: undefined }));
  const filename = path.join(directory, "registry.json");
  const open = () => {
    registry = new AgentRegistry(filename, () => false, undefined, { sqliteMode: mode });
    setAgentRegistryForTests(registry);
    return registry;
  };
  open();
  const begun = registry!.beginSpawnRequest({
    engine: "codex", cwd: directory, transport: "structured", accountId: "account-a", accountPin: true,
    conversationId: "conversation_accepted_spawn", clientAttemptId: "accepted-spawn",
    launchProfile: { cwd: directory, title: "Read accepted launch", project: "fixture" },
  });
  if (begun.kind !== "created") throw new Error("fixture launch was not created");
  const receipt = begun.receipt;
  const transcriptPath = path.join(process.env.LLV_CODEX_HOME!, "sessions", path.basename(directory), "accepted.jsonl");
  const bindings = viewerMcpBindings(undefined, undefined, {
    ...productionDomainDependencies,
    completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
    listFiles: async () => { throw new Error("unexpected corpus scan"); },
    livenessSources: () => ({
      ...productionLivenessSources(),
      pipelines: () => [], flows: () => [],
      selectInventory: async () => { throw new Error("unexpected inventory scan"); },
    }),
    refreshLifecycleJournal: () => ({ appended: 0, skipped: 0, throttled: false }),
  });
  const settle = (launchId = receipt.launchId) => registry!.settleSpawn(launchId, {
    key: { engine: "codex", sessionId: "accepted-native-session" }, artifactPath: transcriptPath,
    cwd: directory, accountId: "account-a", status: "unhosted", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  return { directory, receipt, bindings, transcriptPath, settle, restart: () => { registry!.close(); open(); } };
}

for (const mode of ["off", "sqlite"] as const) {
  test.each(["starting", "waiting", "failed", "launched"] as const)(`accepted %s is readable before its transcript (${mode})`, async state => {
    const f = fixture(mode);
    if (state === "waiting") registry!.queuePinnedSpawn(f.receipt.launchId, {
      version: 1, retryAt, admissionDeadlineAt: "2026-10-26T22:35:00.000Z", lastAdmissionError: admissionWait,
      accountId: "account-a", locale: "en", prompt: "private launch payload", imageRefs: [],
      parentArtifactPath: null, pipelineSourceConversationId: null,
      spec: { command: "codex", cwd: f.directory, windowName: "accepted", engine: "codex",
        launchProfile: emptyLaunchProfile({ title: "Read accepted launch" }) },
    }, "Admission wait");
    if (state === "failed") registry!.failSpawn(f.receipt.launchId, failure);
    if (state === "launched") f.settle();
    const taskIds = loadTasks().filter(task => task.assignments.some(assignment =>
      assignment.conversationId === f.receipt.conversationId)).map(task => task.id);
    expect(taskIds.length).toBeGreaterThan(0);
    f.restart();
    const before = registry!.readOnlySnapshot();
    for (const tailLines of [0, 10]) {
      expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId, tailLines })).toMatchObject({
        conversationId: f.receipt.conversationId, launchId: f.receipt.launchId, state, taskIds,
        evidence: "spawn-receipt", reason: state === "failed" ? failure : state === "waiting" ? admissionWait : null,
        ...(state === "waiting" ? { retryAt } : {}),
      });
    }
    for (const full of [false, true]) {
      const activity = await f.bindings.agent_activity({ conversationId: f.receipt.conversationId, full });
      expect(activity).toMatchObject({ count: 1, journaled: 0, selection: { scope: "targeted", matched: 1, selected: 1 }, conversations: [{
        conversationId: f.receipt.conversationId, state, taskIds, evidence: "spawn-receipt",
        reason: state === "failed" ? failure : state === "waiting" ? admissionWait : null,
      }] });
      expect(JSON.stringify(activity)).not.toContain("private launch payload");
    }
    expect(registry!.readOnlySnapshot()).toEqual(before);
  });

  test(`a transcript takes over both reads unchanged (${mode})`, async () => {
    const f = fixture(mode);
    f.settle();
    f.restart();
    expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).toMatchObject({ state: "launched" });
    fs.mkdirSync(path.dirname(f.transcriptPath), { recursive: true });
    directories.push(path.dirname(f.transcriptPath));
    fs.writeFileSync(f.transcriptPath, [
      { type: "session_meta", payload: { id: "accepted-native-session", cwd: f.directory } },
      { type: "response_item", timestamp: now, payload: { type: "message", role: "assistant",
        content: [{ type: "output_text", text: "Transcript is ready." }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const answer = await f.bindings.get_conversation({ conversationId: f.receipt.conversationId });
    expect(answer.messages).toMatchObject([{ text: "Transcript is ready." }]);
    expect(answer).not.toHaveProperty("evidence");
    expect(answer).not.toHaveProperty("state");
    const tail = await f.bindings.get_conversation({ conversationId: f.receipt.conversationId, tailLines: 10 });
    expect(tail).toHaveProperty("tail");
    expect(tail).not.toHaveProperty("state");
    const activity = await f.bindings.agent_activity({ conversationId: f.receipt.conversationId, full: true });
    expect(activity).toMatchObject({ count: 1, conversations: [{ evidenceSource: "transcript" }] });
    expect((activity.conversations as object[])[0]).not.toHaveProperty("state");
  });

  test.each(["quota", "admitting"] as const)(`a %s queue retains its admission facts (${mode})`, async kind => {
    const f = fixture(mode);
    const reason = "Pinned account capacity is unavailable";
    registry!.queuePinnedSpawn(f.receipt.launchId, {
      version: 1, retryAt, accountId: "account-a", locale: "en", prompt: "queued launch", imageRefs: [],
      ...(kind === "admitting" ? { admissionDeadlineAt: "2026-10-26T22:35:00.000Z" } : {}),
      parentArtifactPath: null, pipelineSourceConversationId: null,
      spec: { command: "codex", cwd: f.directory, windowName: "accepted", engine: "codex",
        launchProfile: emptyLaunchProfile({ title: "Read accepted launch" }) },
    }, reason);
    f.restart();
    const expected = { state: kind === "quota" ? "waiting" : "starting", reason: kind === "quota" ? reason : null };
    expect(await f.bindings.get_conversation({ conversationId: f.receipt.conversationId })).toMatchObject(expected);
    expect(await f.bindings.agent_activity({ conversationId: f.receipt.conversationId })).toMatchObject({ conversations: [expected] });
  });

  test(`unknown ids retain the existing missing answers (${mode})`, async () => {
    const f = fixture(mode);
    await expect(f.bindings.get_conversation({ conversationId: "conversation_unknown" })).rejects.toThrow("conversation not found");
    await expect(f.bindings.get_conversation({ conversationId: "conversation_unknown", tailLines: 10 })).rejects.toThrow("no Viewer conversation has that id");
    expect(await f.bindings.agent_activity({ conversationId: "conversation_unknown" })).toMatchObject({ count: 0, conversations: [] });
  });

  test(`receipt errors are redacted on every fallback read (${mode})`, async () => {
    const f = fixture(mode);
    const sensitive = ["provider", "fixture", "credential", "value"].join("-");
    retainProviderRedactionSecrets([sensitive]);
    registry!.failSpawn(f.receipt.launchId, `Verification failed: ${sensitive}`);
    f.restart();
    const answers = [
      await f.bindings.get_conversation({ conversationId: f.receipt.conversationId }),
      await f.bindings.get_conversation({ conversationId: f.receipt.conversationId, tailLines: 10 }),
      await f.bindings.agent_activity({ conversationId: f.receipt.conversationId }),
    ];
    for (const answer of answers) {
      const rendered = JSON.stringify(answer);
      expect(rendered).toContain("Verification failed:");
      expect(rendered).not.toContain(sensitive);
    }
  });

  test(`a rejected reservation never becomes an accepted conversation (${mode})`, async () => {
    const f = fixture(mode);
    const reviewer = registry!.beginSpawnRequest({
      engine: "codex", cwd: f.directory, role: "reviewer", conversationId: "conversation_reviewer",
      reviewsConversationId: f.receipt.conversationId,
      launchProfile: { title: "Review accepted launch" },
    });
    if (reviewer.kind !== "created") throw new Error("fixture reviewer was not created");
    f.settle(reviewer.receipt.launchId);
    expect(() => registry!.beginSpawnRequest({
      engine: "codex", cwd: f.directory, conversationId: "conversation_rejected",
      launchProfile: { title: "Rejected child launch" },
      origin: { kind: "agent", conversationId: reviewer.receipt.conversationId },
    })).toThrow();
    f.restart();
    await expect(f.bindings.get_conversation({ conversationId: "conversation_rejected" })).rejects.toThrow("conversation not found");
    expect(await f.bindings.agent_activity({ conversationId: "conversation_rejected" })).toMatchObject({ count: 0, conversations: [] });
  });
}
