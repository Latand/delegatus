import { afterAll, expect, mock, test } from "bun:test";

import * as actualFiles from "@/hooks/useFiles";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * Audit B8/B9: a lane write that predicts its record draws it before the
 * request, the echo confirms it, and a refusal or a lost answer takes it back.
 * The client cache is observed through its two entry points.
 */

const actual = { ...actualFiles };
const drawn: string[] = [];
mock.module("@/hooks/useFiles", () => ({
  ...actual,
  applyPipelineSnapshot: (pipeline: Pipeline, confirmed: boolean) => drawn.push(`${confirmed ? "echo" : "predict"}:${pipeline.state}`),
  revertPipelineSnapshot: (id: string) => drawn.push(`revert:${id}`),
}));
afterAll(() => { mock.module("@/hooks/useFiles", () => actual); });
Object.assign(globalThis, { window: Object.assign(new EventTarget(), { dispatchEvent: () => true }) });

const { browserPipelinePorts, predictedPauseResume } = await import("./pipelinePorts");
const { toggleFinishesTask, withFinishesTask } = await import("@/components/pipelines/finishesTask");
const { translate } = await import("@/lib/i18n");

const lane = (over: Partial<Pipeline> = {}): Pipeline => ({ id: "p-1", state: "running", pausedState: null, taskIds: ["t-1"], ...over }) as unknown as Pipeline;

function holdFetch() {
  const held: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve, reject) => { held.push({ resolve, reject }); })) as unknown as typeof fetch;
  return held;
}

test("pause and resume predict the record the engine writes; other actions predict nothing", () => {
  const paused = predictedPauseResume(lane({ state: "needs_review" }), "pause", "2026-10-16T10:00:00.000Z")!;
  expect([paused.state, paused.pausedState, paused.pausedAt]).toEqual(["paused", "needs_review", "2026-10-16T10:00:00.000Z"]);
  const resumed = predictedPauseResume(paused, "resume", "2026-10-16T10:01:00.000Z")!;
  expect([resumed.state, resumed.pausedState, resumed.resumedAt]).toEqual(["needs_review", null, "2026-10-16T10:01:00.000Z"]);
  expect(predictedPauseResume(lane(), "resume")).toBeNull();
  expect(predictedPauseResume(lane({ state: "draft" }), "pause")).toBeNull();
  expect(predictedPauseResume(lane(), "retry-stage")).toBeNull();
  expect(withFinishesTask(lane(), "t-1", true).finishesTaskIds).toEqual(["t-1"]);
  expect(withFinishesTask(lane({ finishesTaskIds: ["t-1"] }), "t-1", false).finishesTaskIds).toEqual([]);
});

test("a predicted pause is drawn before the request and confirmed by its echo", async () => {
  drawn.length = 0;
  const held = holdFetch();
  const answer = browserPipelinePorts.patch("p-1", { action: "pause" }, predictedPauseResume(lane(), "pause")!);
  expect(drawn).toEqual(["predict:paused"]);
  held[0]!.resolve(new Response(JSON.stringify({ pipeline: lane({ state: "paused", pausedState: "running" }) }), { status: 200 }));
  expect((await answer).ok).toBe(true);
  expect(drawn).toEqual(["predict:paused", "echo:paused"]);
});

test("a refused or unanswered prediction is taken back", async () => {
  drawn.length = 0;
  let held = holdFetch();
  const refused = browserPipelinePorts.patch("p-1", { action: "pause" }, predictedPauseResume(lane(), "pause")!);
  held[0]!.resolve(new Response(JSON.stringify({ error: "store busy", code: "store_busy" }), { status: 503 }));
  expect(await refused).toMatchObject({ ok: false, status: 503, error: "store busy" });
  expect(drawn).toEqual(["predict:paused", "revert:p-1"]);
  drawn.length = 0;
  held = holdFetch();
  const lost = browserPipelinePorts.patch("p-1", { action: "link-task", taskId: "t-1", finishes: true }, withFinishesTask(lane(), "t-1", true));
  held[0]!.reject(new Error("network down"));
  expect(await lost).toMatchObject({ ok: false, unknown: true });
  expect(drawn).toEqual(["predict:running", "revert:p-1"]);
});

test("the finishes-the-task check says it at once, hands the port the flipped record, and a refusal says why", async () => {
  const t = ((key: string, values?: Record<string, string | number>) => translate("en", key as never, values)) as never;
  const shown: Array<[string, boolean]> = [];
  const sent: Array<{ body: unknown; predicted: Pipeline | undefined }> = [];
  let release: (ok: boolean) => void = () => {};
  const ports = {
    read: async () => null,
    refresh: () => {},
    patch: (_id: string, body: unknown, predicted?: Pipeline) => {
      sent.push({ body, predicted });
      return new Promise((resolve) => { release = (ok) => resolve(ok ? { ok: true, pipeline: predicted! } : { ok: false, status: 500, error: "store busy" }); });
    },
  };
  const done = toggleFinishesTask(ports as never, lane(), "t-1", "Ship it", t, (text, error) => shown.push([text, Boolean(error)]));
  /* Said and predicted before the write answers; one write. */
  expect(shown).toEqual([[translate("en", "pipelineBlock.finish.set", { title: "Ship it" }), false]]);
  expect(sent.map((entry) => [entry.body, entry.predicted?.finishesTaskIds])).toEqual([[{ action: "link-task", taskId: "t-1", finishes: true }, ["t-1"]]]);
  release(false);
  await done;
  expect(shown.at(-1)).toEqual([translate("en", "pipelineBlock.finish.failed", { title: "Ship it", error: "store busy" }), true]);
  expect(sent).toHaveLength(1);
});
