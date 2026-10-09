import crypto from "node:crypto";

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as ghostPOST } from "@/app/api/orchestrator/ghost/route";
import { POST as rotatePOST } from "@/app/api/orchestrator/rotate/route";
import { POST as messagePOST } from "@/app/api/orchestrator/message/route";
import { POST as seatPOST } from "@/app/api/orchestrator/seat/route";

import { AgentRegistry, agentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { executeSpawnRequest, productionSpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { requireOperatorAuthority, rotationActor, setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, failOrchestratorSeatIntent, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { executeOrchestratorSeatRequest, productionSeatCommandDependencies, type SeatCommandDependencies } from "@/lib/orchestrator/seatCommand";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { setBridgeReports } from "@/lib/projects/settings";
import { readDeputies } from "@/lib/orchestrator/deputies";
import { setDeputyRootResolverForTests } from "@/lib/orchestrator/deputyAsker";

import { viewerMcpBindings, viewerMcpRecoverableTools, productionViewerControlDependencies, type ViewerControlDependencies, type ViewerMcpDomainDependencies } from "./bindings";

import { createMcpToolService, McpDispatchUncertainError, MemoryMcpReceiptStore } from "./server";

/*
 * The two-axis orchestration surface: get / create / send / rotate. All four
 * are ordinary tools available to every session; designation changes flow
 * through the seat routes (durable intents, idempotent), reads come off the
 * durable stores, and nothing here rotates anything on its own.
 */

let sandbox = "";
let previousStateDir: string | undefined;
let testRegistry: AgentRegistry;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orch-tools-"));
  process.env.LLV_STATE_DIR = sandbox;
  testRegistry = new AgentRegistry(path.join(sandbox, "registry.json"));
  setAgentRegistryForTests(testRegistry);
});
afterEach(() => {
  testRegistry.close();
  setAgentRegistryForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const AT = "2026-07-29T00:00:00.000Z";
const SEATED_ID = "conversation_66666666-6666-4666-8666-666666666666";

function seatActive(project: string, conversationId: string, transcriptPath: string | null, promptVersion: number | null = null): void {
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId: "seed_0000001", mode: "spawn", promptVersion, now: AT });
  completeOrchestratorSeatIntent({ project, clientRequestId: "seed_0000001", conversationId, path: transcriptPath, now: AT });
}

function controlStub(responses: Record<string, Record<string, unknown>> = {}) {
  const posts: { pathname: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const control: ViewerControlDependencies = {
    post: async (pathname, body, headers) => {
      posts.push({ pathname, body, headers: headers ?? {} });
      return responses[pathname] ?? { ok: true, outcome: "delivered", operationId: "fixture-operation" };
    },
  };
  return { posts, control };
}

/** A control plane whose DESIGNATION endpoint runs the REAL operator gate
    against exactly the headers the binding forwarded — the same check the seat
    route makes first, without reaching a real spawn.

    The rotation route is deliberately NOT on that gate (#1402): it runs the
    rotation authority contract, which admits the caller and names it, and the
    rotations it admits are recorded under that name. */
function gatedControlStub() {
  const designations: string[] = [];
  const rotations: (string | null)[] = [];
  const control: ViewerControlDependencies = {
    post: async (pathname, _body, headers) => {
      const request = { headers: new Headers(headers ?? {}) };
      if (pathname === "/api/orchestrator/rotate") {
        const actor = rotationActor(request);
        rotations.push(actor.conversationId);
        return {
          ok: true,
          conversationId: SEATED_ID,
          seat: { conversationId: SEATED_ID },
          triggeredBy: { kind: actor.kind, conversationId: actor.conversationId, seatEpoch: null },
        };
      }
      if (pathname === "/api/orchestrator/seat") {
        const operator = requireOperatorAuthority(request);
        if (!operator.ok) throw new Error(operator.error);
        designations.push(pathname);
        return { ok: true, conversationId: SEATED_ID, seat: { conversationId: SEATED_ID } };
      }
      return { ok: true, outcome: "delivered" };
    },
  };
  return { designations, rotations, control };
}

function bindingsWith(control: ViewerControlDependencies) {
  return viewerMcpBindings(undefined, control, {
    registrySnapshot: () => ({ conversations: {}, conversationAliases: {} }),
    callerAttribution: () => ({ kind: "gateway", conversationId: "conversation_gateway", role: null }),
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: [{ project: "proj-a", displayName: "Example project", smt: 1, conversations: 0 }], complete: true } }),
  } as never);
}

test("get_orchestrator with nothing designated says so and names the current default prompt version", async () => {
  const { control } = controlStub();
  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-1", project: "proj-a" });
  expect(result).toMatchObject({
    project: "proj-a",
    designated: false,
    seat: null,
    health: null,
    rotation: null,
    defaultPromptVersion: ORCHESTRATOR_PROMPT_VERSION,
    pendingIntent: null,
    intentHistoryCount: 0,
    lineageCount: 0,
  });
});

/* #2146: the seat reads its project's Bridge reports switch beside the merge
   setting, on by default and in both the compact and the full answer. */
test("get_orchestrator carries the project's bridge reports setting", async () => {
  const { control } = controlStub();
  expect(await bindingsWith(control).get_orchestrator({ clientRequestId: "get-br-1", project: "proj-a" })).toMatchObject({ mergeOnReview: false, bridgeReports: true });
  setBridgeReports("proj-a", false, "operator");
  expect(await bindingsWith(control).get_orchestrator({ clientRequestId: "get-br-2", project: "proj-a" })).toMatchObject({ bridgeReports: false });
  expect(await bindingsWith(control).get_orchestrator({ clientRequestId: "get-br-3", project: "proj-a", full: true })).toMatchObject({ bridgeReports: false });
});

test("get_orchestrator reports health with labelled estimates and a recommendation-only rotation block", async () => {
  const transcript = path.join(sandbox, "orchestrator.jsonl");
  fs.writeFileSync(transcript, `${"x".repeat(400_000)}\n`, "utf8");
  seatActive("proj-a", SEATED_ID, transcript);

  const { control } = controlStub();
  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-2", project: "proj-a" }) as Record<string, unknown>;

  expect(result.designated).toBe(true);
  expect(result.conversationId).toBe(SEATED_ID);
  const health = result.health as { transcript: { bytes: number; megabytes: number }; context: { estimated: boolean; basis: string } };
  expect(health.transcript.bytes).toBe(400_001);
  expect(health.transcript.megabytes).toBeCloseTo(0.38, 1);
  /* No provider usage in that file, so the reading is labelled an estimate. */
  expect(health.context.estimated).toBe(true);
  expect(health.context.basis).toContain("ESTIMATE");
  const rotation = result.rotation as { recommended: boolean; reasons: string[]; note: string };
  expect(rotation.note).toContain("never happens automatically");
});

test("crossing the rotation threshold changes WORDS ONLY: prominent advisory, zero side effects", async () => {
  const transcript = path.join(sandbox, "hot-orchestrator.jsonl");
  /* Provider-reported usage far over the reference threshold (500k of 1M). */
  fs.writeFileSync(transcript, JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 600_000, cache_read_input_tokens: 50_000 } },
  }) + "\n", "utf8");
  const begun = agentRegistry().beginSpawnRequest({
    engine: "claude",
    cwd: sandbox,
    clientAttemptId: "seed_0000001",
    launchProfile: { model: "opus", title: "Assess orchestrator rotation health" },
  });
  seatActive("proj-a", begun.receipt.conversationId, transcript);
  const before = JSON.stringify(orchestratorSeatFor("proj-a"));

  const { posts, control } = controlStub();
  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-hot", project: "proj-a" }) as Record<string, unknown>;

  expect(result.engine).toBe("claude");
  expect(result.model).toBe("opus");
  const rotation = result.rotation as { level: string; advisory: string | null; reasons: string[] };
  expect(rotation.level).toBe("strongly_recommend");
  expect(rotation.advisory).toBe("STRONGLY_RECOMMEND_ROTATION");

  /* The absence of side effects, asserted rather than assumed: no control-plane
     call of any kind (no rotate, no create, no message, no interrupt), and the
     designation exactly as it was — same seat, no pending intent, no
     revocation. The incumbent was not touched in any way. */
  expect(posts).toEqual([]);
  expect(JSON.stringify(orchestratorSeatFor("proj-a"))).toBe(before);
  expect(orchestratorSeatFor("proj-a").pending).toBeNull();
});

test("get_orchestrator surfaces bidirectional predecessor lineage after a replacement", async () => {
  seatActive("proj-a", "conversation_old", null);
  beginOrchestratorSeatIntent({ project: "proj-a", mandate: "v2", clientRequestId: "seed_0000002", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project: "proj-a", clientRequestId: "seed_0000002", conversationId: SEATED_ID, path: null, now: AT });

  const { control } = controlStub();
  const compact = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-3", project: "proj-a" }) as Record<string, unknown>;
  expect(compact.predecessorConversationId).toBe("conversation_old");
  expect(compact.lineageCount).toBe(1);
  expect(compact.lineage).toBeUndefined();

  const result = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-3-full", project: "proj-a", full: true }) as Record<string, unknown>;
  expect(result.predecessorConversationId).toBe("conversation_old");
  expect(result.lineage).toEqual([{
    conversationId: "conversation_old",
    seatEpoch: 1,
    revokedAt: AT,
    successorConversationId: SEATED_ID,
    /* This replacement was seeded directly on the store, so it carries no
       actor; a rotation through either surface names one (#1402). */
    triggeredBy: null,
  }]);
});

test("get and send resolve a named project alias to its canonical orchestrator seat", async () => {
  const canonical = "repo-0123456789abcdef0123456789abcdef";
  expect(persistProjectAliases([
    { source: "named-project", target: canonical, displayName: "named-project" },
  ])).toBe(true);
  seatActive(canonical, SEATED_ID, "/tmp/o.jsonl");

  const { control } = controlStub();
  const status = await bindingsWith(control).get_orchestrator({ clientRequestId: "get-alias", project: "named-project" });
  const delivery = await bindingsWith(control).send_message_to_orchestrator({
    clientRequestId: "send-alias",
    project: "named-project",
    text: "status?",
  });

  expect(status).toMatchObject({ project: canonical, designated: true, conversationId: SEATED_ID });
  expect(delivery).toMatchObject({ project: canonical, conversationId: SEATED_ID, created: false });
});

test("create_orchestrator posts the versioned approved default mandate through the seat route", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": { ok: true, conversationId: SEATED_ID, path: "/tmp/o.jsonl", seat: { conversationId: SEATED_ID }, state: "settled" },
  });
  const result = await bindingsWith(control).create_orchestrator({ clientRequestId: "create-1", project: "proj-a" });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/orchestrator/seat");
  expect(posts[0]!.body).toMatchObject({
    project: "proj-a",
    mandate: ORCHESTRATOR_SYSTEM_PROMPT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    clientRequestId: "create-1",
  });
  expect(result).toMatchObject({ conversationId: SEATED_ID, transcriptPath: "/tmp/o.jsonl" });
});

test("create_orchestrator rejects an explicit fresh-launch model outside the engine catalog before posting", async () => {
  const { posts, control } = controlStub();

  await expect(bindingsWith(control).create_orchestrator({
    clientRequestId: "create-invalid-model",
    project: "proj-a",
    engine: "claude",
    model: "claude-fable-5",
  })).rejects.toThrow("invalid claude model id \"claude-fable-5\"; valid claude model ids: opus, fable, sonnet, claude-sonnet-5-5, haiku");

  expect(posts).toEqual([]);
});

test("create_orchestrator adopts an eligible existing conversation through the seat route", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": { ok: true, conversationId: SEATED_ID, path: "/tmp/o.jsonl", seat: { conversationId: SEATED_ID }, state: "settled" },
  });

  const result = await bindingsWith(control).create_orchestrator({
    clientRequestId: "adopt-01",
    project: "proj-a",
    conversationId: SEATED_ID,
    model: "historical-provider-model",
  });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/orchestrator/seat");
  expect(posts[0]!.body).toMatchObject({
    project: "proj-a",
    conversationId: SEATED_ID,
    model: "historical-provider-model",
    clientRequestId: "adopt-01",
  });
  expect(result).toMatchObject({ conversationId: SEATED_ID, transcriptPath: "/tmp/o.jsonl" });
});

test("create_orchestrator reports an accepted asynchronous launch with durable identifiers", async () => {
  const { control } = controlStub({
    "/api/orchestrator/seat": {
      ok: true,
      accepted: true,
      state: "accepted",
      conversationId: SEATED_ID,
      launchId: "launch_async",
      seat: { conversationId: SEATED_ID },
    },
  });

  const result = await bindingsWith(control).create_orchestrator({
    clientRequestId: "accepted-01",
    project: "proj-a",
  });

  expect(result).toMatchObject({
    accepted: true,
    state: "accepted",
    conversationId: SEATED_ID,
    launchId: "launch_async",
  });
});

test("send_message_to_orchestrator resolves the seat server-side and delivers with the caller's idempotency key", async () => {
  seatActive("proj-a", SEATED_ID, "/tmp/o.jsonl");
  const { posts, control } = controlStub();
  const result = await bindingsWith(control).send_message_to_orchestrator({ clientRequestId: "send-1", project: "proj-a", text: "status?" });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/orchestrator/message");
  /* The delivery seam resumes a dead selected conversation on this same call —
     no duplicate is ever spawned for a session that merely died. */
  expect(posts[0]!.body).toMatchObject({
    project: "proj-a",
    conversationId: SEATED_ID,
    path: "/tmp/o.jsonl",
    clientMessageId: expect.stringMatching(/^mcp_orchestrator_/),
    text: "status?",
  });
  expect(result).toMatchObject({ conversationId: SEATED_ID, created: false });
});

test("send_message_to_orchestrator with nothing designated creates one first, then delivers — with derived keys and visible lineage", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": {
      ok: true,
      conversationId: SEATED_ID,
      seat: { conversationId: SEATED_ID, path: "/tmp/fresh.jsonl", seatEpoch: 1, predecessorConversationId: null },
    },
  });
  const result = await bindingsWith(control).send_message_to_orchestrator({ clientRequestId: "send-2", project: "proj-a", text: "kick off" });

  expect(posts.map((post) => post.pathname)).toEqual(["/api/orchestrator/seat", "/api/orchestrator/message"]);
  /* The creation key derives from the caller's, so a retried call replays both
     side effects instead of creating a second orchestrator. */
  expect(posts[0]!.body.clientRequestId).not.toBe("send-2");
  expect(posts[0]!.body).toMatchObject({ mandate: ORCHESTRATOR_SYSTEM_PROMPT, promptVersion: ORCHESTRATOR_PROMPT_VERSION });
  expect(posts[1]!.body).toMatchObject({ conversationId: SEATED_ID, clientMessageId: expect.stringMatching(/^mcp_orchestrator_/), text: "kick off" });
  expect(result).toMatchObject({ created: true, conversationId: SEATED_ID, seatEpoch: 1 });
});

/* ── BLOCKING 1: designation is an OPERATION contract, not self-service ──── */

const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");
let previousCapability: string | undefined;

function asCapabilityCaller(): void {
  previousCapability = process.env.LLV_SPAWN_CAPABILITY;
  process.env.LLV_SPAWN_CAPABILITY = WORKER_CAPABILITY;
  setCallerConversationResolverForTests((digest) =>
    digest === crypto.createHash("sha256").update(WORKER_CAPABILITY).digest("hex")
      ? "conversation_worker"
      : null);
}

function restoreCapabilityCaller(): void {
  if (previousCapability === undefined) delete process.env.LLV_SPAWN_CAPABILITY;
  else process.env.LLV_SPAWN_CAPABILITY = previousCapability;
  setCallerConversationResolverForTests(null);
}

test("a NON-OPERATOR caller cannot DESIGNATE itself or anyone: create and send's create branch are refused by the real operator gate, writing nothing", async () => {
  asCapabilityCaller();
  try {
    const { designations, control } = gatedControlStub();
    const tools = bindingsWith(control);

    /* Both designation paths run — the tools are ON the surface for this
       session (axis 1) — and both are refused by the gate that reads the
       forwarded conversation capability, before anything durable changes. */
    await expect(tools.create_orchestrator({
      clientRequestId: "create-x",
      project: "proj-a",
      conversationId: "conversation_worker",
    })).rejects.toThrow();
    await expect(tools.send_message_to_orchestrator({ clientRequestId: "send-x", project: "proj-a", text: "hi" })).rejects.toThrow();

    expect(designations).toEqual([]);
    const { active, pending } = orchestratorSeatFor("proj-a");
    expect(active).toBeNull();
    expect(pending).toBeNull();
  } finally {
    restoreCapabilityCaller();
  }
});

test("REGRESSION (#1402): the same non-operator caller ROTATES, and the rotation is attributed to it", async () => {
  asCapabilityCaller();
  try {
    const { rotations, control } = gatedControlStub();
    const result = await bindingsWith(control).rotate_orchestrator({
      clientRequestId: "rotate-x",
      project: "proj-a",
    }) as Record<string, unknown>;

    /* The tool forwarded the caller's own capability, exactly as it does for
       create — and rotation reads that name to attribute the rotation. See
       src/lib/orchestrator/rotationAuthority.test.ts for the same call carried
       end to end into the durable seat record. */
    expect(rotations).toEqual(["conversation_worker"]);
    expect(result.triggeredBy).toMatchObject({ kind: "agent", conversationId: "conversation_worker" });
  } finally {
    restoreCapabilityCaller();
  }
});

test("an operator-lane caller (no conversation capability) still designates through the same gate", async () => {
  const { designations, control } = gatedControlStub();
  const result = await bindingsWith(control).create_orchestrator({ clientRequestId: "create-y", project: "proj-a" });
  expect(designations).toEqual(["/api/orchestrator/seat"]);
  expect(result).toMatchObject({ conversationId: SEATED_ID });
});

test("the adoption target reaches the authorized seat route while prompt provenance stays server-owned", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/seat": { ok: true, conversationId: SEATED_ID, seat: { conversationId: SEATED_ID } },
  });
  await bindingsWith(control).create_orchestrator({
    clientRequestId: "create-z",
    project: "proj-a",
    /* Route-level operator authorization decides whether this existing
       conversation can be adopted. Prompt provenance remains server-owned. */
    conversationId: "conversation_worker",
    promptVersion: 99,
  });
  expect(posts[0]!.body.conversationId).toBe("conversation_worker");
  expect(posts[0]!.body.promptVersion).toBe(ORCHESTRATOR_PROMPT_VERSION);

  await bindingsWith(control).rotate_orchestrator({
    clientRequestId: "rotate-z",
    project: "proj-a",
    conversationId: "conversation_worker",
    promptVersion: 99,
  });
  const rotate = posts.find((post) => post.pathname === "/api/orchestrator/rotate");
  expect(rotate!.body).not.toHaveProperty("conversationId");
  expect(rotate!.body).not.toHaveProperty("promptVersion");
});

/* #1452, #2030: a seat created under mandate v3 («you do not talk to the user»)
   once rotated v3 into every successor. The ROUTE now rebuilds a stale core
   from the current default and keeps the rotation history behind it
   (`seatCommand.test.ts`), so the tool names no mandate: sending the default
   from here replaced the whole mandate and dropped that history. */
test("rotate_orchestrator over a STALE seat leaves the core rebuild to the route (#1452, #2030)", async () => {
  seatActive("proj-a", SEATED_ID, null, 3);
  const { posts, control } = controlStub({ "/api/orchestrator/rotate": { ok: true } });
  await bindingsWith(control).rotate_orchestrator({ clientRequestId: "rotate-stale", project: "proj-a" });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).not.toHaveProperty("mandate");
  expect(posts[0]!.body).not.toHaveProperty("keepIncumbentMandate");
});

test("rotate_orchestrator over a seat on the current default names no mandate, so the route keeps the incumbent's (#1452)", async () => {
  seatActive("proj-a", SEATED_ID, null, ORCHESTRATOR_PROMPT_VERSION);
  const { posts, control } = controlStub({ "/api/orchestrator/rotate": { ok: true } });
  await bindingsWith(control).rotate_orchestrator({ clientRequestId: "rotate-current", project: "proj-a" });
  expect(posts[0]!.body).not.toHaveProperty("mandate");
});

test("rotate_orchestrator over bespoke (unversioned) rules keeps them — they claim no version and are never stale (#1452)", async () => {
  seatActive("proj-a", SEATED_ID, null, null);
  const { posts, control } = controlStub({ "/api/orchestrator/rotate": { ok: true } });
  await bindingsWith(control).rotate_orchestrator({ clientRequestId: "rotate-bespoke", project: "proj-a" });
  expect(posts[0]!.body).not.toHaveProperty("mandate");
});

test("keepIncumbentMandate carries a STALE incumbent's text forward explicitly, and an explicit mandate wins over both (#1452)", async () => {
  seatActive("proj-a", SEATED_ID, null, 3);
  const { posts, control } = controlStub({ "/api/orchestrator/rotate": { ok: true } });
  await bindingsWith(control).rotate_orchestrator({ clientRequestId: "rotate-keep", project: "proj-a", keepIncumbentMandate: true });
  expect(posts[0]!.body).not.toHaveProperty("mandate");
  expect(posts[0]!.body.keepIncumbentMandate).toBe(true);

  await bindingsWith(control).rotate_orchestrator({ clientRequestId: "rotate-named", project: "proj-a", mandate: "run it my way" });
  expect(posts[1]!.body.mandate).toBe("run it my way");
});

test("rotate_orchestrator forwards the requested effort to the rotation route so it reaches the successor spawn", async () => {
  const { posts, control } = controlStub({ "/api/orchestrator/rotate": { ok: true } });
  await bindingsWith(control).rotate_orchestrator({
    clientRequestId: "rotate-effort",
    project: "proj-a",
    effort: "medium",
  });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body.effort).toBe("medium");
});

test("rotate_orchestrator relays to the rotation route and reports the lineage it produced", async () => {
  const { posts, control } = controlStub({
    "/api/orchestrator/rotate": {
      ok: true,
      conversationId: SEATED_ID,
      seat: { conversationId: SEATED_ID },
      rotatedFrom: { conversationId: "conversation_old", seatEpoch: 1 },
    },
  });
  const result = await bindingsWith(control).rotate_orchestrator({
    clientRequestId: "rotate-1",
    project: "proj-a",
    handoffNotes: "prioritize reviews",
  });

  expect(posts).toHaveLength(1);
  expect(posts[0]!.pathname).toBe("/api/orchestrator/rotate");
  expect(posts[0]!.body).toMatchObject({ project: "proj-a", handoffNotes: "prioritize reviews", clientRequestId: "rotate-1" });
  expect(result).toMatchObject({ rotatedFrom: { conversationId: "conversation_old" } });
});

function projectService(control: ViewerControlDependencies, projects = [
  { project: "project-a", displayName: "Example project" },
], overrides: Partial<ViewerMcpDomainDependencies> = {}) {
  const domain = {
    registrySnapshot: () => ({ conversations: { conversation_caller: { id: "conversation_caller", projectOwnership: { project: "caller-project" }, generations: [], continuityPaths: [] } }, conversationAliases: {} }),
    callerAttribution: () => ({ kind: "agent", role: "orchestrator", conversationId: "conversation_caller" }),
    attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_caller" }),
    authorizedSeats: () => [{ project: "caller-project", conversationId: "conversation_caller", path: null }],
    completedFileScan: async () => ({ snapshot: { files: [], projectCatalog: projects.map(project => ({ ...project, smt: 1, conversations: 1 })), complete: true } }),
    ...overrides,
  } as unknown as ViewerMcpDomainDependencies;
  const receipts = new MemoryMcpReceiptStore();
  return { receipts, service: createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) }) };
}

test("a seat caller sends to the seat named by the project's display name", async () => {
  seatActive("project-a", SEATED_ID, null);
  const { posts, control } = controlStub();
  const { service } = projectService(control);
  const result = await service.callTool("send_message_to_orchestrator", { clientRequestId: "display-send", project: "Example project", text: "status?" });
  expect(result).toMatchObject({ ok: true, project: "project-a", conversationId: SEATED_ID, created: false });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toMatchObject({ project: "project-a", conversationId: SEATED_ID });
  expect(orchestratorSeatFor("Example project").active).toBeNull();
});

for (const changedName of ["renamed", "ambiguous"] as const) {
  for (const uncertain of [false, true]) {
    test(`original-key orchestrator send recovery survives a ${changedName === "renamed" ? "renamed" : "newly ambiguous"} display name with ${uncertain ? "uncertain" : "settled"} admission`, async () => {
      seatActive("project-a", SEATED_ID, null);
      const projects = [{ project: "project-a", displayName: "Example project" }];
      let posts = 0;
      const { service, receipts } = projectService({ post: async () => {
        posts++;
        if (uncertain) throw new McpDispatchUncertainError("response lost");
        return { ok: true, outcome: "delivered", operationId: "fixture-operation" };
      } }, projects);
      let claims = 0;
      const claim = receipts.claim.bind(receipts);
      receipts.claim = (...args) => { claims++; return claim(...args); };
      const args = { clientRequestId: "name-recovery", project: "Example project", text: "status?" };
      const original = await service.callTool("send_message_to_orchestrator", args);
      expect(original).toMatchObject(uncertain ? { ok: false, code: "outcome_unknown" } : { ok: true });
      if (changedName === "renamed") projects[0]!.displayName = "Renamed project";
      else projects.push({ project: "project-b", displayName: "Example project" });
      for (const recoveryOnly of [false, true]) {
        expect(await service.callTool("send_message_to_orchestrator", { ...args, recoveryOnly })).toMatchObject(
          uncertain ? { ok: false, code: "outcome_unknown", details: { nextAction: "original-key-lookup" } } : { ok: true, replayed: true, conversationId: SEATED_ID },
        );
      }
      expect(await service.callTool("send_message_to_orchestrator", { ...args, text: "changed" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
      expect(posts).toBe(1);
      expect(claims).toBe(1);
    });
  }
}

test("renamed-project receipt recovery still refuses a different authenticated relay sender", async () => {
  seatActive("project-a", SEATED_ID, null);
  const projects = [{ project: "project-a", displayName: "Example project" }];
  let caller = "conversation_caller";
  const { posts, control } = controlStub();
  const { service } = projectService(control, projects, {
    callerAttribution: () => ({ kind: "gateway", conversationId: caller }),
    attentionAuthority: () => ({ kind: "worker", conversationId: caller }),
  });
  const args = { clientRequestId: "renamed-ownership", project: "Example project", text: "status?" };
  expect((await service.callTool("send_message_to_orchestrator", args)).ok).toBe(true);
  projects[0]!.displayName = "Renamed project";
  caller = "conversation_other";
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: false, code: "recovery_not_permitted" });
  expect(posts).toHaveLength(1);
});

for (const tool of ["create_orchestrator", "rotate_orchestrator", "ask_orchestrator_in_parallel"] as const) {
  for (const changedName of ["renamed", "ambiguous"] as const) {
    for (const uncertain of [false, true]) test(`recorded ${uncertain ? "uncertain" : "settled"} ${tool} replays after its display name becomes ${changedName}`, async () => {
      const projects = [{ project: "project-a", displayName: "Example project" }];
      const { posts, control } = controlStub();
      const { service } = projectService({ post: async (...args) => {
        const result = await control.post(...args);
        if (uncertain) throw new McpDispatchUncertainError("response lost");
        return result;
      } }, projects);
      const args = { clientRequestId: "wrapped-name-recovery", project: "Example project", text: "status?" };
      const original = await service.callTool(tool, args);
      expect(original).toMatchObject(uncertain ? { ok: false, details: { outcome: "unknown", nextAction: "original-key-lookup" } } : { ok: true });
      if (changedName === "renamed") projects[0]!.displayName = "Renamed project";
      else projects.push({ project: "project-b", displayName: "Example project" });
      expect(await service.callTool(tool, args)).toEqual({ ...original, replayed: true });
      expect(await service.callTool(tool, { ...args, text: "changed" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
      expect(posts).toHaveLength(1);
    });
  }
}


test("unknown orchestrator project is refused before claiming or dispatching", async () => {
  const { posts, control } = controlStub();
  const { service, receipts } = projectService(control);
  const result = await service.callTool("send_message_to_orchestrator", { clientRequestId: "unknown-send", project: "Missing project", text: "status?" });
  expect(result).toMatchObject({ ok: false, code: "unknown_project", details: { outcome: "not-executed", nextAction: "new-request-permitted" } });
  expect(result.error).toContain('unknown project "Missing project"');
  expect(result.error).toContain("project key");
  expect(posts).toEqual([]);
  expect(receipts.lookup("send_message_to_orchestrator:unknown-send")).toBeNull();
  expect(orchestratorSeatFor("Missing project").pending).toBeNull();
});

test("ambiguous orchestrator display name names candidates and claims nothing", async () => {
  const { posts, control } = controlStub();
  const { service, receipts } = projectService(control, [
    { project: "project-a", displayName: "Example project" },
    { project: "project-b", displayName: "Example project" },
  ]);
  const result = await service.callTool("send_message_to_orchestrator", { clientRequestId: "ambiguous-send", project: "Example project", text: "status?" });
  expect(result).toMatchObject({ ok: false, code: "ambiguous_project", details: { outcome: "not-executed", candidates: ["project-a", "project-b"] } });
  expect(result.error).toContain("project-a, project-b");
  expect(posts).toEqual([]);
  expect(receipts.lookup("send_message_to_orchestrator:ambiguous-send")).toBeNull();
});

test("get_orchestrator resolves a display name and explicitly refuses an unknown project", async () => {
  seatActive("project-a", SEATED_ID, null);
  const { posts, control } = controlStub();
  const { service } = projectService(control);
  expect(await service.callTool("get_orchestrator", { project: "Example project" })).toMatchObject({ ok: true, project: "project-a", designated: true, conversationId: SEATED_ID });
  const unknown = await service.callTool("get_orchestrator", { project: "Missing project" });
  expect(unknown).toMatchObject({ ok: false, code: "unknown_project" });
  expect(unknown).not.toHaveProperty("designated");
  expect(unknown).not.toHaveProperty("seat");
  expect(posts).toEqual([]);
});

test("server 403 on seat creation retains its cause and closes the send as not executed", async () => {
  asCapabilityCaller();
  const posts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    posts.push(new URL(request.url).pathname);
    return seatPOST(request as never);
  } });
  const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  try {
    const { service } = projectService(productionViewerControlDependencies());
    const args = { clientRequestId: "refused-create", project: "Example project", text: "status?" };
    const result = await service.callTool("send_message_to_orchestrator", args);
    expect(result).toMatchObject({ ok: false, error: "this is an operator-only action; an agent may not perform it, whatever role it holds", details: { status: 403, admission: "refused", outcome: "not-executed", nextAction: "new-request-permitted" } });
    expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ...result, replayed: true });
    expect(posts).toEqual(["/api/orchestrator/seat"]);
    expect(orchestratorSeatFor("Example project").active).toBeNull();
  } finally {
    if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
    await server.stop(true);
    restoreCapabilityCaller();
  }
});


test("all orchestrator project inputs share resolution and refuse unknown or ambiguous names before posting", async () => {
  const { posts, control } = controlStub();
  const { service, receipts } = projectService(control);
  for (const tool of ["create_orchestrator", "rotate_orchestrator", "ask_orchestrator_in_parallel", "seat_tick_settings"] as const) {
    const known = await service.callTool(tool, { clientRequestId: `known-${tool}`, project: "Example project", text: "check progress" });
    expect(known.ok).toBe(true);
    if (tool === "seat_tick_settings") expect(known).toMatchObject({ project: "project-a" });
    else expect(posts.at(-1)!.body.project).toBe("project-a");
    const count = posts.length;
    expect(await service.callTool(tool, { clientRequestId: `unknown-${tool}`, project: "Missing project", text: "check progress" })).toMatchObject({ ok: false, code: "unknown_project", details: { outcome: "not-executed" } });
    const ambiguousFixture = projectService(control, [
      { project: "project-a", displayName: "Example project" },
      { project: "project-b", displayName: "Example project" },
    ]);
    expect(await ambiguousFixture.service.callTool(tool, { clientRequestId: `ambiguous-${tool}`, project: "Example project", text: "check progress" })).toMatchObject({ ok: false, code: "ambiguous_project" });
    expect(posts).toHaveLength(count);
    expect(receipts.lookup(`${tool}:unknown-${tool}`)).toBeNull();
    expect(ambiguousFixture.receipts.lookup(`${tool}:ambiguous-${tool}`)).toBeNull();
  }
});

test("get_orchestrator on an unknown project returns a refusal with no designation fields", async () => {
  const { control } = controlStub();
  const { service } = projectService(control);
  const result = await service.callTool("get_orchestrator", { project: "Missing project" });
  expect(result).toMatchObject({ ok: false, code: "unknown_project", details: { outcome: "not-executed" } });
  expect(result).not.toHaveProperty("designated");
  expect(result).not.toHaveProperty("seat");
});

test("display names shared by aliases of one key resolve to one seat", async () => {
  persistProjectAliases([{ source: "older-key", target: "project-a", displayName: "Example project" }]);
  seatActive("project-a", SEATED_ID, null);
  const { control } = controlStub();
  const { service } = projectService(control, [
    { project: "older-key", displayName: "Example project" },
    { project: "project-a", displayName: "Example project" },
  ]);
  expect(await service.callTool("get_orchestrator", { project: "Example project" })).toMatchObject({ ok: true, project: "project-a", designated: true });
});


test("orchestrator creation, rotation and parallel asks preserve definite server refusals", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ error: "orchestrator request is invalid", code: "invalid_orchestrator_request", admission: "refused" }, { status: 422 });
  } });
  const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  try {
    const { service } = projectService(productionViewerControlDependencies());
    for (const tool of ["create_orchestrator", "rotate_orchestrator", "ask_orchestrator_in_parallel"] as const) {
      expect(await service.callTool(tool, { clientRequestId: `refused-${tool}`, project: "Example project", text: "status?" })).toMatchObject({
        ok: false, error: "orchestrator request is invalid", details: { status: 422, code: "invalid_orchestrator_request", outcome: "not-executed", nextAction: "new-request-permitted" },
      });
    }
  } finally {
    if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
    await server.stop(true);
  }
});

for (const pendingReplay of [false, true]) test(`real nested spawn validation ${pendingReplay ? "retains uncertainty for a pending replay" : "refuses orchestrator creation before launch admission"}`, async () => {
  const replies: { status: number; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const reply = await executeOrchestratorSeatRequest(await request.json(), {
      ...productionSeatCommandDependencies,
      engineReadiness: () => "connected",
      spawn: async (body) => {
        const response = await executeSpawnRequest({ headers: new Headers({ host: "127.0.0.1", [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability() }), json: async () => body } as unknown as NextRequest, {
          ...productionSpawnCommandDependencies, registry: () => testRegistry, engineReadiness: () => "connected",
        });
        return { status: response.status, body: await response.json() };
      },
    });
    replies.push(reply);
    return Response.json(reply.body, { status: reply.status });
  } });
  const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  try {
    const { service } = projectService(productionViewerControlDependencies());
    const args = { clientRequestId: "nested-validator-refused", project: "Example project", cwd: path.join(sandbox, "missing-directory") };
    if (pendingReplay) beginOrchestratorSeatIntent({ project: "project-a", mandate: "own the board", clientRequestId: args.clientRequestId, mode: "spawn", engine: "claude", model: "opus", telegramGrant: false, now: AT });
    const result = await service.callTool("create_orchestrator", args);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ status: 400, body: { error: expect.stringContaining("directory does not exist") } });
    expect(testRegistry.spawnReceiptForClientAttempt(args.clientRequestId)).toBeNull();
    expect(result).toMatchObject(pendingReplay ? {
      ok: false, code: "outcome_unknown", retryable: false,
      details: { status: 400, outcome: "unknown", nextAction: "original-key-lookup" },
    } : {
      ok: false, error: expect.stringContaining("directory does not exist"), retryable: false,
      details: { status: 400, admission: "refused", outcome: "not-executed", nextAction: "new-request-permitted" },
    });
    expect(await service.callTool("create_orchestrator", args)).toEqual({ ...result, replayed: true });
    expect(replies).toHaveLength(1);
  } finally {
    if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
    await server.stop(true);
  }
});

for (const probe of [
  { tool: "ask_orchestrator_in_parallel", gateway: false, status: 403, code: "asker_refused", cause: "only the operator or the voice gateway" },
  { tool: "ask_orchestrator_in_parallel", gateway: true, status: 404, code: "seat_not_found", cause: "no orchestrator seat is active" },
  { tool: "create_orchestrator", gateway: false, operator: true, status: 400, code: "orchestrator_refused", cause: "conversationId is invalid", conversationId: "invalid" },
  { tool: "rotate_orchestrator", gateway: false, status: 409, code: "no_incumbent", cause: "no orchestrator is designated" },
] as const) {
  test(`real ${probe.tool} ${probe.status} refusal is not executed with its original cause`, async () => {
    asCapabilityCaller();
    if ("operator" in probe) delete process.env.LLV_SPAWN_CAPABILITY;
    setDeputyRootResolverForTests(() => probe.gateway ? "conversation_worker" : "conversation_root");
    let posts = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      posts++;
      const handler = new URL(request.url).pathname.endsWith("/ghost") ? ghostPOST
        : new URL(request.url).pathname.endsWith("/rotate") ? rotatePOST : seatPOST;
      return handler(new NextRequest(request));
    } });
    const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
    process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
    try {
      const { service } = projectService(productionViewerControlDependencies());
      const args = { clientRequestId: `real-refused-${probe.status}`, project: "Example project", text: "status?", ...("conversationId" in probe ? { conversationId: probe.conversationId } : {}) };
      const result = await service.callTool(probe.tool, args);
      expect(result).toMatchObject({
        ok: false, code: probe.code, error: expect.stringContaining(probe.cause), retryable: false,
        details: { status: probe.status, admission: "refused", outcome: "not-executed", nextAction: "new-request-permitted" },
      });
      expect(posts).toBe(1);
      expect(orchestratorSeatFor("project-a")).toEqual({ active: null, pending: null, history: [] });
      expect(readDeputies()).toEqual([]);
    } finally {
      if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
      else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
      await server.stop(true);
      setDeputyRootResolverForTests(null);
      restoreCapabilityCaller();
    }
  });
}

for (const [name, handler] of [["seat", seatPOST], ["rotate", rotatePOST], ["ghost", ghostPOST], ["message", messagePOST]] as const) {
  for (const malformed of [false, true]) {
    test(`real ${name} route marks ${malformed ? "invalid JSON" : "cross-origin"} before admission`, async () => {
      const response = await handler(new NextRequest(`http://127.0.0.1/api/orchestrator/${name}`, {
        method: "POST", headers: { host: "127.0.0.1", ...(malformed ? {} : { origin: "https://example.com" }) },
        body: "{",
      }));
      expect(response.status).toBe(malformed ? 400 : 403);
      expect(await response.json()).toMatchObject({ admission: "refused", error: malformed ? "invalid JSON" : "forbidden: cross-origin request" });
      expect(orchestratorSeatFor("project-a")).toMatchObject({ active: null, pending: null });
      expect(readDeputies()).toEqual([]);
    });
  }
}

for (const tool of ["create_orchestrator", "send_message_to_orchestrator"] as const) {
  test(`${tool} never permits a new request after an admitted spawn loses activation`, async () => {
    let admitted = 0;
    const deps: SeatCommandDependencies = {
      spawn: async (body) => {
        admitted++;
        failOrchestratorSeatIntent("project-a", String(body.clientAttemptId), "superseded", AT);
        beginOrchestratorSeatIntent({ project: "project-a", mandate: "new designation", clientRequestId: "newer-designation", mode: "spawn", now: AT });
        return { status: 202, body: { ok: true, conversationId: SEATED_ID, launchId: "fixture-launch" } };
      },
      deliver: async () => { throw new Error("unexpected delivery"); },
      conversationTarget: () => null,
      summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
      launchSettlement: () => ({ kind: "unknown" }),
      stampRegistryIdentity: () => { throw new Error("unexpected activation"); },
      runtimeIdentity: () => ({ engine: null, model: null }),
      resolvedConversation: () => null,
      projectRoot: () => sandbox,
      now: () => AT,
    };
    const replies: { status: number; body: Record<string, unknown> }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const reply = await executeOrchestratorSeatRequest(await request.json(), deps);
      replies.push(reply);
      return Response.json(reply.body, { status: reply.status });
    } });
    const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
    process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
    try {
      const { service } = projectService(productionViewerControlDependencies());
      const args = { clientRequestId: `superseded-${tool}`, project: "Example project", text: "status?" };
      const result = await service.callTool(tool, args);
      expect(admitted).toBe(1);
      expect(replies).toEqual([{ status: 409, body: { error: "seat intent was superseded by a newer designation" } }]);
      expect(result).toMatchObject({ ok: false, retryable: false, details: { outcome: "unknown", nextAction: "original-key-lookup" } });
      const replay = await service.callTool(tool, args);
      expect(replay).toMatchObject({ ok: false, retryable: false, details: { outcome: "unknown", nextAction: "original-key-lookup" } });
      expect(admitted).toBe(1);
    } finally {
      if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
      else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
      await server.stop(true);
    }
  });
}

test("bridge directives resolve explicit display names and aliases while keeping omitted-project routing", async () => {
  persistProjectAliases([{ source: "older-key", target: "project-a", displayName: "Example project" }]);
  const { posts, control } = controlStub();
  const { service } = projectService(control, undefined, {
    callerProject: () => "project-a",
    authorizedSeats: () => [{ project: "project-a", conversationId: SEATED_ID, path: null }],
  });
  for (const project of ["project-a", "Example project", "older-key", undefined]) {
    const result = await service.callTool("bridge_directive", { clientRequestId: `directive-${posts.length}`, project, rootTurnId: "turn_fixture", utterance: posts.length, instruction: "check progress" });
    expect(result).toMatchObject({ ok: true });
    expect(posts.at(-1)!.body).toMatchObject({ conversationId: SEATED_ID });
  }
  expect(posts).toHaveLength(4);
});

test("unknown and ambiguous bridge projects refuse before receipt access or delivery", async () => {
  const { posts, control } = controlStub();
  const { service, receipts } = projectService(control, [
    { project: "project-a", displayName: "Example project" },
    { project: "project-b", displayName: "Example project" },
  ]);
  for (const [project, code] of [["Missing project", "unknown_project"], ["Example project", "ambiguous_project"]]) {
    const key = `directive-${code}`;
    const result = await service.callTool("bridge_directive", { clientRequestId: key, project, rootTurnId: "turn_fixture", utterance: 0, instruction: "check progress" });
    expect(result).toMatchObject({ ok: false, code, details: { outcome: "not-executed", nextAction: "new-request-permitted" } });
    if (code === "ambiguous_project") expect(result).toMatchObject({ details: { candidates: ["project-a", "project-b"] } });
    expect(receipts.lookup(`bridge_directive:${key}`)).toBeNull();
  }
  expect(posts).toEqual([]);
});

test("a definite message refusal after seat creation preserves both the cause and created recipient", async () => {
  const posts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname;
    posts.push(pathname);
    return pathname === "/api/orchestrator/seat"
      ? Response.json({ ok: true, seat: { conversationId: SEATED_ID } })
      : Response.json({ error: "the recipient cannot accept this relay", code: "orchestrator_relay_refused", admission: "refused" }, { status: 403 });
  } });
  const previousUrl = process.env.LLV_VIEWER_CONTROL_URL;
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  try {
    const { service, receipts } = projectService(productionViewerControlDependencies());
    const args = { clientRequestId: "created-then-refused", project: "Example project", text: "status?" };
    const result = await service.callTool("send_message_to_orchestrator", args);
    expect(result).toMatchObject({
      ok: false, code: "orchestrator_relay_refused", error: "the recipient cannot accept this relay", retryable: false,
      details: { status: 403, code: "orchestrator_relay_refused", outcome: "settled", messageOutcome: "not-executed", created: true, conversationId: SEATED_ID },
    });
    expect(result).toMatchObject({ details: { nextAction: "follow-disposition" } });
    expect(receipts.lookup("send_message_to_orchestrator:created-then-refused")).toMatchObject({ stage: "settled", binding: { target: { identity: SEATED_ID } } });
    expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ...result, replayed: true });
    expect(posts).toEqual(["/api/orchestrator/seat", "/api/orchestrator/message"]);
  } finally {
    if (previousUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previousUrl;
    await server.stop(true);
  }
});

test("transport uncertainty after creation keeps the bound recipient and original-key recovery", async () => {
  const posts: string[] = [];
  const control: ViewerControlDependencies = { post: async (pathname) => {
    posts.push(pathname);
    if (pathname === "/api/orchestrator/seat") return { ok: true, seat: { conversationId: SEATED_ID } };
    throw new McpDispatchUncertainError("the connection reset after the message request was sent");
  } };
  const { service, receipts } = projectService(control);
  const args = { clientRequestId: "created-then-uncertain", project: "Example project", text: "status?" };
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({
    ok: false, code: "outcome_unknown", retryable: false,
    details: { outcome: "unknown", nextAction: "original-key-lookup" },
  });
  expect(receipts.lookup("send_message_to_orchestrator:created-then-uncertain")).toMatchObject({ stage: "dispatching", binding: { target: { identity: SEATED_ID } } });
  expect(await service.callTool("send_message_to_orchestrator", args)).toMatchObject({ ok: false, code: "outcome_unknown", details: { nextAction: "original-key-lookup" } });
  expect(posts).toEqual(["/api/orchestrator/seat", "/api/orchestrator/message"]);
});
