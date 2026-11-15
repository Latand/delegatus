import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { readCloudEnvironmentBindings } from "./codexCloudEnvironments";


import { cloudEnvironmentTestContext } from "./codexCloudEnvironments.fixture";

const { fixture, restart, cleanup } = cloudEnvironmentTestContext();
afterEach(cleanup);

for (const effect of ["/v1/environment-configs", "/v1/environment-configs/asenvcfg_account-a/drafts"]) {
  test(`a held 403 refusal of ${effect} survives a peer checkpoint and recovers across restart`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    const dispatched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.backend.dependencies.fetch = async (url, init) => {
      if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
      dispatched.resolve();
      await release.promise;
      return Response.json({}, { status: 403 });
    };
    const held = f.prepare();
    try {
      await dispatched.promise;
      const before = readCloudEnvironmentBindings(f.input.project).bindings[0]!;
      expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
      expect(readCloudEnvironmentBindings(f.input.project).bindings[0]!.revision).toBeGreaterThan(before.revision);
    } finally { release.resolve(); }
    const refused = await held;
    f.backend.dependencies.fetch = original;
    const states = [];
    for (const elapsed of [2001, 4001, 900_001]) {
      f.advance(elapsed);
      states.push((await restart(f)).state);
    }
    expect(states).toEqual(["unavailable", "ready", "ready"]);
    expect(refused).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  test(`a held 403 refusal of ${effect} releases custody after cancellation and a peer checkpoint`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    const controller = new AbortController(); f.input.signal = controller.signal;
    const dispatched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.backend.dependencies.fetch = async (url, init) => {
      if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
      dispatched.resolve();
      await release.promise;
      return Response.json({}, { status: 403 });
    };
    const held = f.prepare().then(value => ({ value }), error => ({ error }));
    try {
      await dispatched.promise;
      expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
      controller.abort();
    } finally { release.resolve(); }
    expect(await held).toMatchObject({ error: { message: expect.stringContaining("access_refused") } });
    f.backend.dependencies.fetch = original; f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  test(`a late 403 refusal of ${effect} preserves a newer peer receipt across restart`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    const dispatched = Promise.withResolvers<() => Promise<Response>>(), release = Promise.withResolvers<void>();
    f.backend.dependencies.fetch = async (url, init) => {
      if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
      // Another remote writer can make a recoverable configuration/draft
      // visible while this caller is still waiting for its rejected request.
      dispatched.resolve(() => original(url, init));
      await release.promise;
      return Response.json({}, { status: 403 });
    };
    const held = f.prepare();
    let peer;
    try {
      const remoteWriter = await dispatched.promise;
      await remoteWriter();
      f.backend.dependencies.fetch = original;
      expect(await f.prepare()).toMatchObject({ state: "ready" });
      peer = readCloudEnvironmentBindings(f.input.project).bindings;
    } finally { release.resolve(); }
    expect(await held).toMatchObject({ state: "pending" });
    expect(readCloudEnvironmentBindings(f.input.project).bindings).toEqual(peer);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });

  for (const recovery of ["retry", "cooldown"] as const) {
    test(`a confirmed 403 refusal of ${effect} recovers after ${recovery} across restart`, async () => {
      const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
      let refused = 0;
      f.backend.dependencies.fetch = async (url, init) => {
        if (init.method === "POST" && new URL(url).pathname === effect) {
          refused++;
          return Response.json({ error: "access refused" }, { status: 403 });
        }
        return original(url, init);
      };
      for (const elapsed of recovery === "cooldown" ? [0, 2001, 4001] : [0]) {
        f.advance(elapsed);
        expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
        expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
      }
      expect(refused).toBe(recovery === "cooldown" ? 3 : 1);
      f.backend.dependencies.fetch = original;
      if (recovery === "cooldown") {
        f.advance(10_000);
        expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
      }
      f.advance(recovery === "cooldown" ? 900_001 : 2001);
      expect(await restart(f)).toMatchObject({ state: "ready", environmentId: "asenvcfg_account-a" });
      expect(await restart(f)).toMatchObject({ state: "ready" });
      expect(f.backend.configs.size).toBe(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
    });
  }

  for (const responseKind of ["empty", "invalid", "broken", "authentication"] as const) {
    test(`a ${responseKind} rejection response from ${effect} still permits recovery across restart`, async () => {
      const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
      f.backend.dependencies.fetch = async (url, init) => {
        if (init.method !== "POST" || new URL(url).pathname !== effect) return original(url, init);
        if (responseKind === "empty") return new Response(null, { status: 403 });
        if (responseKind === "invalid") return new Response("invalid fixture JSON", { status: 403 });
        if (responseKind === "broken") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture body failure")); } }), { status: 403 });
        return Response.json({}, { status: 401 });
      };
      expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining(responseKind === "authentication" ? "authentication_expired" : "access_refused") });
      f.advance(2001);
      expect(await restart(f)).toMatchObject({ state: "ready" });
      expect(f.backend.configs.size).toBe(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
      expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
    });
  }

  for (const reply of ["transport", "server", "invalid"] as const) test(`a ${reply} failure from ${effect} retains custody after a later 403 read and cooldown across restart`, async () => {
    const f = fixture({ create: true }), original = f.backend.dependencies.fetch;
    f.backend.dependencies.fetch = async (url, init) => {
      const response = await original(url, init);
      if (init.method === "POST" && new URL(url).pathname === effect) {
        if (reply === "transport") throw new Error("fixture lost reply");
        if (reply === "server") return Response.json({}, { status: 500 });
        return new Response("invalid fixture JSON");
      }
      return response;
    };
    expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
    f.backend.dependencies.fetch = async () => Response.json({}, { status: 403 });
    f.advance(2001);
    expect(await f.prepare()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("access_refused") });
    const config = f.backend.configs.get("asenvcfg_account-a")!;
    const draft = config.draft;
    if (effect.endsWith("/drafts")) delete config.draft;
    else f.backend.configs.delete("asenvcfg_account-a");
    f.backend.dependencies.fetch = original;
    for (const elapsed of [4001, 900_001]) {
      f.advance(elapsed);
      expect(await restart(f)).toMatchObject({ state: "unavailable", reason: expect.stringContaining("setup_uncertain") });
    }
    if (effect.endsWith("/drafts")) config.draft = draft;
    else f.backend.configs.set("asenvcfg_account-a", config);
    f.advance(2001);
    expect(await restart(f)).toMatchObject({ state: "ready" });
    expect(f.backend.configs.size).toBe(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path === "/v1/environment-configs")).toHaveLength(1);
    expect(f.backend.calls.filter(call => call.method === "POST" && call.path.endsWith("/drafts"))).toHaveLength(1);
  });
}
