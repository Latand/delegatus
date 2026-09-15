import { expect, test } from "bun:test";

import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { ConversationMigration } from "@/lib/types";

import {
  accountStanding,
  ConversationSwitches,
  parseProjectPolicy,
  postConversationSwitch,
  StageAccounts,
  stageAccountKey,
  stagePin,
  switchView,
  type SwitchRequest,
} from "./accountChoice";
import type { PipelinePorts, PipelineWriteResult } from "./pipelinePorts";

/* Account choice on the kanban board (#1695 K6): what a waiting stage's
   account write sends and settles on, and what the board may say about a
   conversation's switch. Invented records; the routes answer from stubs. */

const role = { roleId: "cleaner", engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null };
function pipeline(over: { account?: string | null; started?: boolean; state?: string } = {}): Pipeline {
  return {
    id: "p-search", project: "fixture", state: over.state ?? "running",
    stages: [{ id: "merge", kind: "run", role: { roleId: "cleaner" }, prompt: "{{prev.output}}\n\nMerge.", next: null, onFail: null, effectiveRole: role, ...(over.account !== undefined ? { account: over.account } : {}) }],
    runs: over.started ? [{ stageId: "merge", attempts: [{ n: 1, state: "running" }] }] : [],
    cursor: null,
  } as unknown as Pipeline;
}

function ports(records: Array<Pipeline | null>, answers: PipelineWriteResult[] = [], digests = true) {
  const patches: PatchPipelineRequest[] = [];
  let reads = 0;
  let refreshes = 0;
  const port: PipelinePorts = {
    read: async () => {
      const record = records[Math.min(reads, records.length - 1)] ?? null;
      reads += 1;
      const stageDigests: Record<string, string> = digests ? { merge: `digest-${reads}` } : {};
      return record ? { pipeline: record, stageDigests } : null;
    },
    patch: async (_id, body) => {
      patches.push(body);
      return answers.shift() ?? { ok: true, pipeline: records.at(-1)! };
    },
    refresh: () => { refreshes += 1; },
  };
  return { port, patches, reads: () => reads, refreshes: () => refreshes };
}

const KEY = stageAccountKey("p-search", "merge");

test("a stage's pin is its trimmed account; absent, null and blank are the project's choice", () => {
  expect(stagePin({ account: " account-c " })).toBe("account-c");
  expect(stagePin({ account: null })).toBeNull();
  expect(stagePin({ account: "  " })).toBeNull();
  expect(stagePin({})).toBeNull();
});

test("choosing an account writes that account alone, guarded by the digest of the read it came from", async () => {
  const stages = new StageAccounts();
  const route = ports([pipeline()]);
  const outcome = await stages.choose("p-search", "merge", "account-c", route.port);
  expect(outcome).toEqual({ kind: "saved", account: "account-c" });
  expect(route.patches).toEqual([{ action: "override-stage", stageId: "merge", account: "account-c", expectedStageDigest: "digest-1" }]);
  expect(stages.get(KEY)).toBeNull();
});

test("the project's choice clears the pin with null", async () => {
  const stages = new StageAccounts();
  const route = ports([pipeline({ account: "account-c" })]);
  expect(await stages.choose("p-search", "merge", null, route.port)).toEqual({ kind: "saved", account: null });
  expect(route.patches).toEqual([{ action: "override-stage", stageId: "merge", account: null, expectedStageDigest: "digest-1" }]);
});

test("nothing is written for a stage that already runs on the choice, has started, is gone, or whose digest the read lacks", async () => {
  const same = ports([pipeline({ account: "account-c" })]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", same.port)).toEqual({ kind: "same", account: "account-c" });
  const started = ports([pipeline({ started: true })]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", started.port)).toEqual({ kind: "started" });
  const ended = ports([pipeline({ state: "closed" })]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", ended.port)).toEqual({ kind: "started" });
  const unread = ports([null]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", unread.port)).toEqual({ kind: "unread" });
  const undigested = ports([pipeline()], [], false);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", undigested.port)).toEqual({ kind: "unread" });
  const gone = ports([{ ...pipeline(), stages: [] } as unknown as Pipeline]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", gone.port)).toEqual({ kind: "missing" });
  expect([same, started, ended, unread, undigested, gone].flatMap((route) => route.patches)).toEqual([]);
});

test("a stage another client changed after the read is refused by the engine; the choice says what the stage holds now and is not resent", async () => {
  const stages = new StageAccounts();
  const route = ports([pipeline(), pipeline({ account: "account-e" })], [{ ok: false, status: 409, error: "the stage changed", code: "STAGE_CHANGED", field: "expectedStageDigest" }]);
  expect(await stages.choose("p-search", "merge", "account-c", route.port)).toEqual({ kind: "changed", account: "account-e" });
  expect(route.patches).toHaveLength(1);
  expect(route.reads()).toBe(2);

  const already = ports([pipeline(), pipeline({ account: "account-c" })], [{ ok: false, status: 409, error: "the stage changed", code: "STAGE_CHANGED", field: "expectedStageDigest" }]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", already.port)).toEqual({ kind: "saved", account: "account-c" });

  const startedBetween = ports([pipeline(), pipeline({ started: true })], [{ ok: false, status: 409, error: "stage has already started" }]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-c", startedBetween.port)).toEqual({ kind: "started" });
});

test("the binding's refusal keeps the server's words", async () => {
  const route = ports([pipeline()], [{ ok: false, status: 409, error: "claude account account-g is not allowed on project fixture (allowed: default, account-c)" }]);
  expect(await new StageAccounts().choose("p-search", "merge", "account-g", route.port)).toEqual({ kind: "refused", error: "claude account account-g is not allowed on project fixture (allowed: default, account-c)" });
});

test("a write with no answer stays unconfirmed; Check again settles only on what the stage holds", async () => {
  const stages = new StageAccounts();
  const lost: PipelineWriteResult = { ok: false, status: 0, error: "Failed to fetch", unknown: true };
  const route = ports([pipeline(), pipeline(), pipeline({ account: "account-c" })], [lost]);
  expect(await stages.choose("p-search", "merge", "account-c", route.port)).toEqual({ kind: "unknown", account: "account-c" });
  expect(stages.get(KEY)).toEqual({ pipelineId: "p-search", stageId: "merge", account: "account-c", phase: "unconfirmed" });
  /* The stage does not hold it yet: that proves nothing either way. */
  expect(await stages.check(KEY, route.port)).toEqual({ kind: "unknown", account: "account-c" });
  expect(stages.get(KEY)?.phase).toBe("unconfirmed");
  expect(await stages.check(KEY, route.port)).toEqual({ kind: "saved", account: "account-c" });
  expect(stages.get(KEY)).toBeNull();
  expect(route.patches).toHaveLength(1);

  const startedRoute = ports([pipeline(), pipeline({ started: true })], [lost]);
  const other = new StageAccounts();
  await other.choose("p-search", "merge", "account-c", startedRoute.port);
  /* An override is refused once the stage has an attempt: a start without the pin never took it. */
  expect(await other.check(KEY, startedRoute.port)).toEqual({ kind: "started" });
});

test("a choice still saving is not sent twice", async () => {
  const stages = new StageAccounts();
  let release = () => {};
  const route = ports([pipeline()]);
  const held: PipelinePorts = { ...route.port, read: async (id) => { await new Promise<void>((resolve) => { release = resolve; }); return route.port.read(id); } };
  const first = stages.choose("p-search", "merge", "account-c", held);
  expect(await stages.choose("p-search", "merge", "account-e", held)).toBeNull();
  release();
  expect(await first).toEqual({ kind: "saved", account: "account-c" });
  expect(route.patches).toHaveLength(1);
});

test("the project's accounts: a bound engine allows its accounts, an unbound one every account, an unread record decides nothing", () => {
  const policy = parseProjectPolicy({ engines: { claude: { restricted: true, allowed: [{ accountId: "default" }, { accountId: "account-c" }] }, codex: { restricted: false, allowed: [] } } });
  expect(accountStanding(policy, "claude", "account-c")).toBe("inside");
  expect(accountStanding(policy, "claude", "account-g")).toBe("outside");
  expect(accountStanding(policy, "codex", "anything")).toBe("inside");
  expect(accountStanding(parseProjectPolicy({ error: "unreadable" }), "claude", "account-g")).toBe("unknown");
  expect(accountStanding({ state: "loading" }, "claude", "account-g")).toBe("unknown");
});

test("a switch request's answer: accepted with its operation and any outside-pool record, refused with the server's words, or unknown", async () => {
  const answer = (status: number, body: unknown) => async () => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const body = { path: "/fixture/verify-2.jsonl", conversationId: "conversation_verify-2", accountId: "account-g", model: "opus", effort: "high" };
  const sent: unknown[] = [];
  const accepted = await postConversationSwitch(body, async (input, init) => {
    sent.push([input, JSON.parse(String(init.body))]);
    return answer(202, { ok: true, operationId: "op-1", receipt: { operationId: "op-1", status: "queued" }, accountOverride: { outsidePool: true, recorded: true } })();
  });
  expect(sent).toEqual([["/api/conversation-host", { action: "reconfigure", ...body }]]);
  expect(accepted).toEqual({ kind: "accepted", operationId: "op-1", status: "queued", outsidePool: true, recorded: true });
  expect(await postConversationSwitch(body, answer(400, { error: "account is not available for claude" }))).toEqual({ kind: "refused", error: "account is not available for claude" });
  expect(await postConversationSwitch(body, async () => { throw new TypeError("Failed to fetch"); })).toEqual({ kind: "unknown" });
  expect(await postConversationSwitch(body, answer(502, undefined))).toEqual({ kind: "unknown" });
  expect(await postConversationSwitch(body, answer(200, { structured: true }))).toEqual({ kind: "unknown" });
});

const request = (over: Partial<SwitchRequest> = {}): SwitchRequest => ({ target: "account-g", phase: "accepted", operationId: "op-1", answeredStatus: "queued", ...over });
const migration = (phase: string, over: Partial<ConversationMigration> = {}): ConversationMigration => ({ intentId: "intent-1", trigger: "manual", phase, targetAccountId: "account-g", failure: null, revision: 3, ...over });

test("a switch this page asked for waits for the turn by its receipt, says switching once applying, and is done only when the conversation runs on the target", () => {
  expect(switchView({ current: "default", migration: null, request: request({ phase: "sending", operationId: null, answeredStatus: null }), receipt: null }).view).toEqual({ kind: "sending", target: "account-g" });
  expect(switchView({ current: "default", migration: null, request: request(), receipt: null })).toEqual({ view: { kind: "waiting", target: "account-g", source: "page" }, settle: null });
  expect(switchView({ current: "default", migration: null, request: request(), receipt: { status: "applying" } }).view).toEqual({ kind: "switching", target: "account-g", source: "page" });
  /* Applied is not yet the account the conversation runs on: no success is claimed. */
  expect(switchView({ current: "default", migration: null, request: request(), receipt: { status: "applied" } })).toEqual({ view: { kind: "switching", target: "account-g", source: "page" }, settle: null });
  expect(switchView({ current: "account-g", migration: null, request: request(), receipt: { status: "applied" } })).toEqual({ view: { kind: "none" }, settle: { kind: "switched", target: "account-g" } });
  expect(switchView({ current: "default", migration: null, request: request(), receipt: { status: "failed", reason: "account requires authentication" } })).toEqual({ view: { kind: "none" }, settle: { kind: "failed", target: "account-g", reason: "account requires authentication" } });
  expect(switchView({ current: "default", migration: null, request: request(), receipt: { status: "uncertain" } }).view).toEqual({ kind: "unknown", target: "account-g" });
  expect(switchView({ current: "default", migration: null, request: request({ phase: "unknown" }), receipt: null })).toEqual({ view: { kind: "unknown", target: "account-g" }, settle: null });
});

test("the migration record speaks for every page: waiting for the turn, switching, or failed with its reason", () => {
  expect(switchView({ current: "default", migration: migration("waiting-turn"), request: null, receipt: null }).view).toEqual({ kind: "waiting", target: "account-g", source: "record" });
  for (const phase of ["requested", "preparing", "successor-starting", "verifying"]) {
    expect(switchView({ current: "default", migration: migration(phase), request: null, receipt: null }).view).toEqual({ kind: "switching", target: "account-g", source: "record" });
  }
  expect(switchView({ current: "default", migration: migration("failed-recoverable", { failure: "successor did not start" }), request: request(), receipt: null })).toEqual({
    view: { kind: "failed", target: "account-g", reason: "successor did not start" },
    settle: { kind: "failed", target: "account-g", reason: "successor did not start" },
  });
  /* A hold on the account the conversation already runs on is a finished switch's leftover. */
  expect(switchView({ current: "account-g", migration: migration("waiting-turn"), request: null, receipt: null }).view).toEqual({ kind: "none" });
  expect(switchView({ current: "default", migration: migration("rolled-back"), request: null, receipt: null }).view).toEqual({ kind: "none" });
});

test("a structured switch queued behind a turn is reported for every page by the runtime session's pending reconfigure, ahead of this page's own request", () => {
  const queued = (over: Partial<{ operationId: string; accountId: string | null; status: string | null }> = {}) => ({ operationId: "op-1", accountId: "account-g", status: "queued", ...over });
  expect(switchView({ current: "default", migration: null, request: null, receipt: null, pending: queued() })).toEqual({ view: { kind: "waiting", target: "account-g", source: "runtime" }, settle: null });
  expect(switchView({ current: "default", migration: null, request: null, receipt: null, pending: queued({ status: "applying" }) }).view).toEqual({ kind: "switching", target: "account-g", source: "runtime" });
  /* A reconfigure that keeps the account, or names the one it runs on, is no switch. */
  expect(switchView({ current: "default", migration: null, request: null, receipt: null, pending: queued({ accountId: null }) }).view).toEqual({ kind: "none" });
  expect(switchView({ current: "account-g", migration: null, request: null, receipt: null, pending: queued() }).view).toEqual({ kind: "none" });
  /* This page's own request is no longer the only witness. */
  expect(switchView({ current: "default", migration: null, request: request(), receipt: { status: "queued" }, pending: queued() }).view).toEqual({ kind: "waiting", target: "account-g", source: "runtime" });
  expect(switchView({ current: "default", migration: null, request: request({ phase: "unknown", operationId: null }), receipt: null, pending: queued() })).toEqual({ view: { kind: "waiting", target: "account-g", source: "runtime" }, settle: null });
  /* Another client's newer switch superseded this page's: the page's request settles failed, the newer one shows. */
  expect(switchView({ current: "default", migration: null, request: request({ target: "account-c" }), receipt: { status: "failed", reason: "superseded" }, pending: queued({ operationId: "op-2" }) })).toEqual({
    view: { kind: "waiting", target: "account-g", source: "runtime" },
    settle: { kind: "failed", target: "account-c", reason: "superseded" },
  });
  /* Once the migration record exists, it speaks. */
  expect(switchView({ current: "default", migration: migration("preparing"), request: null, receipt: null, pending: queued() }).view).toEqual({ kind: "switching", target: "account-g", source: "record" });
});

test("one request per conversation at a time", () => {
  const switches = new ConversationSwitches();
  expect(switches.begin("conversation_verify-2", "account-g")).toBe(true);
  expect(switches.begin("conversation_verify-2", "account-c")).toBe(false);
  switches.accept("conversation_verify-2", "op-1", "queued");
  expect(switches.get("conversation_verify-2")).toEqual(request());
  switches.lost("conversation_verify-2");
  expect(switches.get("conversation_verify-2")?.phase).toBe("unknown");
  switches.drop("conversation_verify-2");
  expect(switches.get("conversation_verify-2")).toBeNull();
});
