import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* State is sandboxed before anything that reads it loads: the team store, the
   operator spawn key behind a service claim, and the pipeline registry the real
   route module reaches. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-lane-review-route-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { NextRequest } = await import("next/server");
const { laneChangesGET, laneReviewMessageKey, laneReviewPOST } = await import("@/lib/laneReview/http");
const { composeLaneReviewMessage } = await import("@/lib/laneReview/message");
const { createLaneRepo, LANE_BRANCH } = await import("@/lib/laneReview/gitFixture");
const { realExec } = await import("@/lib/workflows/provision");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/spawnPolicy");
const { claimInstall } = await import("@/lib/team/members");
const { MEMBER_COOKIE } = await import("@/lib/team/sessions");
const { resetTeamStoreForTests, teamStore } = await import("@/lib/team/store");

import type { LaneRepo } from "@/lib/laneReview/gitFixture";
import type { LaneReviewDelivery, PersonActor } from "@/lib/laneReview/http";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

const WRITER = "conversation-writer";
/* Assembled, so no credential-shaped line sits in this file. */
const KEYWORD = ["pass", "word"].join("");
const SECRET = ["fixture", "value", "4242"].join("-");

let lane: LaneRepo;
let pipeline: Pipeline;
let calls: Array<{ delivery: LaneReviewDelivery; actor: PersonActor }>;

const deps = () => ({
  pipeline: (id: string) => (id === pipeline.id ? pipeline : null),
  exec: realExec,
  deliver: async (delivery: LaneReviewDelivery, actor: PersonActor) => {
    calls.push({ delivery, actor });
    return Response.json({ ok: true, operationId: `op-${calls.length}`, receipt: { status: "queued" }, outcome: "queued" });
  },
});

const writer = (n: number, conversationId: string, startedAt: string): PipelineStageAttempt => ({
  n, startedAt, conversationId, effectiveRole: { access: "read-write", engine: "claude" },
}) as PipelineStageAttempt;

beforeEach(() => {
  lane = createLaneRepo(SANDBOX);
  lane.git("checkout", "-q", LANE_BRANCH);
  lane.write("src/config.ts", `const ${KEYWORD} = "${SECRET}";\n`);
  lane.commit("config");
  lane.git("checkout", "-q", "--detach");
  pipeline = lane.pipeline({ runs: [{ stageId: "build", attempts: [writer(1, WRITER, "2026-10-23T08:00:00.000Z")] }] });
  calls = [];
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  resetTeamStoreForTests();
  fs.rmSync(path.join(SANDBOX, "state", "team"), { recursive: true, force: true });
  lane.cleanup();
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

const SAME_ORIGIN = { host: "localhost", "sec-fetch-site": "same-origin" };

function request(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(url, "http://localhost"), {
    method: init.method ?? "GET",
    headers: { ...SAME_ORIGIN, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function summary(headers: Record<string, string> = {}) {
  const response = await laneChangesGET(request(`/api/pipelines/${pipeline.id}/changes`, { headers }), pipeline.id, deps());
  expect(response.status).toBe(200);
  return (await response.json()) as { summary: { base: string; head: string; files: { path: string }[] }; target: { conversationId: string } };
}

const reviewBody = (pair: { base: string; head: string }, overrides: Record<string, unknown> = {}) => ({
  draftId: "draft-1",
  base: pair.base,
  head: pair.head,
  conversationId: WRITER,
  locale: "en",
  note: "One overall point.",
  comments: [
    { path: "src/app.ts", side: "new", line: 5, quote: "line five", body: "Name it as before." },
    { path: "src/gone.ts", side: "old", line: null, quote: "", body: "Why delete this?" },
  ],
  ...overrides,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  laneReviewPOST(request(`/api/pipelines/${pipeline.id}/review`, { method: "POST", body, headers }), pipeline.id, deps());

describe("authority: only a person sends", () => {
  test("the operator sends once, with the composed text and the derived key; a repeat derives the same key", async () => {
    const { summary: pair } = await summary();
    const response = await post(reviewBody(pair));
    expect(response.status).toBe(200);
    const answer = await response.json();
    const key = laneReviewMessageKey(pipeline.id, "draft-1", pair.head);
    expect(answer).toMatchObject({ ok: true, operationId: "op-1", conversationId: WRITER, clientMessageId: key, target: { stageId: "build" } });
    expect(calls.length).toBe(1);
    expect(calls[0]!.actor).toEqual({ kind: "operator" });
    expect(calls[0]!.delivery).toEqual({
      conversationId: WRITER,
      clientMessageId: key,
      text: composeLaneReviewMessage({
        locale: "en", base: pair.base, head: pair.head, branch: LANE_BRANCH, note: "One overall point.",
        comments: reviewBody(pair).comments as never, pathOrder: pair.files.map((file) => file.path),
      }),
    });
    expect(calls[0]!.delivery.text).toContain(`Base ${pair.base} · head ${pair.head}`);
    expect(key).toMatch(/^lane-review:[0-9a-f]{64}$/);

    await post(reviewBody(pair));
    expect(calls[1]!.delivery.clientMessageId).toBe(key);
    await post(reviewBody(pair, { draftId: "draft-2" }));
    expect(calls[2]!.delivery.clientMessageId).not.toBe(key);
  });

  test("an active member of a team sends as that member", async () => {
    const owner = claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
    const cookie = { cookie: `${MEMBER_COOKIE}=${owner.cookie}` };
    const { summary: pair } = await summary(cookie);
    expect((await post(reviewBody(pair), cookie)).status).toBe(200);
    expect(calls.map((call) => call.actor)).toEqual([{ kind: "member", memberId: owner.member.id }]);
  });

  test("an agent's conversation capability, a service claim, a cross-origin page and a signed-out team caller are refused and deliver nothing", async () => {
    const { summary: pair } = await summary();
    setCallerConversationResolverForTests(() => "conversation-agent");
    const agent = { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) };
    const refusals: Array<[string, Response, number]> = [
      ["agent", await post(reviewBody(pair), agent), 403],
      ["agent read", await laneChangesGET(request(`/api/pipelines/${pipeline.id}/changes`, { headers: agent }), pipeline.id, deps()), 403],
    ];
    setCallerConversationResolverForTests(null);
    refusals.push(["service", await post(reviewBody(pair), internalServiceHeaders("monitor")), 403]);
    refusals.push(["cross-origin", await post(reviewBody(pair), { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" }), 403]);
    claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
    refusals.push(["anonymous", await post(reviewBody(pair)), 403]);
    for (const [who, response, status] of refusals) {
      expect(`${who} ${response.status}`).toBe(`${who} ${status}`);
      if (who !== "cross-origin") expect((await response.json()).code).toBe("operator_only");
    }
    expect(calls.length).toBe(0);
  });

  test("the real route refuses an agent before it reads anything", async () => {
    const { POST } = await import("./route");
    setCallerConversationResolverForTests(() => "conversation-agent");
    const response = await POST(request("/api/pipelines/absent/review", { method: "POST", body: {}, headers: { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) } }), { params: Promise.resolve({ id: "absent" }) });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("operator_only");
  });
});

describe("stale head", () => {
  test("a commit on the lane after the read is refused with the new head, and nothing is delivered", async () => {
    const { summary: pair } = await summary();
    lane.git("checkout", "-q", LANE_BRANCH);
    lane.write("src/app.ts", fs.readFileSync(path.join(lane.dir, "src/app.ts"), "utf8") + "line 31\n");
    const moved = lane.commit("more work");
    lane.git("checkout", "-q", "--detach");
    expect(moved).not.toBe(pair.head);
    const response = await post(reviewBody(pair));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "head_moved", head: moved, base: pair.base });
    expect(calls.length).toBe(0);
  });

  test("a branch deleted after the read falls back to the last passed commit, which differs", async () => {
    const { summary: pair } = await summary();
    lane.git("branch", "-D", LANE_BRANCH);
    pipeline = { ...pipeline, lastPassedCommit: pair.base };
    const response = await post(reviewBody(pair));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "head_moved", head: pair.base });
    expect(calls.length).toBe(0);
  });
});

describe("what the message may carry", () => {
  test("a quote must be its row's redacted text; the secret never reaches the message", async () => {
    const { summary: pair } = await summary();
    const line = { path: "src/config.ts", side: "new", line: 1, body: "Read it from the environment." };
    for (const quote of [`const ${KEYWORD} = "${SECRET}";`, "something else"]) {
      const refused = await post(reviewBody(pair, { comments: [{ ...line, quote }] }));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "quote_mismatch", field: "comments[0].quote" });
    }
    expect(calls.length).toBe(0);
    const accepted = await post(reviewBody(pair, { comments: [{ ...line, quote: `const ${KEYWORD} = "[redacted]";` }] }));
    expect(accepted.status).toBe(200);
    expect(calls[0]!.delivery.text).toContain(`> const ${KEYWORD} = "[redacted]";`);
    expect(calls[0]!.delivery.text).not.toContain(SECRET);
  });

  test("a file comment's kept quote is redacted on the server", async () => {
    const { summary: pair } = await summary();
    expect((await post(reviewBody(pair, { comments: [{ path: "src/config.ts", side: "new", line: null, quote: `${KEYWORD}=${SECRET}`, body: "Moved?" }] }))).status).toBe(200);
    expect(calls[0]!.delivery.text).not.toContain(SECRET);
  });

  test("a path the pair does not change, a changed writer, an empty review and a bad shape are refused", async () => {
    const { summary: pair } = await summary();
    const cases: Array<[unknown, number, string]> = [
      [reviewBody(pair, { comments: [{ path: "README.md", side: "new", line: null, quote: "", body: "x" }] }), 400, "path_not_changed"],
      [reviewBody(pair, { comments: [{ path: "src/app.ts", side: "new", line: 999, quote: "line five", body: "x" }] }), 400, "quote_mismatch"],
      [reviewBody(pair, { conversationId: "conversation-older" }), 409, "target_changed"],
      [reviewBody(pair, { comments: [], note: "  " }), 422, "empty_review"],
      [reviewBody(pair, { head: "HEAD" }), 400, "invalid_request"],
      [reviewBody(pair, { comments: [{ path: "src/app.ts", side: "both", line: 1, quote: "", body: "x" }] }), 400, "invalid_request"],
      [reviewBody(pair, { comments: Array.from({ length: 101 }, () => ({ path: "src/app.ts", side: "new", line: null, quote: "", body: "x" })) }), 400, "invalid_request"],
    ];
    for (const [body, status, code] of cases) {
      const response = await post(body);
      expect(`${response.status} ${(await response.json()).code}`).toBe(`${status} ${code}`);
    }
    expect(calls.length).toBe(0);
    const changed = await post(reviewBody(pair, { conversationId: "conversation-older" }));
    expect((await changed.json()).target).toMatchObject({ conversationId: WRITER, stageName: "build" });
  });

  test("a lane with no writer has no target", async () => {
    pipeline = { ...pipeline, runs: [] };
    const { summary: pair, target } = await summary();
    expect(target).toBeNull();
    const response = await post(reviewBody(pair));
    expect(`${response.status} ${(await response.json()).code}`).toBe("409 no_target");
    expect(calls.length).toBe(0);
  });
});

describe("GET one file", () => {
  test("reads a listed file over the named pair and refuses anything else", async () => {
    const { summary: pair } = await summary();
    const read = (query: string) => laneChangesGET(request(`/api/pipelines/${pipeline.id}/changes?${query}`), pipeline.id, deps());
    const ok = await read(new URLSearchParams({ base: pair.base, head: pair.head, path: "src/app.ts" }).toString());
    expect(ok.status).toBe(200);
    expect((await ok.json()).file).toMatchObject({ path: "src/app.ts", op: "update", added: 2, removed: 1 });
    expect((await read(new URLSearchParams({ base: pair.base, head: pair.head, path: ":(glob)*" }).toString())).status).toBe(404);
    expect((await read(new URLSearchParams({ base: "main", head: pair.head, path: "src/app.ts" }).toString())).status).toBe(400);
    expect((await read(new URLSearchParams({ base: pair.base }).toString())).status).toBe(400);
    const listed = await read(new URLSearchParams({ base: pair.base, head: pair.head }).toString());
    expect(await listed.json()).toMatchObject({ ok: true, total: 5, truncated: false, files: pair.files });
  });
});
