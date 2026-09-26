import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBridgeReportLog } from "@/lib/bridge/store";
import { openBridgeChannel } from "@/lib/bridge/store";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { activateDeputy, beginDeputy, endDeputy, productionDeputyPrincipal, recordDeputyFork } from "@/lib/orchestrator/deputies";
import {
  activeOrchestratorSeats,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  orchestratorRevocations,
} from "@/lib/orchestrator/seats";

import { defaultSeatTickSettings, type SeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { pauseResumeDetail, type PauseResumeActor } from "@/lib/pauseResumeActor";

import { callerAttributionFrom, flowDecisionCaller, viewerMcpBindings, type CallerAttribution, type ViewerControlDependencies } from "./bindings";
import { McpToolRefusal } from "./server";

/*
 * docs/design/ghost-seat.md §4: a live deputy of the seat is attributed as the
 * seat — `manager`, under the SEAT's conversation id, with `via.deputy` naming
 * itself — over the REAL seat and deputy records. Every surface that reads the
 * label then treats it as the seat with no change of its own, and the two
 * named exceptions refuse it.
 */

const PROJECT = "proj-ghost";
const SEAT = "conversation_seat";
const GHOST = "conversation_ghost";
let sandbox = "";
let previousStateDir: string | undefined;
let posted: { pathname: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deputy-attribution-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  beginOrchestratorSeatIntent({ project: PROJECT, mandate: "own the board", clientRequestId: "seed", mode: "spawn" });
  completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "seed", conversationId: SEAT, path: null });
  posted = [];
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function seats() {
  return authorizedManagerSeats({
    activeSeats: activeOrchestratorSeats,
    revocations: orchestratorRevocations,
    conversationFacts: () => ({ superseded: false, hasGeneration: true, project: null }),
    resolveAlias: (id) => id,
  });
}

function startDeputy(): string {
  const seat = activeOrchestratorSeats()[0]!;
  const begun = beginDeputy({
    project: PROJECT,
    seatConversationId: SEAT,
    seatEpoch: seat.seatEpoch,
    seatPath: null,
    clientRequestId: "ask-1",
    ask: { text: "file a task for the flaky test", images: 0, sender: null, origin: { kind: "operator" } },
  });
  if (begun.kind !== "begun") throw new Error("deputy did not begin");
  recordDeputyFork(begun.deputy.askId, { deputyConversationId: GHOST, artifactPath: "/fixture/ghost.jsonl", forkRecordCount: 12 });
  activateDeputy(begun.deputy.askId);
  return begun.deputy.askId;
}

/** The production fold over the real records, for a caller named by its capability. */
function attributionFor(conversationId: string): CallerAttribution {
  const managers = seats();
  return callerAttributionFrom(
    { kind: "worker", conversationId, role: null },
    (id) => managers.some((seat) => seat.conversationId === id),
    (id) => productionDeputyPrincipal(id)?.seatConversationId ?? null,
  );
}

function tools(attribution: CallerAttribution) {
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
      return { outcome: "delivered", operationId: "op-1" };
    },
  };
  return viewerMcpBindings(undefined, control, {
    callerAttribution: () => attribution,
    callerProject: () => PROJECT,
    authorizedSeats: seats,
    viewerProjects: () => [PROJECT],
  } as never);
}

async function refusalCode(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (error instanceof McpToolRefusal) return error.details.code;
    throw error;
  }
  throw new Error("the call was not refused");
}

test("a live deputy is labelled manager under the seat's id, and names itself in via", () => {
  startDeputy();
  expect(attributionFor(GHOST)).toEqual({ kind: "manager", conversationId: SEAT, role: null, via: { deputy: GHOST } });
  /* The seat itself is unchanged, and an unrelated worker stays an agent. */
  expect(attributionFor(SEAT)).toEqual({ kind: "manager", conversationId: SEAT, role: null });
  expect(attributionFor("conversation_worker")).toEqual({ kind: "agent", conversationId: "conversation_worker", role: null });
});

test("an ended deputy is an ordinary agent again", () => {
  const askId = startDeputy();
  endDeputy(askId, { outcome: "done" });
  expect(attributionFor(GHOST)).toEqual({ kind: "agent", conversationId: GHOST, role: null });
});

test("a deputy's report takes the orchestrator's shape", async () => {
  startDeputy();
  openBridgeChannel("root_directive");
  const result = await tools(attributionFor(GHOST)).bridge_report({ clientRequestId: "rep-1", key: "k-1", class: "status", body: "task filed" }) as { recorded?: boolean };
  expect(result.recorded).toBe(true);
  const row = readBridgeReportLog().reports[0]!;
  expect(row.origin).toMatchObject({ kind: "manager", conversationId: SEAT });
  expect(row.body).not.toContain("not the manager");
  /* The stored row keeps the deputy that wrote it (§4 rule 2). */
  expect(row.origin?.via).toEqual({ deputy: GHOST });
});

test("a deputy's tick-settings write records the seat and the deputy as setBy", async () => {
  startDeputy();
  let written: SeatTickSettings | null = null;
  const as = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => attributionFor(GHOST),
    callerProject: () => PROJECT,
    authorizedSeats: seats,
    readTickSettings: (project: string) => defaultSeatTickSettings(project),
    writeTickSettings: (_project: string, settings: SeatTickSettings) => { written = settings; },
  } as never);
  await as.seat_tick_settings({ clientRequestId: "t-1", monitorPrompt: "watch lane #2244" });
  expect(written!.setBy).toMatchObject({ kind: "manager", conversationId: SEAT, via: { deputy: GHOST } });
});

test("a deputy's pause names the seat and the deputy on the actor the lane stores", async () => {
  startDeputy();
  const actors: unknown[] = [];
  const as = viewerMcpBindings(undefined, undefined, {
    callerAttribution: () => attributionFor(GHOST),
    callerProject: () => PROJECT,
    authorizedSeats: seats,
    getPipelines: () => ({ pipelines: [] }),
    patchPipeline: async (_id: string, _request: unknown, _ports: unknown, actor: unknown) => {
      actors.push(actor);
      return { error: "stop here", status: 409 };
    },
  } as never);
  await as.pipeline_action({ clientRequestId: "p-1", pipelineId: "pipeline_1", action: "pause" }).catch(() => undefined);
  expect(actors[0]).toEqual({ kind: "agent", role: "orchestrator", conversationId: SEAT, via: { deputy: GHOST } });
  expect(pauseResumeDetail("paused", actors[0] as PauseResumeActor)).toBe(`paused by orchestrator ${SEAT} (parallel self ${GHOST})`);
});

test("a deputy submits a flow decision as itself: it is nobody's implementer, and the seat's turn is not its to settle", () => {
  startDeputy();
  expect(flowDecisionCaller(attributionFor(GHOST))).toBe(GHOST);
  expect(flowDecisionCaller(attributionFor(SEAT))).toBe(SEAT);
});

test("a deputy may not deploy or rotate the seat", async () => {
  startDeputy();
  const as = tools(attributionFor(GHOST));
  expect(await refusalCode(as.deploy_exact_sha({ clientRequestId: "d-1", revision: "a".repeat(40) }))).toBe("deputy_cannot_deploy");
  expect(await refusalCode(as.rotate_orchestrator({ clientRequestId: "r-1", project: PROJECT }))).toBe("deputy_cannot_rotate");
  expect(posted).toEqual([]);
});

test("a deputy's directive to its own seat is the self-relay the tool refuses", async () => {
  startDeputy();
  const as = tools(attributionFor(GHOST));
  expect(await refusalCode(as.bridge_directive({ clientRequestId: "b-1", rootTurnId: "turn_1", utterance: 0, instruction: "start a reviewer" }))).toBe("directive_self_relay");
  expect(posted).toEqual([]);
});
