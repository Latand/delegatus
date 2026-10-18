import { expect, test } from "bun:test";

import { registerPipelineTick, requestPipelineTick, requestRemotePipelineTick } from "./controllerSignal";
import { controllerPipelineKeys, withControllerPipelineScope } from "./controllerScope";

test("both the initial signal and a retained wake clear lane scope across awaits", async () => {
  let entered!: () => void, release!: () => void, finished!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  const observed: Array<readonly string[] | undefined> = [];
  let calls = 0;
  const unregister = registerPipelineTick(async () => {
    observed.push(controllerPipelineKeys());
    if (++calls === 1) { entered(); await held; }
    else { await Promise.resolve(); finished(); }
    observed.push(controllerPipelineKeys());
  });
  try {
    await withControllerPipelineScope(["first-lane"], async () => {
      requestPipelineTick();
      await started;
      await withControllerPipelineScope(["second-lane"], async () => { requestPipelineTick(); });
      release();
      await done;
      expect(controllerPipelineKeys()).toEqual(["first-lane"]);
      expect(calls).toBe(2);
      expect(observed).toEqual([undefined, undefined, undefined, undefined]);
    });
  } finally { release(); for (let i = 0; i < 20; i++) await Promise.resolve(); unregister(); }
});

test("pipeline controller signals coalesce concurrent requests", async () => {
  let calls = 0;
  const unregister = registerPipelineTick(async () => { calls += 1; });

  requestPipelineTick();
  requestPipelineTick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(calls).toBe(1);
  unregister();
});

test("the standalone controller signal targets the live Viewer process", async () => {
  const requests: Array<{ url: string; method: string | undefined; credential: string | null }> = [];
  await requestRemotePipelineTick(async (input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
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


test("signals retain one observer through settlement and preserve one trailing wake", async () => {
  let calls = 0;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const unregister = registerPipelineTick(() => { calls++; return calls === 1 ? held : Promise.resolve(); });
  try {
    requestPipelineTick();
    for (let i = 0; i < 953; i++) { await Promise.resolve(); requestPipelineTick(); }
    expect(calls).toBe(1);
    finish();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls).toBe(2);
  } finally { finish(); for (let i = 0; i < 20; i++) await Promise.resolve(); unregister(); }
});
