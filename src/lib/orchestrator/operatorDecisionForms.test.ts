import { expect, spyOn, test } from "bun:test";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateForDelivery } from "./prompt";

test("every delivered seat mandate asks operator decisions through a durable form", async () => {
  for (const input of [ORCHESTRATOR_SYSTEM_PROMPT, "Coordinate this project.", "Prototype review: our own wording."]) {
    const mandate = orchestratorMandateForDelivery(input);
    for (const rule of [
      "Every operator decision",
      "publish_prototype_review",
      "taskId for a task (3–7 questions)",
      "omit it without a task (1–7)",
      "3–7 questions",
      "options with exactly one recommended",
      "variants optional",
      "Chat and reports only point to the form",
      "Never use engine built-in ask tools",
      "Any other question for the operator is a form too.",
      "Chat and reports only point to the form and ask nothing themselves.",
    ]) expect(mandate).toContain(rule);
    for (const retired of ["suggest_replies", "Reply drafts", "chat may hold only a one-off ask"]) expect(mandate).not.toContain(retired);
    expect(orchestratorMandateForDelivery(mandate)).toBe(mandate);
  }
});


test("fresh seat and worker profiles select the native question policy independently of delegation", async () => {
  const { claudeStructuredHostOptions } = await import("@/lib/runtime/structuredSpawn");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { operatorDecisionFormsRequired } = await import("./operatorDecisionForms");
  for (const role of ["orchestrator", "builder", null]) {
    const input = {
      spec: { cwd: "/repo", engine: "claude" as const, command: "fixture-engine", windowName: "fixture", launchProfile: emptyLaunchProfile({ cwd: "/repo", allowSubagents: true }) },
      account: { engine: "claude" as const, accountId: "legacy", home: "/account", kind: "legacy" as const, transcriptRoot: "/transcripts", env: { NODE_ENV: "test" as const } },
    };
    expect(operatorDecisionFormsRequired(role)).toBe(role === "orchestrator");
    const options = await claudeStructuredHostOptions(input, { env: { NODE_ENV: "test" }, host: {} }, undefined, undefined, role);
    expect(options.operatorDecisionForms).toBe(role === "orchestrator");
  }
});


test("re-hosting a designated conversation applies the seat policy even without an orchestrator role", async () => {
  const { operatorDecisionFormsRequired } = await import("./operatorDecisionForms");
  const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("./seats");
  const { claudeStartupHostOptions } = await import("@/lib/runtime/startup");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const project = "questions-project";
  const clientRequestId = "designate-question-seat";
  const seatPath = "/transcripts/question-seat.jsonl";
  beginOrchestratorSeatIntent({ project, mandate: "Coordinate.", clientRequestId, mode: "existing", conversationId: "conversation_question_seat" });
  completeOrchestratorSeatIntent({ project, clientRequestId, conversationId: "conversation_question_seat", path: seatPath });
  expect(operatorDecisionFormsRequired(null, seatPath)).toBe(true);
  expect(operatorDecisionFormsRequired("builder", "/transcripts/worker.jsonl")).toBe(false);
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const registry = new AgentRegistry();
  const entry = registry.upsert({ key: { engine: "claude", sessionId: "question-seat" }, artifactPath: seatPath,
    cwd: "/repo", accountId: null, launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  const options = await claudeStartupHostOptions(entry, null, null, { NODE_ENV: "test", LLV_STATE_DIR: process.env.LLV_STATE_DIR });
  expect(options.operatorDecisionForms).toBe(true);
  const { claudeStructuredHostOptions } = await import("@/lib/runtime/structuredSpawn");
  const resumed = await claudeStructuredHostOptions({
    spec: { command: "fixture-engine", engine: "claude", cwd: "/repo", windowName: "fixture", transcript: seatPath, launchProfile: entry.launchProfile },
    account: { engine: "claude", accountId: "legacy", kind: "legacy", home: "/account", transcriptRoot: "/transcripts", env: { NODE_ENV: "test" as const } },
  }, { env: { NODE_ENV: "test" }, host: {} });
  expect(resumed.operatorDecisionForms).toBe(true);
});


test("the production launch boundary applies the seat policy to both engines and preserves workers", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { defaultStartHost } = await import("@/lib/runtime/structuredSpawn");
  const { ClaudeStreamBrokerHost } = await import("@/lib/runtime/claudeStreamBrokerHost");
  const { CodexAppServerHost } = await import("@/lib/runtime/codexAppServerHost");
  for (const engine of ["claude", "codex"] as const) for (const role of ["orchestrator", "builder"]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "seat-launch-policy-"));
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const launchProfile = emptyLaunchProfile({ cwd });
    const begun = beginLegacySpawnFixture(registry, { engine, cwd, role, transport: "structured", launchProfile });
    if (begun.kind !== "created") throw new Error("question policy receipt missing");
    let selected: boolean | undefined;
    const capture = async (options: { operatorDecisionForms?: boolean }) => {
      selected = options.operatorDecisionForms;
      throw new Error("captured question policy");
    };
    const claude = spyOn(ClaudeStreamBrokerHost, "start").mockImplementation(capture);
    const codex = spyOn(CodexAppServerHost, "start").mockImplementation(capture);
    try {
      await expect(defaultStartHost({ engine, registry, receipt: begun.receipt,
        spec: { command: engine, engine, cwd, windowName: "fixture", launchProfile },
        account: { engine, accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
        client: {} as RuntimeHostClient, prompt: "" }, "fixture-capability")).rejects.toThrow("captured question policy");
      expect(selected).toBe(role === "orchestrator");
    } finally { claude.mockRestore(); codex.mockRestore(); fs.rmSync(cwd, { recursive: true, force: true }); }
  }
});
