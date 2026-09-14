import { expect, test } from "bun:test";

import { registerPipelineTick, requestPipelineTick, requestRemotePipelineTick } from "./controllerSignal";

test("pipeline controller signals coalesce concurrent requests", async () => {
  let calls = 0;
  const unregister = registerPipelineTick(async () => { calls += 1; });

  requestPipelineTick();
  requestPipelineTick();
  await Promise.resolve();
  await Promise.resolve();

  expect(calls).toBe(1);
  unregister();
});

test("the standalone controller signal targets the live Viewer process", async () => {
  const requests: Array<{ url: string; method: string | undefined; credential: string | null }> = [];
  await requestRemotePipelineTick(async (input, init) => {
    requests.push({ url: String(input), method: init?.method, credential: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  }, { LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:19000" });

  /* A pinned endpoint without the release contract carries no ambient credential. */
  expect(requests).toEqual([{
    url: "http://127.0.0.1:19000/api/pipelines/tick",
    method: "POST",
    credential: null,
  }]);
});

test("issue 1685: without a pinned endpoint the tick follows the release port, never a fixed one", async () => {
  const requests: string[] = [];
  await requestRemotePipelineTick(async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  }, { HOME: "/nonexistent-llv-home", XDG_CONFIG_HOME: "/nonexistent-llv-home/.config", LLV_VIEWER_PORT: "18899" });
  expect(requests).toEqual(["http://127.0.0.1:18899/api/pipelines/tick"]);
});
