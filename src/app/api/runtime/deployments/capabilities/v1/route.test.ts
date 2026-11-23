import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, setSystemTime, test } from "bun:test";

import {
  HOT_STATE_BACKEND,
  markHotStateActivationReady,
  markViewerReleaseReady,
  publishHotStateAuthority,
} from "@/lib/state/hotStateAuthority";
import {
  hasViewerDeploymentCapability,
  viewerDeploymentReleaseReady,
} from "@/runtime-host/deploymentHealth";

import {
  markStructuredDeliveryControllerReady,
  markStructuredDeliveryControllerUnavailable,
  markStructuredHostStartupFailed,
  markStructuredHostStartupReady,
} from "@/lib/runtime/startupStatus";

import * as incumbent from "@/runtime-host/fixtures/incumbentDeploymentHealth";
import { runStructuredHostStartup } from "@/lib/viewerInstrumentation";

import { GET } from "./route";

test("both verifier generations wait for serving startup while passive prechecks remain available", async () => {
  const previous = { state: process.env.LLV_STATE_DIR, port: process.env.PORT, hosts: process.env.LLV_STRUCTURED_HOSTS };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-capability-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.LLV_STRUCTURED_HOSTS = "1";
  const revision = "a".repeat(40);
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:19001", revision, hotStateBackend: HOT_STATE_BACKEND,
  }));
  const probe = async (ready: boolean, status = 200, promoted = true) => {
    const response = GET();
    const text = await response.text();
    expect(response.status).toBe(status);
    expect(JSON.parse(text)).toMatchObject(status === 200
      ? { admissionFence: true, releaseReady: ready }
      : { releaseReady: ready });
    expect(incumbent.viewerDeploymentReleaseReady(response.status, text)).toBe(ready);
    if (promoted) expect(viewerDeploymentReleaseReady(response.status, text)).toBe(ready);
    else expect(hasViewerDeploymentCapability(response.status, text)).toBe(true);
  };
  try {
    process.env.PORT = "19002";
    markStructuredDeliveryControllerUnavailable();
    markStructuredHostStartupFailed();
    await probe(true, 200, false);
    process.env.PORT = "19001";
    expect(GET().status).toBe(503);
    const activated = markHotStateActivationReady(sandbox, publishHotStateAuthority(sandbox, "sqlite", revision));
    markStructuredDeliveryControllerReady();
    // Restore the actual not-yet-started state, including its pending default.
    const state = process as typeof process & {
      __llvStructuredHostStartupFailed?: boolean;
      __llvStructuredHostStartupProgress?: unknown;
    };
    delete state.__llvStructuredHostStartupFailed;
    delete state.__llvStructuredHostStartupProgress;
    await probe(false); // Activation can complete before serving readiness.
    markViewerReleaseReady(sandbox, activated);
    await probe(false); // The incumbent reads releaseReady, ignoring startup.
    markStructuredHostStartupReady();
    await probe(true);
    markStructuredDeliveryControllerUnavailable();
    const now = Date.parse("2026-10-16T00:00:00Z");
    setSystemTime(now);
    const retries: Array<() => void> = [];
    let attempts = 0;
    const failures = [
      { deadline: "startup membership deadline exceeded", hostKey: null },
      { deadline: "structured startup read deadline exceeded", hostKey: "codex:startup-fixture" },
    ];
    await runStructuredHostStartup(async () => {
      const failure = failures[attempts++];
      if (failure) throw Object.assign(new Error(failure.deadline), { code: "ETIMEDOUT", ...failure });
    }, () => {}, { schedule: callback => { retries.push(callback); return {}; }, jitterRatio: 0 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await probe(false);
      const { structuredHostStartup } = await GET().json();
      expect(structuredHostStartup).toMatchObject({ state: "failed", failureCategory: "timeout", ...failures[attempt - 1] });
      const delay = 5_000 * 2 ** (attempt - 1);
      expect(structuredHostStartup.nextRetryAt).toBe(new Date(Date.now() + delay).toISOString());
      setSystemTime(Date.now() + delay);
      retries.shift()!();
      await Promise.resolve();
    }
    expect(attempts).toBe(3);
    expect((await GET().json()).structuredHostStartup).toMatchObject({
      state: "ready", failureCategory: null, deadline: null, hostKey: null, nextRetryAt: null,
    });
    await probe(false); // Controller readiness is still required for promotion.
    markStructuredDeliveryControllerReady();
    await probe(true);
    process.env.LLV_STRUCTURED_HOSTS = "0";
    await probe(true);
  } finally {
    setSystemTime();
    for (const [key, value] of Object.entries({ LLV_STATE_DIR: previous.state, PORT: previous.port, LLV_STRUCTURED_HOSTS: previous.hosts })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    markStructuredHostStartupReady();
    markStructuredDeliveryControllerUnavailable();
  }
});
