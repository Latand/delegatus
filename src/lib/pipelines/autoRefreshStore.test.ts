import { beforeEach, expect, test } from "bun:test";
import { buildPipeline, createPipelineWithDelivery, loadPipelines, savePipelines, pipelineDeliveryLookup } from "./store";

beforeEach(() => savePipelines([]));

const target = { repository: "repo-refresh-fixture", remote: "", branch: "refs/heads/topic", pr: 11 };
function fixture(id: string) {
  return buildPipeline({ id, task: "Refresh fixture", project: "fixture", repoDir: "/fixture/repository",
    stages: [{ id: "refresh", kind: "run", prompt: "Merge main", next: null, effectiveRole: {
      roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null,
    } }], srcPath: null, srcConversationId: null, now: "2026-10-12T00:00:00.000Z", state: "draft", publication: "remote-branch" });
}

test("refresh creation refuses an active delivery owner atomically, then claims the released target", async () => {
  const owner = await createPipelineWithDelivery(fixture("owner"), target);
  await expect(createPipelineWithDelivery(fixture("refused"), target, false, { requireOwner: true })).rejects.toThrow("target already owned");
  expect(loadPipelines().some((lane) => lane.id === "refused")).toBe(false);
  owner.state = "closed";
  owner.cursor = null;
  owner.closedAt = "2026-10-12T01:00:00.000Z";
  savePipelines([owner]);
  const next = await createPipelineWithDelivery(fixture("successor"), target, false, { requireOwner: true });
  expect(next.delivery).toMatchObject({ disposition: "owner", active: true, epoch: 2 });
});

test("concurrent and restarted creation replays one owner even while its claim is active", async () => {
  const make = (id: string) => {
    const value = fixture(id);
    value.creationRequest = { key: "auto-refresh:finished:zero", digest: "same-facts" };
    value.refreshOf = { pipelineId: "finished", base: "a".repeat(40) };
    return value;
  };
  const oneTarget = { ...target, branch: "refs/heads/replay" };
  const result = await Promise.all(["one", "two"].map((id) => createPipelineWithDelivery(make(id), oneTarget, false, { requireOwner: true })));
  expect(result[0]!.id).toBe(result[1]!.id);
  const replay = await createPipelineWithDelivery(make("three"), oneTarget, false, { requireOwner: true });
  expect(replay.id).toBe(result[0]!.id);
  expect(pipelineDeliveryLookup({ requestKey: "auto-refresh:finished:zero" })?.refreshOf).toEqual({ pipelineId: "finished", base: "a".repeat(40) });
  expect(loadPipelines().filter((lane) => lane.creationRequest?.key === "auto-refresh:finished:zero")).toHaveLength(1);
});


test("the real create path records refresh lineage and one-round roles, with replay and owner refusal", async () => {
  const { createPipelineFromRequest, defaultPipelinePorts } = await import("./engine");
  const { refreshRequest, refreshReservation } = await import("@/lib/forge/autoRefresh");
  const ports = defaultPipelinePorts();
  ports.preflightRepo = repoDir => ({ ok: true, repoDir, gitCommonDir: `${repoDir}/.git`, worktreeParent: "/fixture" });
  ports.projectForCwd = () => "fixture";
  ports.exec = async () => ({ code: 0, stdout: "https://forge.example/owner/repo.git\n", stderr: "" });
  ports.engineReadiness = () => "connected";
  ports.roleLookup = roleId => ({ engine: "codex", model: null, effort: null, access: roleId === "reviewer" ? "read-only" : "read-write", promptScaffold: "Role fixture guidance" });
  ports.sourcePathAllowed = () => { throw new Error("internal refresh lineage must bypass transcript lookup"); };
  const parent = fixture("finished");
  parent.baseBranch = "main";
  parent.lastPassedCommit = "b".repeat(40);
  parent.delivery = { target: { ...target, remote: "https://forge.example/owner/repo.git" }, disposition: "owner", active: false, publish: "disabled", ownerId: parent.id, epoch: 1, journal: [] };
  parent.merge = { prNumber: 11, attempts: 0 } as typeof parent.merge;
  parent.merge!.refresh = refreshReservation(parent, "a".repeat(40), "b".repeat(40), Date.parse("2026-10-12T00:00:00Z"));
  const request = refreshRequest(parent);
  const options = { creationRequest: { key: parent.merge!.refresh!.key, digest: parent.merge!.refresh!.digest },
    refreshOf: { pipelineId: parent.id, base: "a".repeat(40), lineage: { srcPath: null, srcConversationId: "seat-one" } } };
  const created = await createPipelineFromRequest(request, ports, options);
  expect(created.error).toBeUndefined();
  expect(created.pipeline).toMatchObject({ srcConversationId: "seat-one", refreshOf: { pipelineId: "finished", base: "a".repeat(40) }, delivery: { disposition: "owner", active: true },
    stages: [{ id: "refresh", onFail: null }, { id: "review", onFail: { to: "fix", maxRounds: 1, onExhausted: "advance" }, effectiveRole: { access: "read-only" } }, { id: "fix" }] });
  const replay = await createPipelineFromRequest(request, ports, options);
  expect(replay.pipeline?.id).toBe(created.pipeline!.id);
  const refused = await createPipelineFromRequest(request, ports, { ...options, creationRequest: { key: "another-refresh", digest: "other" } });
  expect(refused.error).toContain("target already owned");
  expect(loadPipelines()).toHaveLength(1);
});
