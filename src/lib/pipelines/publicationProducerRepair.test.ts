import { expect, test, fs, path, tickPipelines, rawPatchPipeline, savePipelines, realExec } from "./engine.fixture";
import { current, fixture, isolatePublicationGit } from "./publicationRecovery.fixture";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";

isolatePublicationGit();

const producerOnly = [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }];

async function refusedFixture(phase = "touched tests", continuation: boolean | "accepted" = false) {
  const f = await fixture(undefined, producerOnly);
  try {
    let clock = Date.parse(f.h.ports.now());
    f.h.ports.now = () => new Date(clock).toISOString();
    if (continuation) f.h.ports.resumeSeveredTurn = async () => continuation === "accepted";
    const accepted = await f.commit("accepted implementation");
    fs.writeFileSync(path.join(f.hooks, "pre-push"), `#!/bin/sh
echo 'pre-push: ${phase}' >&2
git show HEAD:file.txt | grep -q 'fixed implementation' && exit 0
echo 'NEW file.test.ts: failing assertion' >&2
exit 1
`, { mode: 0o700 });
    await f.finish();
    return { ...f, accepted, advance: (ms: number) => { clock += ms; } };
  } catch (error) { f.close(); throw error; }
}

test.each(["types", "touched tests", "eslint"])("a refused %s check automatically launches a producer that commits and publishes its fix", async phase => {
  const f = await refusedFixture(phase);
  try {
    expect(current().state).toBe("needs_decision");
    const passed = structuredClone(current().runs[0]!.attempts[0]!);
    const receipts = path.join(stageGitReceiptDirectory(passed.launchId!), "commits");
    const recorded = fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")]);
    await tickPipelines([], f.h.ports);
    const repair = current().runs[0]!.attempts[1]!;
    expect(repair.publicationRepairFrom).toEqual({ stageId: "build", attempt: 1, round: 1 });
    expect(current().publicationProducerRepairs).toBe(1);
    expect(repair.input).toContain(`pre-push: ${phase}`);
    expect(repair.input).toContain("NEW file.test.ts: failing assertion");
    expect(current().runs[0]!.attempts[0]!.verdict).toEqual(passed.verdict);
    expect(current().lastPassedCommit).toBe(f.accepted);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(fs.readdirSync(receipts).sort().map(name => [name, fs.readFileSync(path.join(receipts, name), "utf8")])).toEqual(recorded);
    expect(f.h.spawnInputs[1]!.prompt).toContain("NEW file.test.ts: failing assertion");
    const fixed = await f.commit("fixed implementation");
    await f.finish(2);
    expect(current()).toMatchObject({ state: "completed", lastPassedCommit: fixed, publishedCommit: fixed });
    expect(await f.git(f.remote, "rev-parse", current().delivery!.target.branch)).toBe(fixed);
    expect(current().runs[0]!.attempts).toHaveLength(2);
  } finally { f.close(); }
});

test("a controller commit of dirty producer output can start a fresh publication repair", async () => {
  const f = await fixture(undefined, producerOnly);
  try {
    fs.writeFileSync(path.join(f.lane(), "file.txt"), "controller commits this output\n");
    f.refuse(); await f.finish();
    const accepted = current().lastPassedCommit;
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(accepted);
    await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(f.h.spawnInputs).toHaveLength(2);
    fs.unlinkSync(path.join(f.hooks, "pre-push"));
    const repaired = await f.commit("fixed controller output"); await f.finish(2);
    expect(current()).toMatchObject({ state: "completed", lastPassedCommit: repaired, publishedCommit: repaired });
  } finally { f.close(); }
});

test("retry-stage replaces a timed-out repair on an idle resident host without republishing the accepted commit", async () => {
  const f = await refusedFixture("types", "accepted");
  try {
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "delivered-repair", state: "delivered", safeToReplace: false });
    f.advance(1392_000);
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    f.h.ports.publicationRepairProducerGone = async () => false;
    f.h.ports.conversationTurnInterrupted = async () => "idle";
    const before = structuredClone(current().runs[0]!.attempts[0]!);
    const result = await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    expect(result.error).toBeUndefined();
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(current().cursor).toMatchObject({ stageId: "build", state: "pending" });
    expect(current().cursor!.input).toContain("pre-push: types");
    expect(current().runs[0]!.attempts[0]!.verdict).toEqual(before.verdict);
    expect(current().lastPassedCommit).toBe(f.accepted);
    expect(await f.git(f.lane(), "rev-parse", "HEAD")).toBe(f.accepted);
    expect(current().delivery!.operation).toBeUndefined();
  } finally { f.close(); }
});

test("a completed type repair followed by another hook refusal automatically starts a fresh producer", async () => {
  const f = await fixture(undefined, producerOnly);
  try {
    let clock = Date.parse(f.h.ports.now()); f.h.ports.now = () => new Date(clock).toISOString();
    f.h.ports.resumeSeveredTurn = async () => true;
    fs.writeFileSync(path.join(f.hooks, "pre-push"), `#!/bin/sh
git show HEAD:file.txt | grep -q 'all fixed' && exit 0
if git show HEAD:file.txt | grep -q 'types fixed'; then
  echo 'pre-push: touched tests' >&2
  echo 'NEW file.test.ts: remaining publication assertion' >&2
else
  echo 'pre-push: types' >&2
  echo 'file.ts requires a type correction' >&2
fi
exit 1
`, { mode: 0o700 });
    await f.commit("first implementation"); await f.finish();
    const typeFix = await f.commit("types fixed"); clock += 1_000;
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", message: { text: "type repair completed", ts: clock }, lastRecordAt: clock });
    for (let n = 0; n < 3; n++) await tickPipelines([], f.h.ports);
    expect(current().runs[0]!.attempts[0]!.publicationRepair?.outcome).toEqual({ status: "accepted" });
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(current().runs[0]!.attempts[1]!.input).toContain("remaining publication assertion");
    expect(current().lastPassedCommit).toBe(typeFix);
    expect(f.h.spawnInputs).toHaveLength(2);
    const final = await f.commit("all fixed"); await f.finish(2);
    expect(current()).toMatchObject({ state: "completed", lastPassedCommit: final, publishedCommit: final });
  } finally { f.close(); }
});

test("a terminal repair on a resident host permits a fresh attempt when interruption recovery returns no result", async () => {
  const f = await refusedFixture("touched tests", "accepted");
  try {
    f.advance(1392_000);
    f.h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: { text: "repair ended", ts: Date.parse(f.h.ports.now()) },
      lastRecordAt: Date.parse(f.h.ports.now()) });
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    f.h.ports.publicationRepairProducerGone = async () => false;
    f.h.ports.conversationTurnInterrupted = async () => null;
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    expect(current().runs[0]!.attempts).toHaveLength(2);
  } finally { f.close(); }
});

test.each(["active", "queued", "unknown"])("automatic and manual repair respect %s producer evidence", async state => {
  const f = await refusedFixture("touched tests", true);
  try {
    f.advance(1392_000); await tickPipelines([], f.h.ports);
    f.h.setConversationActive(state === "active" ? true : null);
    f.h.ports.publicationRepairProducerGone = async () => null;
    f.h.ports.conversationDeliveryOutstanding = () => state === "queued";
    await tickPipelines([], f.h.ports);
    if (state === "unknown") {
      // Retain the existing bounded recovery policy for an expired, quiet
      // repair whose runtime observations are unavailable.
      expect(current().runs[0]!.attempts).toHaveLength(2);
      expect(current().cursor!.input).toContain("pre-push: touched tests");
      return;
    }
    const result = await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports);
    expect(result.status).toBe(409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(current().lastPassedCommit).toBe(f.accepted);
  } finally { f.close(); }
});

test.each(["transcript", "message", "background"])("an idle producer with live %s work keeps its repair identity", async kind => {
  const f = await refusedFixture("types", true);
  try {
    f.advance(1392_000); await tickPipelines([], f.h.ports);
    f.h.ports.conversationTurnInterrupted = async () => "idle";
    f.h.ports.durableTurnEvidence = async () => ({ turn: kind === "background" ? "terminal" : "busy",
      ...(kind === "message" ? { message: { text: "repair is still working", ts: Date.parse(f.h.ports.now()) } }
        : { lastRecordAt: Date.parse(f.h.ports.now()) }), backgroundTasks: kind === "background"
        ? [{ id: "repair-command", kind: "command", startedAt: Date.parse(f.h.ports.now()), expiresAt: null }] : [] });
    await tickPipelines([], f.h.ports);
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).status).toBe(409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["delivery", "transcript", "host", "gone", "activity", "owner"])("retry fences producer replacement during the %s await", async read => {
  const f = await refusedFixture("touched tests", true);
  try {
    f.advance(1392_000); await tickPipelines([], f.h.ports);
    const change = () => {
      const changed = current(); changed.runs[0]!.attempts[0]!.conversationId = "conversation_replacement_owner"; savePipelines([changed]);
    };
    f.h.ports.stageRepairDelivery = async () => { if (read === "delivery") change(); return { operationId: null, state: "failed", safeToReplace: true }; };
    f.h.ports.durableTurnEvidence = async () => { if (read === "transcript") change(); return null; };
    f.h.ports.conversationTurnInterrupted = async () => { if (read === "host") change(); return "idle"; };
    f.h.ports.publicationRepairProducerGone = async () => { if (read === "gone") change(); return true; };
    f.h.ports.conversationAgentActive = async () => { if (read === "activity") change(); return false; };
    f.h.ports.publicationRepairProducerState = async () => { if (read === "owner") change(); return "gone"; };
    expect((await rawPatchPipeline(current().id, { action: "retry-stage" }, f.h.ports)).status).toBe(409);
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(current().lastPassedCommit).toBe(f.accepted);
  } finally { f.close(); }
});

test("fresh producer round limit is retained by the real store across a controller process restart", async () => {
  const f = await refusedFixture();
  try {
    // Spend both rounds through the real transition, each with a new passed
    // producer whose head is still refused by the same repository hook.
    for (let round = 1; round <= 2; round++) {
      await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
      expect(current().runs[0]!.attempts.at(-1)!.publicationRepairFrom?.round).toBe(round);
      expect(current().publicationProducerRepairs).toBe(round);
      await f.commit(`still broken round ${round}`); await f.finish(round + 1);
      expect(current().state).toBe("needs_decision");
    }
    const lane = current();
    const child = await realExec(process.execPath, ["-e", `
      const { defaultPipelinePorts, patchPipeline } = await import("./src/lib/pipelines/engine");
      const { findPipelineRecord } = await import("./src/lib/pipelines/store");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal");
      registerPipelineTick(async () => {});
      const ports = { ...defaultPipelinePorts(), now: () => ${JSON.stringify(f.h.ports.now())},
        conversationAgentActive: async () => false, publicationRepairProducerGone: async () => true,
        conversationTurnInterrupted: async () => "dead", conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => null };
      const answer = await patchPipeline(${JSON.stringify(lane.id)}, { action: "retry-stage" }, ports);
      console.log(JSON.stringify({ status: answer.status, error: answer.error,
        attempts: findPipelineRecord(${JSON.stringify(lane.id)}).runs[0].attempts.length }));
    `], process.cwd(), process.env, { timeoutMs: 30_000 });
    expect(child.code, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 409, attempts: 3, error: expect.stringContaining("exhausted after 2 fresh attempts") });
    await tickPipelines([], f.h.ports);
    expect(current().state).toBe("needs_decision");
    expect(current().runs[0]!.attempts).toHaveLength(3);
  } finally { f.close(); }
});

test("a replacement retains the producer's review activation", async () => {
  const f = await fixture();
  try {
    await f.commit("accepted implementation"); f.refuse(); await f.finish();
    const row = current();
    row.runs[0]!.attempts[0]!.activatedBy = { stageId: "review", attempt: 2, edge: "fail", budgetRecheck: true };
    savePipelines([row]);
    expect((await rawPatchPipeline(row.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    expect(current().runs[0]!.attempts[1]!.activatedBy).toEqual(row.runs[0]!.attempts[0]!.activatedBy);
  } finally { f.close(); }
});

test("MCP pipeline_action retries a refused pass through the HTTP service exactly once", async () => {
  const f = await refusedFixture("touched tests", "accepted");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/mcp/route");
  const { setMcpHttpDependenciesForTests } = await import("@/lib/mcp/http");
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { spawnCapabilityDigest } = await import("@/lib/agent/callerClaims");
  const { createMcpToolService, SqliteMcpReceiptStore } = await import("@/lib/mcp/server");
  const { viewerMcpBindings, viewerMcpToolPolicy, productionDomainDependencies } = await import("@/lib/mcp/bindings");
  const { withWorkspaceMcpFence } = await import("@/lib/mcp/workspaceFence");
  const { getPipeline } = await import("./engine");
  const registry = new AgentRegistry(path.join(f.root, "mcp-registry.json"));
  const receipts = new SqliteMcpReceiptStore(path.join(f.root, "mcp-receipts.sqlite"));
  let listener: ReturnType<typeof Bun.serve> | undefined, client: InstanceType<typeof Client> | undefined;
  let dispatches = 0;
  try {
    setAgentRegistryForTests(registry);
    const transcript = path.join(f.root, "caller.jsonl"); fs.writeFileSync(transcript, "");
    const started = registry.beginSpawnRequest({ engine: "codex", cwd: f.lane(), explicitProject: current().project,
      transport: "structured", conversationId: "conversation_publication_caller", role: "builder", clientAttemptId: "publication-caller",
      launchProfile: emptyLaunchProfile({ cwd: f.lane(), project: current().project, title: "Publication repair fixture", role: "worker" }) });
    if (started.kind !== "created") throw new Error("fixture caller was not created");
    registry.settleSpawn(started.receipt.launchId, { key: { engine: "codex", sessionId: "publication-caller" }, artifactPath: transcript,
      cwd: f.lane(), accountId: "default", status: "unhosted", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    const capability = registry.rotateSpawnCapabilityForReceipt(started.receipt.launchId);
    const lane = current(); lane.srcConversationId = "conversation_publication_caller"; lane.srcPath = transcript; savePipelines([lane]);
    f.h.ports.stageRepairDelivery = async () => ({ operationId: "delivered-mcp-repair", state: "delivered", safeToReplace: false });
    f.advance(1392_000); await tickPipelines([], f.h.ports);
    f.h.ports.publicationRepairProducerGone = async () => false;
    f.h.ports.conversationTurnInterrupted = async () => "idle";
    const dependencies = { ...productionDomainDependencies, readPipelineRecord: getPipeline,
      patchPipeline: ((...args: Parameters<typeof rawPatchPipeline>) => {
        dispatches++; args[2] = f.h.ports; return rawPatchPipeline(...args);
      }) };
    const bindings = viewerMcpBindings(undefined, undefined, dependencies);
    const service = withWorkspaceMcpFence(createMcpToolService(bindings, receipts, viewerMcpToolPolicy(dependencies)), dependencies);
    setMcpHttpDependenciesForTests({ service: async () => service,
      conversationForCapability: value => registry.conversationIdForSpawnCapabilityDigest(spawnCapabilityDigest(value)) });
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
    client = new Client({ name: "publication-repair-fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), {
      requestInit: { headers: { "x-llv-spawn-capability": capability } },
    }));
    expect((await client.listTools()).tools.some(tool => tool.name === "pipeline_action")).toBe(true);
    const args = { pipelineId: lane.id, action: "retry-stage", expectedStageId: "build", expectedAttempt: 1,
      clientRequestId: "publication-repair-retry" };
    f.h.setConversationActive(true);
    const busy = await client.callTool({ name: "pipeline_action", arguments: { ...args, clientRequestId: "publication-repair-busy" } });
    expect(busy.structuredContent).toMatchObject({ ok: false });
    expect(current().runs[0]!.attempts).toHaveLength(1);
    f.h.setConversationActive(false);
    const first = await client.callTool({ name: "pipeline_action", arguments: args });
    expect(first.structuredContent).toMatchObject({ ok: true });
    expect(current().runs[0]!.attempts).toHaveLength(2);
    expect(current().cursor!.input).toContain("NEW file.test.ts: failing assertion");
    const replay = await client.callTool({ name: "pipeline_action", arguments: args });
    expect(replay.structuredContent).toMatchObject({ ok: true, replayed: true });
    expect(dispatches).toBe(2);
    expect(current().runs[0]!.attempts).toHaveLength(2);
  } finally {
    await client?.close(); listener?.stop(true); setMcpHttpDependenciesForTests(null);
    receipts.close(); setAgentRegistryForTests(null); registry.close(); f.close();
  }
});
