import "./engineEnvironment.fixture";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineStageAttempt } from "./types";

const previousState = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-landing-"));
process.env.LLV_STATE_DIR = sandbox;

const { closeAgentRegistryForTests } = await import("@/lib/agent/registry");
closeAgentRegistryForTests();
const { buildPipeline, findPipelineRecord, releaseBatchLanding, reserveBatchLanding, savePipelines } = await import("./store");
const { defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./engine");
const { registerPipelineTick } = await import("./controllerSignal");
const restore = registerPipelineTick(async () => {});
afterAll(() => {
  restore();
  closeAgentRegistryForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const NOW = "2026-09-25T10:00:00.000Z";
const HEAD = "a".repeat(40);

function setupDelivery(id: string) {
  const builder = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const reviewer = { ...builder, access: "read-only" } as const;
  const lane = buildPipeline({ id, task: "Publish a tested change", project: "repo-delivery-fixture", repoDir: path.join(sandbox, "repo"),
    stages: [
      { id: "build", kind: "run", prompt: "Build", next: "review", effectiveRole: builder },
      { id: "review", kind: "run", prompt: "Review", next: null, effectiveRole: reviewer },
    ], srcPath: null, srcConversationId: null, now: NOW, publication: "remote-branch" });
  lane.state = "needs_decision";
  lane.cursor = { stageId: "review", state: "pending", input: null, activatedBy: null };
  lane.lastPassedCommit = HEAD;
  const accepted: PipelineStageAttempt = {
    n: 1, state: "passed", effectiveRole: builder, launchId: null, conversationId: null, sessionId: null, agentPath: null,
    paneId: null, flowId: null, startedAt: NOW, completedAt: NOW, input: null, activatedBy: null, output: null,
    verdict: { status: "pass" }, error: null,
  };
  lane.runs[0]!.attempts = [accepted];
  lane.runs[1]!.attempts = [{ ...accepted, state: "needs_decision", effectiveRole: reviewer, verdict: null }];
  savePipelines([lane]);
  const ports = {
    ...defaultPipelinePorts(),
    now: () => NOW,
    conversationAgentActive: async () => false,
    paneAgentAlive: async () => false,
    exec: async (_command: string, args: string[]) => ({ code: 0, stderr: "",
      stdout: args[0] === "rev-parse" ? HEAD : args[0] === "branch" ? lane.branch
        : args.includes("ls-remote") ? `${HEAD}\trefs/heads/${lane.branch}\n` : "" }),
  };
  return { lane, ports };
}

test("legacy publication leaves late assignment pending while its observed branch is reserved for landing", async () => {
  const h = setupDelivery("late-assignment");
  const entered = Promise.withResolvers<void>(), observed = Promise.withResolvers<void>();
  const repository = "acme/widgets";
  const operation = "late-assignment-batch";
  const remote = "ssh://github.com/ACME/Widgets.git";
  let pushes = 0;
  const ports = { ...h.ports, exec: async (_command: string, args: string[]) => {
    if (args[0] === "remote") {
      entered.resolve();
      await observed.promise;
      return { code: 0, stdout: remote, stderr: "" };
    }
    if (args[0] === "push") pushes++;
    return h.ports.exec(_command, args);
  } };
  expect((await patchPipeline(h.lane.id, { action: "publish", acceptedSha: HEAD }, ports)).error).toBeUndefined();
  const tick = tickPipelines([], ports);
  try {
    await Promise.race([entered.promise, tick.then(() => { throw new Error("late assignment did not read origin"); })]);
    expect(await reserveBatchLanding(operation, repository, [{
      prRepository: repository, prNumber: 12, headRepository: repository, branch: `refs/heads/${h.lane.branch}`,
    }])).toBeNull();
    observed.resolve();
    await tick;
    expect(findPipelineRecord(h.lane.id)!.publicationAdmission?.state).toBe("pending");
    expect(findPipelineRecord(h.lane.id)!.delivery).toBeUndefined();
    expect(pushes).toBe(0);
  } finally {
    observed.resolve();
    try { await tick; }
    finally { await releaseBatchLanding(operation, repository); }
  }
  await tickPipelines([], ports);
  expect(findPipelineRecord(h.lane.id)!.delivery?.disposition).toBe("owner");
  expect(findPipelineRecord(h.lane.id)!.publicationAdmission?.state).toBe("settled");
});

test("remote adoption cannot claim a branch reserved for landing", async () => {
  const h = setupDelivery("remote-adoption");
  const repository = "acme/widgets";
  const remote = "ssh://github.com/ACME/Widgets.git";
  const branch = `refs/heads/${h.lane.branch}`;
  h.lane.delivery = { target: { repository: "local", remote: "", branch },
    disposition: "owner", publish: "enabled", ownerId: h.lane.id, epoch: 1, active: true, journal: [] };
  savePipelines([h.lane]);
  const ports = { ...h.ports, exec: async (_command: string, args: string[]) => {
    if (args[0] === "remote") return { code: 0, stdout: args.length === 1 ? "origin" : remote, stderr: "" };
    if (args[0] === "-c" && args.at(-1) === "-v") {
      return { code: 0, stdout: `delegatus-literal-probe\t${remote} (fetch)\ndelegatus-literal-probe\t${remote} (push)`, stderr: "" };
    }
    return h.ports.exec(_command, args);
  } };
  const operation = "remote-adoption-batch";
  expect(await reserveBatchLanding(operation, repository, [{ headRepository: repository, branch }])).toBeNull();
  try {
    expect(await patchPipeline(h.lane.id, { action: "set-delivery-remote" }, ports)).toMatchObject({
      status: 409, error: expect.stringContaining("merge is in flight"),
    });
    expect(findPipelineRecord(h.lane.id)?.delivery).toMatchObject({ epoch: 1, target: { remote: "" } });
  } finally {
    await releaseBatchLanding(operation, repository);
  }
  expect((await patchPipeline(h.lane.id, { action: "set-delivery-remote" }, ports)).pipeline?.delivery)
    .toMatchObject({ epoch: 2, target: { remote } });
});
