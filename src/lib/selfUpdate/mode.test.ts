import { describe, expect, test } from "bun:test";

import type { RuntimeHostClient } from "@/lib/runtime/client";

import type { LauncherRecord } from "./launcher";
import { deploymentsEnabled, detectMode, LAUNCHER_RECORD_ENV, type ModePorts } from "./mode";

/* #2007: the install mode is what the install says, never a guess. */

function record(checkout: string | null): LauncherRecord {
  const process = { state: "healthy" as const, pid: 10, startIdentity: "1", startedAt: null, revision: "a1b2c3d", error: null, requestId: null };
  return {
    version: 1,
    launcher: { pid: 9, startIdentity: "1" },
    checkout,
    releasesDir: "/c/releases",
    releasePointer: "/s/release.json",
    requestFile: "/s/request.json",
    port: 45123,
    socket: "/s/runtime-host.sock",
    web: process,
    runtimeHost: process,
    updatedAt: "",
  };
}

function ports(overrides: Partial<ModePorts>): ModePorts {
  return {
    env: {},
    readRecord: () => null,
    alive: () => true,
    deploymentsEnabled: async () => false,
    ...overrides,
  };
}

describe("detectMode", () => {
  test("a live launcher record naming a checkout is a checkout install", async () => {
    const decision = await detectMode(ports({ env: { [LAUNCHER_RECORD_ENV]: "/s/launcher.json" }, readRecord: () => record("/srv/viewer-checkout") }));
    expect(decision.mode).toBe("checkout");
    expect(decision.record?.checkout).toBe("/srv/viewer-checkout");
  });

  test("a live launcher record without a checkout is a packaged install", async () => {
    const decision = await detectMode(ports({ env: { [LAUNCHER_RECORD_ENV]: "/s/launcher.json" }, readRecord: () => record(null) }));
    expect(decision).toMatchObject({ mode: "unsupported", reason: "not-a-checkout" });
  });

  test("a record left by a launcher that is gone is ignored, and the runtime host decides", async () => {
    const decision = await detectMode(ports({
      env: { [LAUNCHER_RECORD_ENV]: "/s/launcher.json" },
      readRecord: () => record("/srv/viewer-checkout"),
      alive: () => false,
      deploymentsEnabled: async () => true,
    }));
    expect(decision).toMatchObject({ mode: "managed", reason: null });
  });

  test("a runtime host running Viewer deployments is the managed install", async () => {
    expect((await detectMode(ports({ deploymentsEnabled: async () => true }))).mode).toBe("managed");
  });

  test("neither a launcher nor deployments: unsupported, saying which", async () => {
    expect(await detectMode(ports({ deploymentsEnabled: async () => false }))).toMatchObject({ mode: "unsupported", reason: "no-launcher" });
    expect(await detectMode(ports({ deploymentsEnabled: async () => null }))).toMatchObject({ mode: "unsupported", reason: "no-runtime-host" });
  });
});

describe("deploymentsEnabled asks the host for a deployment that cannot exist", () => {
  const client = (read: RuntimeHostClient["readViewerDeployment"]) => ({ readViewerDeployment: read }) as unknown as RuntimeHostClient;

  test("not found means the host runs deployments", async () => {
    const asked: string[] = [];
    expect(await deploymentsEnabled(client(async (id) => { asked.push(id); return null; }))).toBe(true);
    expect(asked).toEqual(["self-update-mode-probe"]);
  });

  test("the host's refusal means it runs none", async () => {
    expect(await deploymentsEnabled(client(async () => { throw new Error("viewer deployments are disabled"); }))).toBe(false);
  });

  test("no answer, or no socket at all, is unknown", async () => {
    expect(await deploymentsEnabled(client(async () => { throw new Error("connect ENOENT /s/runtime-host.sock"); }))).toBeNull();
    expect(await deploymentsEnabled(null)).toBeNull();
  });
});
